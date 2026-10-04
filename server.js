// Desk Radio server (replaces VLC).
//  - Watches macOS Now Playing via `media-control stream`
//  - While music is playing: captures AUDIO_SOURCE (from .env) with ./capture/DeskRadioCapture.app, encodes MP3 with ffmpeg
//  - Serves:  /         -> index.html
//             /stream   -> live MP3 (only while music is playing)
//             /events   -> Server-Sent Events with now-playing info
//             /artwork  -> current track's artwork
// Run: pm2 start ecosystem.config.js   (settings in .env; `pm2 restart desk-radio` after changing them)

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

// Settings live in .env (AUDIO_SOURCE, PORT); restart the app to apply changes.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const PORT = Number(process.env.PORT) || 80;
const AUDIO_SOURCE = process.env.AUDIO_SOURCE || 'EQMOutputExport';
// Apps whose "Now Playing" entry should never count as music (e.g. old VLC capture).
const IGNORED_APPS = new Set(['org.videolan.vlc']);
// Grace period before stopping the stream after music pauses (avoids flapping between tracks).
const STOP_DELAY_MS = 5000;

const CAPTURE_APP = path.join(__dirname, 'capture', 'DeskRadioCapture.app');
const CAPTURE_BIN = path.join(CAPTURE_APP, 'Contents', 'MacOS', 'DeskRadioCapture');
const INDEX_HTML = path.join(__dirname, 'index.html');


// ---------- Now Playing ----------

let raw = {};
let anchor = Date.now(); // server time at which raw.elapsedTime was true
let artwork = null; // { mime, buffer }
let artworkId = null; // content hash: a new image always gets a new URL, even across server restarts
const artworks = new Map(); // content hash -> { mime, buffer }, kept for the history list
const HISTORY_SIZE = 8;
let history = []; // [{ key, title, artist, app, artwork, startedAt }], newest first

function nowPlaying() {
  const ignored = IGNORED_APPS.has(raw.bundleIdentifier);
  const playing = !ignored && !!raw.playing && !!raw.title;
  return {
    playing,
    title: ignored ? '' : raw.title || '',
    artist: ignored ? '' : raw.artist || '',
    album: ignored ? '' : raw.album || '',
    app: ignored ? '' : raw.bundleIdentifier || '',
    duration: raw.duration ?? null,
    // Position right now; clients advance it with their own monotonic clock from the moment it arrives,
    // so viewers' wall clocks never matter.
    elapsed: raw.elapsedTime == null ? null : raw.elapsedTime + (playing ? ((Date.now() - anchor) / 1000) * (raw.playbackRate || 1) : 0),
    rate: raw.playbackRate ?? 1,
    artwork: !ignored && artwork ? `/artwork?v=${artworkId}` : null,
    streaming: !!encoder,
    listeners: listeners.size,
    history: history.map(({ key, ...h }) => h),
  };
}

function updateHistory() {
  const np = nowPlaying();
  if (!np.playing) return;
  const key = `${np.title}\n${np.artist}`;
  if (history[0]?.key !== key) {
    history.unshift({ key, title: np.title, artist: np.artist, app: np.app, artwork: np.artwork, startedAt: Date.now() });
    history = history.slice(0, HISTORY_SIZE);
  } else if (np.artwork) {
    history[0].artwork = np.artwork; // artwork often arrives after the title
  }
  const keep = new Set(history.map((h) => h.artwork));
  for (const v of artworks.keys()) if (!keep.has(`/artwork?v=${v}`) && v !== artworkId) artworks.delete(v);
}

// Every update is the full state (`--no-diff`). media-control drops any update it can't encode (YouTube
// briefly reports an infinite duration while switching videos); with diffs, a dropped title change would
// never be re-sent and the page would stay on the old track.
function applyUpdate(payload) {
  raw = { ...payload };
  // --micros: exact times instead of whole seconds
  raw.duration = payload.durationMicros == null ? null : payload.durationMicros / 1e6;
  raw.elapsedTime = payload.elapsedTimeMicros == null ? null : payload.elapsedTimeMicros / 1e6;
  if (payload.timestampEpochMicros) anchor = payload.timestampEpochMicros / 1000;
  for (const [k, v] of Object.entries(raw)) if (v === null) delete raw[k];

  if (raw.artworkData) {
    const buffer = Buffer.from(raw.artworkData, 'base64');
    if (!artwork || !buffer.equals(artwork.buffer)) {
      artwork = { mime: raw.artworkMimeType || 'image/jpeg', buffer };
      artworkId = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
      artworks.set(artworkId, artwork);
    }
  } else {
    artwork = null;
  }
  delete raw.artworkData;
  updateHistory();
  onStateChange();
}

function watchNowPlaying() {
  const proc = spawn('media-control', ['stream', '--micros', '--no-diff'], { stdio: ['ignore', 'pipe', 'pipe'] });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'data') applyUpdate(msg.payload);
    } catch {}
  });
  proc.stderr.on('data', () => {}); // "Invalid JSON value ... inf" noise; the resync below covers it
  proc.on('exit', (code) => {
    console.error(`media-control exited (${code}), restarting in 2s`);
    setTimeout(watchNowPlaying, 2000);
  });
}

function mediaControlGet(args) {
  return new Promise((resolve) => {
    const proc = spawn('media-control', ['get', '--micros', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('exit', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(undefined); // unreadable right now (e.g. infinite duration); try next round
      }
    });
  });
}

// Safety net: compare with macOS every few seconds and resync if the stream missed something.
async function resyncNowPlaying() {
  const now = await mediaControlGet(['--no-artwork']);
  if (now === undefined) return;
  const same = (now?.contentItemIdentifier ?? null) === (raw.contentItemIdentifier ?? null) &&
    (now?.title ?? null) === (raw.title ?? null) &&
    !!now?.playing === !!raw.playing &&
    (now?.elapsedTimeMicros ?? null) === (raw.elapsedTime == null ? null : Math.round(raw.elapsedTime * 1e6));
  if (same) return;
  const full = await mediaControlGet([]);
  if (full !== undefined) applyUpdate(full || {});
}

// ---------- Audio pipeline ----------

let capture = null;
let encoder = null;
let stopTimer = null;
const listeners = new Set();

function startStream() {
  if (encoder) return;
  console.log('▶ music playing, starting stream');
  encoder = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
     '-c:a', 'libmp3lame', '-b:a', '320k', // highest MP3 quality, no other processing: listeners hear exactly what plays here
      '-f', 'mp3', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  encoder.stdin.on('error', () => {});
  capture = launchCapture(encoder);

  encoder.stdout.on('data', (chunk) => {
    for (const res of listeners) res.write(chunk);
  });

  const enc = encoder;
  enc.on('exit', () => {
    if (encoder === enc) stopStream();
  });
  broadcast();
}

// The capture app is launched through LaunchServices (`open`) rather than as a child process, so macOS
// treats it as its own app and asks once for microphone permission. A child of pm2 would silently get
// silence. It sends PCM back over a one-off localhost socket and quits when that socket closes.
function launchCapture(enc) {
  let socket = null;
  let stopped = false;
  const listener = net.createServer((conn) => {
    listener.close();
    if (stopped) return conn.destroy();
    socket = conn;
    clearTimeout(timeout);
    conn.pipe(enc.stdin);
    conn.on('data', feedLevels);
    conn.on('error', () => {});
    conn.on('close', () => {
      if (!stopped && encoder === enc) {
        console.error('capture app disconnected');
        stopStream();
        setTimeout(onStateChange, 2000); // try again if music is still playing
      }
    });
  });
  let port = null;
  listener.listen(0, '127.0.0.1', () => {
    port = listener.address().port;
    spawn('open', ['-g', '-n', '-a', CAPTURE_APP, '--args', AUDIO_SOURCE, '--connect', String(port)], { stdio: 'ignore' });
  });
  const timeout = setTimeout(() => {
    if (!socket) console.error('capture app did not connect: allow "Desk Radio Capture" in System Settings > Privacy & Security > Microphone, and check the audio source exists');
  }, 15000);
  return {
    kill() {
      stopped = true;
      clearTimeout(timeout);
      listener.close();
      socket?.destroy();
      // The app only notices a closed socket when it next writes, which never happens if the source is
      // silent, so stop it explicitly. Its --connect port identifies this launch.
      if (port) spawn('pkill', ['-f', `DeskRadioCapture .* --connect ${port}$`], { stdio: 'ignore' });
    },
  };
}

function stopStream() {
  if (!encoder) return;
  console.log('■ music stopped, ending stream');
  capture?.kill();
  encoder?.kill();
  capture = encoder = null;
  for (const res of listeners) res.end();
  listeners.clear();
  broadcast();
}

function onStateChange() {
  if (nowPlaying().playing) {
    clearTimeout(stopTimer);
    stopTimer = null;
    startStream();
  } else if (encoder && !stopTimer) {
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (!nowPlaying().playing) stopStream();
    }, STOP_DELAY_MS);
  }
  broadcast();
}

// ---------- HTTP ----------

// ---------- Spectrum for the host page ----------
// The page on this Mac doesn't play the stream (it would echo), so it can't analyse audio itself.
// The server measures the captured PCM instead and sends bar heights, scaled like a Web Audio
// AnalyserNode (0-255, here over -95..-15 dB so loud bass doesn't pin at the top) so the page draws them the same way.

const FFT_SIZE = 4096;
const BARS = 96;
const SAMPLE_RATE = 48000;
const ring = new Float32Array(FFT_SIZE);
let ringPos = 0;
let leftover = Buffer.alloc(0);
let lastAudioAt = 0;
const levelClients = new Set();
const hann = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));

function feedLevels(chunk) {
  if (!levelClients.size) return;
  const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
  const frames = Math.floor(buf.length / 4); // s16le stereo
  for (let i = 0; i < frames; i++) {
    ring[ringPos] = (buf.readInt16LE(i * 4) + buf.readInt16LE(i * 4 + 2)) / 65536;
    ringPos = (ringPos + 1) % FFT_SIZE;
  }
  leftover = buf.subarray(frames * 4);
  lastAudioAt = Date.now();
}

function spectrum() {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) re[i] = ring[(ringPos + i) % FFT_SIZE] * hann[i];
  // In-place iterative radix-2 FFT
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= FFT_SIZE; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < FFT_SIZE; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const bins = FFT_SIZE / 2;
  const bars = new Uint8Array(BARS);
  const lo = Math.log(40);
  const hi = Math.log(16000);
  for (let i = 0; i < BARS; i++) {
    const b0 = Math.floor((Math.exp(lo + ((hi - lo) * i) / BARS) / (SAMPLE_RATE / 2)) * bins);
    const b1 = Math.max(b0 + 1, Math.floor((Math.exp(lo + ((hi - lo) * (i + 1)) / BARS) / (SAMPLE_RATE / 2)) * bins));
    let m = 0;
    for (let b = b0; b < b1; b++) m = Math.max(m, Math.hypot(re[b], im[b]) / FFT_SIZE);
    const db = 20 * Math.log10(m || 1e-12);
    bars[i] = Math.max(0, Math.min(255, Math.round(((db + 95) / 80) * 255)));
  }
  return bars;
}

setInterval(() => {
  if (!levelClients.size) return;
  const fresh = encoder && Date.now() - lastAudioAt < 500;
  const data = fresh ? Buffer.from(spectrum()).toString('base64') : '';
  for (const res of levelClients) res.write(`data: ${data}\n\n`);
}, 40);

const eventClients = new Set();
let lastSent = '';

function broadcast() {
  const data = JSON.stringify(nowPlaying());
  if (data === lastSent) return;
  lastSent = data;
  for (const res of eventClients) res.write(`data: ${data}\n\n`);
}

// Fallback for browsers that ask for /favicon.ico; the page swaps in a live, track-coloured version.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#b9a6ff"/><g fill="#16141c"><rect x="7" y="13" width="4" height="12" rx="2"/><rect x="14" y="7" width="4" height="18" rx="2"/><rect x="21" y="11" width="4" height="14" rx="2"/></g></svg>`;

// Requests from this Mac itself (localhost or any of its own addresses). Listening here would make the
// page Chrome's "Now Playing" (hijacking the metadata) and feed the stream back into the capture.
function isHost(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return Object.values(os.networkInterfaces()).flat().some((i) => i.address === ip);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(INDEX_HTML).pipe(res);
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ host: isHost(req) })}\n\n`);
    res.write(`data: ${JSON.stringify(nowPlaying())}\n\n`);
    eventClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      eventClients.delete(res);
    });
  } else if (url.pathname === '/stream') {
    if (isHost(req)) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      return res.end('This Mac is the source; listen from another device.');
    }
    if (!encoder) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Nothing is playing right now');
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive' });
    listeners.add(res);
    console.log(`+ listener (${listeners.size})`);
    broadcast();
    req.on('close', () => {
      listeners.delete(res);
      console.log(`- listener (${listeners.size})`);
      broadcast();
    });
  } else if (url.pathname === '/levels') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    levelClients.add(res);
    req.on('close', () => levelClients.delete(res));
  } else if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(FAVICON_SVG);
  } else if (url.pathname === '/artwork') {
    const art = artworks.get(url.searchParams.get('v')) || artwork;
    if (!art) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': art.mime, 'Cache-Control': 'no-store' }); // always fetched fresh
    res.end(art.buffer);
  } else {
    res.writeHead(404);
    res.end();
  }
});

if (!fs.existsSync(CAPTURE_BIN)) {
  console.error(`Missing ${CAPTURE_APP}. Build it: ./capture/build.sh`);
  process.exit(1);
}

// Capture apps left over from a previous run (crash, kill -9) would keep recording forever.
// Start watching only after they're gone, so the cleanup can't hit a freshly launched one.
spawn('pkill', ['-f', 'DeskRadioCapture.app/Contents/MacOS/DeskRadioCapture'], { stdio: 'ignore' }).on('exit', () => {
  watchNowPlaying();
  setInterval(resyncNowPlaying, 4000);
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`Listening on http://0.0.0.0:${PORT}, audio source ${AUDIO_SOURCE}`),
);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    capture?.kill();
    encoder?.kill();
    process.exit(0);
  });
}

#!/bin/sh
# Builds the capture helper as a tiny background app, so macOS can grant it microphone access
# (needed to record any audio input, eqMac's included) even when the server runs under pm2.
set -e
cd "$(dirname "$0")"
APP=MusicShareCapture.app
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.music-share.capture</string>
  <key>CFBundleName</key><string>Music Share Capture</string>
  <key>CFBundleExecutable</key><string>MusicShareCapture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Music Share records the selected audio input to stream it to your colleagues.</string>
  <key>NSAudioCaptureUsageDescription</key><string>Music Share records what your Mac plays to stream it to your colleagues.</string>
</dict>
</plist>
PLIST
swiftc -O capture.swift -o "$APP/Contents/MacOS/MusicShareCapture"
codesign --force --sign - "$APP"
echo "built $(pwd)/$APP"

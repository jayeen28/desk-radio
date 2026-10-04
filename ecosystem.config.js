module.exports = {
  apps: [
    {
      name: 'music-share',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 2000,
      env: {
        // media-control and ffmpeg live in Homebrew
        PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH}`,
      },
    },
  ],
};

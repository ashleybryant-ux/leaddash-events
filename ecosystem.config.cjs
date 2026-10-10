// PM2 process file. Started once with: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "leaddash-events",
      script: "dist/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
      time: true,
    },
  ],
};

// pm2 config: keeps the bot running in the background and restarts it after a crash.
// Usage: npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 logs realty-monitoring
module.exports = {
  apps: [{
    name: "realty-monitoring",
    script: "node_modules/tsx/dist/cli.mjs",
    args: "src/index.ts",
    interpreter: "node",
    autorestart: true,
    restart_delay: 10_000,
    env: { LOG_FORMAT: "json" }
  }]
};

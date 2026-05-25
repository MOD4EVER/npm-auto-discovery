// pm2.sea.config.cjs — PM2 deployment using the self-contained SEA binary
// Build first: npm run build:sea
// IMPORTANT: Must be .cjs extension (project uses "type": "module" in package.json)
const { join } = require('path');

module.exports = {
  apps: [
    {
      name: 'npm-auto-discovery',
      script: join(__dirname, 'npm-auto-discovery'),
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      max_memory_restart: '256M',
      // Env vars are sourced from .env by the pm2:start npm script (set -a && . .env).
      // To override individual vars without touching .env, add them to the env block below.
      env: {
        NODE_ENV: 'production',
        // NPM_URL: 'http://your-npm-host:81',
        // NPM_EMAIL: 'admin@example.com',
        // NPM_PASSWORD: 'yourpassword',
        // RECONCILE_INTERVAL_MS: '300000',
        // FORWARD_HOST_MODE: 'auto',
        // PROXY_NETWORK_NAME: 'proxy-network',
        // NPM_MAX_RETRIES: '3',
        // HEALTH_PORT: '8080',
      },
    },
  ],
};

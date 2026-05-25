// pm2.node.config.cjs — PM2 deployment using Node.js runtime + dist/main.cjs
// Build first: npm run build
// IMPORTANT: Must be .cjs extension (project uses "type": "module" in package.json)
const { join } = require('path');

module.exports = {
  apps: [
    {
      name: 'npm-auto-discovery',
      script: join(__dirname, 'dist/main.cjs'),
      node_args: `--env-file=${join(__dirname, '.env')}`,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        // Required — must be set in environment or .env file
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

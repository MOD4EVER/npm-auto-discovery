import { VERSION } from './version.js';

function printHelp(): void {
  console.log(`Usage: npm-auto-discovery [options]

Automatically discovers Docker containers and creates Nginx Proxy Manager proxy hosts.

Options:
  -v, --version    Print version and exit
  -h, --help       Print this help and exit

Required environment variables:
  NPM_URL                 Base URL of Nginx Proxy Manager API (e.g. http://npm:81)
  NPM_EMAIL               NPM admin account email
  NPM_PASSWORD            NPM admin account password

Optional environment variables:
  NPM_CREDENTIALS_FILE    Path to a file containing NPM_EMAIL and NPM_PASSWORD (KEY=VALUE format)
  RECONCILE_INTERVAL_MS   Self-healing reconcile interval in milliseconds   (default: 300000)
  FORWARD_HOST_MODE       Container hostname resolution: auto|dns|ip         (default: auto)
  PROXY_NETWORK_NAME      Docker network name                                (default: proxy-network)
  NPM_MAX_RETRIES         NPM API retry attempts with exponential backoff    (default: 3)
  HEALTH_PORT             Port for the /health endpoint                      (default: 8080)
  LOG_LEVEL               Pino log level trace|debug|info|warn|error|fatal   (default: info)`);
}

export function checkCliFlags(argv: string[]): boolean {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return true;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return true;
  }
  return false;
}

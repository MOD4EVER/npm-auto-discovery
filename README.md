# npm-auto-discovery

[![CI](https://github.com/mod4ever/npm-auto-discovery/actions/workflows/ci.yml/badge.svg)](https://github.com/mod4ever/npm-auto-discovery/actions)

Automatically discovers Docker containers and creates Nginx Proxy Manager proxy hosts.

## How It Works

npm-auto-discovery monitors the Docker event stream for container `start` events, reads `VIRTUAL_HOST` environment variables from running containers, and automatically calls the NPM API to create or update proxy hosts. A periodic self-healing reconcile loop (default: every 5 minutes) ensures state consistency after NPM downtime or missed Docker events — without any manual intervention.

## Quickstart

**1. Clone the repository or copy the `docker-compose.yml`:**

```yaml
services:
  npm-auto-discovery:
    image: ghcr.io/mod4ever/npm-auto-discovery:latest
    restart: unless-stopped
    env_file: .env
    group_add:
      - "${DOCKER_GID:-996}"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - proxy-network
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:${HEALTH_PORT:-8080}/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  proxy-network:
    external: true
    name: ${PROXY_NETWORK_NAME:-proxy-network}
```

**2. Create a `.env` file with the 3 required variables:**

```env
NPM_URL=http://your-npm-host:81
NPM_EMAIL=admin@example.com
NPM_PASSWORD=yourpassword
```

Copy the full template: `cp .env.example .env`

**3. Start the service:**

```bash
docker compose up -d
```

## Container Configuration

Add these environment variables to any container you want proxied through NPM:

```yaml
services:
  myapp:
    image: myapp:latest
    environment:
      VIRTUAL_HOST: "myapp.example.com"     # Required — triggers proxy host creation
      VIRTUAL_PORT: "8080"                   # Optional — default: 80
      VIRTUAL_SSL_CERT_ID: "42"              # Optional — use existing NPM cert by ID
    networks:
      - proxy-network  # Must be on the same network as npm-auto-discovery
```

| Variable | Required | Description |
|---|---|---|
| `VIRTUAL_HOST` | **YES** | Comma-separated domain(s) to proxy (e.g., `app.example.com,www.app.example.com`). A scheme, path or port (`https://app.example.com/`) is stripped |
| `VIRTUAL_PORT` | no | Container port to forward traffic to (default: `80`) |
| `VIRTUAL_SSL_CERT_ID` | no | ID of an existing NPM SSL certificate to attach |
| `FORWARD_HOST_MODE` | no | Per-container override of the global `FORWARD_HOST_MODE` setting (`auto`\|`dns`\|`ip`) |

## Environment Variables

| Variable | Type | Required | Default | Description |
|---|---|---|---|---|
| `NPM_URL` | URL | **YES** | — | Base URL of Nginx Proxy Manager API (e.g., `http://npm:81`) |
| `NPM_EMAIL` | string (email) | **YES** | — | NPM admin account email |
| `NPM_PASSWORD` | string | **YES** | — | NPM admin account password |
| `NPM_CREDENTIALS_FILE` | path | no | — | Path to Docker secret file with `NPM_EMAIL` and `NPM_PASSWORD` (KEY=VALUE format) |
| `RECONCILE_INTERVAL_MS` | number (ms) | no | `300000` | How often the reconcile loop runs (5 min) |
| `FORWARD_HOST_MODE` | `auto`\|`dns`\|`ip` | no | `auto` | Container hostname resolution: `auto`=DNS-first+IP-fallback, `dns`=DNS only, `ip`=IP only |
| `PROXY_NETWORK_NAME` | string | no | `proxy-network` | Docker network name shared between this service, NPM, and managed containers |
| `NPM_MAX_RETRIES` | number | no | `3` | Maximum NPM API retry attempts with exponential backoff |
| `HEALTH_PORT` | number (port) | no | `8080` | Port for the `/health` endpoint |
| `HOST_NETWORK_FORWARD_HOST` | string | no | — | Address NPM forwards to for containers with `network_mode: host` (e.g. the proxy network gateway or the server's public IP); such containers fail with `CONTAINER_NO_IP` while unset |
| `LOG_LEVEL` | string | no | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |

## CLI Options

When running the binary directly (SEA or PM2), these flags are available:

| Flag | Description |
|---|---|
| `-v`, `--version` | Print version and exit |
| `-h`, `--help` | Print version, all environment variables with defaults, and exit |

```bash
./npm-auto-discovery --version   # e.g. 1.0.0
./npm-auto-discovery --help
```

## Network Requirements

npm-auto-discovery must share a Docker network with both NPM and all managed containers. This allows the service to:

1. Call the NPM API (requires network connectivity to NPM)
2. Resolve container hostnames or IPs for proxy forwarding

The `PROXY_NETWORK_NAME` variable (default: `proxy-network`) must match the Docker network name configured in NPM and used by your managed containers.

**Typical setup:**

```yaml
networks:
  proxy-network:
    external: true
    name: proxy-network
```

All three services — NPM, npm-auto-discovery, and your managed containers — must be connected to this network.

## Troubleshooting

All errors are logged as structured JSON with an `error_code` field.

```bash
# Docker
docker logs npm-auto-discovery | grep error_code

# PM2
npm run pm2:logs -- --lines 500 | grep error_code
# or search the raw log file
grep error_code /root/.pm2/logs/npm-auto-discovery-out-0.log
```

| Error Code | Trigger Condition | Operator Resolution |
|---|---|---|
| `NPM_UNREACHABLE` | NPM API cannot be reached (network error, NPM down) | Check `NPM_URL` value; verify npm-auto-discovery and NPM are on the same Docker network; check NPM is running |
| `NPM_AUTH_FAILED` | NPM API returns 401 on authentication | Verify `NPM_EMAIL` and `NPM_PASSWORD` are correct; check NPM user account is active |
| `NPM_API_ERROR` | NPM API returned unexpected response or HTTP 5xx | Check NPM logs for errors; verify NPM version is 2.10.x+; check `NPM_MAX_RETRIES` |
| `CERT_RATE_LIMIT` | Let's Encrypt rate limit hit — too many certificate requests for this domain | Wait 1 hour before retrying (failed-validation rate limit is 5/hour per hostname); use `VIRTUAL_SSL_CERT_ID` to assign an existing certificate instead |
| `CERT_FAILED` | Let's Encrypt certificate request failed (DNS, port 80 challenge) | Verify domain is publicly accessible; check port 80 is open for ACME challenge; verify DNS propagation |
| `DOCKER_SOCKET_ERROR` | Docker daemon socket unavailable or permission denied | Verify `/var/run/docker.sock` is mounted read-only in the container; check Docker daemon is running |
| `CONTAINER_NO_IP` | Cannot determine container's forward host via DNS or IP | Ensure container and npm-auto-discovery are on the same Docker network (`PROXY_NETWORK_NAME`); check `FORWARD_HOST_MODE` |
| `PROXY_HOST_EXISTS` | A proxy host already exists for the domain with matching configuration (informational) | Not an error — logged as `result: "skipped"` when startup scan or reconcile finds an existing proxy host that is already up-to-date |
| `CONFIG_VALIDATION_ERROR` | A required environment variable is missing or invalid at startup | Check the value reported in the log's `field` key; verify all required variables (`NPM_URL`, `NPM_EMAIL`, `NPM_PASSWORD`) are set and valid |

## Compatibility

- **Nginx Proxy Manager:** `jc21/nginx-proxy-manager` 2.10.x+
- **Docker Engine API:** v1.41+ (Docker 20.10+)
- **Node.js:** 24 LTS

## PM2 Deployment

For non-Docker environments, deploy using PM2. Two variants are available:

### SEA Binary (default — no Node.js runtime on PATH required)

```bash
# Install PM2 globally
npm install -g pm2

# Install dependencies, then build the self-contained binary
npm install
npm run build:sea

# Configure credentials in .env (copy from template)
cp .env.example .env
# Edit .env: set NPM_URL, NPM_EMAIL, NPM_PASSWORD

# Start with PM2 (uses pm2.sea.config.cjs)
npm run pm2:start

# Save process list for auto-restart on reboot
npm run pm2:save
pm2 startup   # generates the system startup command — run the printed command as root
```

**Typical update workflow:**

```bash
npm run build:sea && npm run pm2:restart
```

### Node.js Runtime (alternative — requires Node.js 24 on PATH)

```bash
npm install
npm run build
npm run pm2:start:node
```

**Typical update workflow:**

```bash
npm run build && npm run pm2:restart
```

### PM2 Scripts

| Script | Description |
|---|---|
| `npm run pm2:start` | Start via SEA binary (`pm2.sea.config.cjs`) — default |
| `npm run pm2:start:node` | Start via Node.js runtime (`pm2.node.config.cjs`) |
| `npm run pm2:stop` | Stop the service |
| `npm run pm2:restart` | Restart (works for both variants) |
| `npm run pm2:status` | Show status, uptime, and memory |
| `npm run pm2:logs` | Live log tail with human-readable output |
| `npm run pm2:save` | Persist process list across reboots |

**SEA variant** (`pm2:start`): `pm2:start` sources `.env` into the shell before starting PM2 (`set -a && . ./.env`), so PM2 inherits and passes all vars to the binary. `.env` must exist.

**Node.js variant** (`pm2:start:node`): env vars are loaded via Node.js `--env-file` in `node_args` (see `pm2.node.config.cjs`).

Both variants also accept vars set directly in the `env` block of their config file.

## Node.js 24 SEA Binary

Build a self-contained binary with no Node.js runtime requirement (Linux):

```bash
# Step 1: Build CJS bundle
npm run build

# Step 2: Generate SEA preparation blob
# Requires dist/main.cjs from Step 1 — run npm run build first if skipping Step 1
node --experimental-sea-config sea-config.json

# Step 3: Copy the node binary
cp $(which node) npm-auto-discovery

# Step 4: Inject the blob into the binary
npx postject npm-auto-discovery NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Step 5: Run the binary
NPM_URL=http://npm:81 NPM_EMAIL=admin@example.com NPM_PASSWORD=pass \
  ./npm-auto-discovery
```

For macOS, additional codesign steps are required. See [Node.js 24 SEA documentation](https://nodejs.org/api/single-executable-applications.html) for platform-specific instructions.

Or run all steps at once:

```bash
npm run build:sea
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (hot-reload via tsx)
npm run dev

# Run tests with coverage
npm test

# Build production bundle
npm run build

# Type-check + lint
npm run check
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full history of changes.

## License

[AGPL-3.0-only](LICENSE)

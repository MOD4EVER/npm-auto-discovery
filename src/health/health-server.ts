import http from 'node:http';
import type net from 'node:net';
import type { Config } from '../types/config.js';
import type { DockerClient } from '../types/docker.js';
import type { NPMApiClient } from '../types/npm-api.js';
import { VERSION } from '../version.js';

interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime_seconds: number;
  npm_reachable: boolean;
  docker_reachable: boolean;
  reason?: string;
}

export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private readonly config: Config,
    private readonly npm: NPMApiClient,
    private readonly docker: DockerClient,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => void this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.config.HEALTH_PORT, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  address(): net.AddressInfo | string | null {
    return this.server?.address() ?? null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }

    const [npmResult, dockerResult] = await Promise.allSettled([
      this.checkNpm(),
      this.checkDocker(),
    ]);

    const npmReachable = npmResult.status === 'fulfilled';
    const dockerReachable = dockerResult.status === 'fulfilled';
    const allOk = npmReachable && dockerReachable;

    const body: HealthResponse = {
      status: allOk ? 'ok' : 'degraded',
      version: VERSION,
      uptime_seconds: Math.floor(process.uptime()),
      npm_reachable: npmReachable,
      docker_reachable: dockerReachable,
    };

    if (!allOk) {
      body.reason = !npmReachable ? 'NPM unreachable' : 'Docker unreachable';
    }

    res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async checkNpm(): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('NPM health check timeout')), 3_000),
    );
    await Promise.race([this.npm.getProxyHosts(), timeout]);
  }

  private async checkDocker(): Promise<void> {
    await this.docker.listContainers();
  }
}

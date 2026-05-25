import http from 'node:http';
import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/version.js', () => ({ VERSION: '1.0.0-test' }));

import { HealthServer } from '../../../src/health/health-server.js';
import type { Config } from '../../../src/types/config.js';
import type { DockerClient } from '../../../src/types/docker.js';
import type { NPMApiClient } from '../../../src/types/npm-api.js';

const mockConfig: Config = {
  NPM_URL: 'http://npm:81',
  NPM_EMAIL: 'admin@example.com',
  NPM_PASSWORD: 'secret',
  RECONCILE_INTERVAL_MS: 300_000,
  FORWARD_HOST_MODE: 'auto',
  PROXY_NETWORK_NAME: 'proxy-network',
  NPM_MAX_RETRIES: 3,
  HEALTH_PORT: 0, // OS-assigned port
};

function makeNpmMock(fails = false): NPMApiClient {
  return {
    getProxyHosts: vi
      .fn()
      .mockImplementation(() =>
        fails ? Promise.reject(new Error('NPM unreachable')) : Promise.resolve([]),
      ),
    getCertificates: vi.fn().mockResolvedValue([]),
  } as unknown as NPMApiClient;
}

function makeDockerMock(fails = false): DockerClient {
  return {
    listContainers: vi
      .fn()
      .mockImplementation(() =>
        fails ? Promise.reject(new Error('Docker unreachable')) : Promise.resolve([]),
      ),
  } as unknown as DockerClient;
}

async function getHealth(
  server: HealthServer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const addr = server.address() as net.AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${addr.port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(data) as Record<string, unknown>,
          });
        });
      })
      .on('error', reject);
  });
}

async function get404(server: HealthServer): Promise<number> {
  const addr = server.address() as net.AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${addr.port}/other`, (res) => {
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

describe('HealthServer — happy path', () => {
  let server: HealthServer;

  beforeEach(async () => {
    server = new HealthServer(mockConfig, makeNpmMock(), makeDockerMock());
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns HTTP 200 when both NPM and Docker are reachable', async () => {
    const { status, body } = await getHealth(server);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.npm_reachable).toBe(true);
    expect(body.docker_reachable).toBe(true);
  });

  it('includes version, uptime_seconds in response', async () => {
    const { body } = await getHealth(server);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_seconds).toBe('number');
  });

  it('version matches semver pattern', async () => {
    const { body } = await getHealth(server);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns 404 for non-health paths', async () => {
    const status = await get404(server);
    expect(status).toBe(404);
  });

  it('uses port from config', () => {
    const addr = server.address() as net.AddressInfo;
    expect(typeof addr.port).toBe('number');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('address() returns null before start', () => {
    const unstarted = new HealthServer(mockConfig, makeNpmMock(), makeDockerMock());
    expect(unstarted.address()).toBeNull();
  });
});

describe('HealthServer — NPM unreachable', () => {
  let server: HealthServer;

  beforeEach(async () => {
    server = new HealthServer(mockConfig, makeNpmMock(true), makeDockerMock());
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns HTTP 503 when NPM is unreachable', async () => {
    const { status, body } = await getHealth(server);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.npm_reachable).toBe(false);
    expect(body.docker_reachable).toBe(true);
    expect(body.reason).toBe('NPM unreachable');
  });
});

describe('HealthServer — Docker unreachable', () => {
  let server: HealthServer;

  beforeEach(async () => {
    server = new HealthServer(mockConfig, makeNpmMock(), makeDockerMock(true));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns HTTP 503 when Docker is unreachable', async () => {
    const { status, body } = await getHealth(server);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.docker_reachable).toBe(false);
    expect(body.npm_reachable).toBe(true);
    expect(body.reason).toBe('Docker unreachable');
  });
});

describe('HealthServer — stop()', () => {
  it('resolves when called on an unstarted server', async () => {
    const server = new HealthServer(mockConfig, makeNpmMock(), makeDockerMock());
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe('HealthServer — no Express dependency', () => {
  it('health-server.ts does not import express', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync(
      new URL('../../../src/health/health-server.ts', import.meta.url),
      'utf-8',
    );
    expect(content).not.toContain('express');
  });
});

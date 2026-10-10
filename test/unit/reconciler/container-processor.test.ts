import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerProcessor } from '../../../src/reconciler/container-processor.js';
import type { Config } from '../../../src/types/config.js';
import type { ContainerInspect } from '../../../src/types/docker.js';
import { CertError, ErrorCode } from '../../../src/types/errors.js';
import type { NPMApiClient, ProxyHost } from '../../../src/types/npm-api.js';

vi.mock('../../../src/reconciler/parse-container-config.js', () => ({
  parseContainerConfig: vi.fn(),
}));
vi.mock('../../../src/reconciler/hostname-resolver.js', () => ({
  resolveForwardHost: vi.fn(),
}));
vi.mock('../../../src/npm-api/certificates.js', () => ({
  resolveCertificate: vi.fn(),
}));

import { resolveCertificate } from '../../../src/npm-api/certificates.js';
import { resolveForwardHost } from '../../../src/reconciler/hostname-resolver.js';
import { parseContainerConfig } from '../../../src/reconciler/parse-container-config.js';

const mockConfig: Config = {
  NPM_URL: 'http://npm:81',
  NPM_EMAIL: 'admin@example.com',
  NPM_PASSWORD: 'secret',
  RECONCILE_INTERVAL_MS: 300_000,
  FORWARD_HOST_MODE: 'auto',
  PROXY_NETWORK_NAME: 'proxy-network',
  NPM_MAX_RETRIES: 3,
  HEALTH_PORT: 8080,
};

function makeProxyHost(id: number, domain_names: string[]): ProxyHost {
  return {
    id,
    domain_names,
    forward_host: '10.0.0.1',
    forward_port: 80,
    forward_scheme: 'http',
    ssl_forced: false,
    certificate_id: null,
    advanced_config: '',
    access_list_id: 0,
    hsts_enabled: false,
    hsts_subdomains: false,
    http2_support: false,
    block_exploits: true,
    caching_enabled: false,
    allow_websocket_upgrade: false,
    meta: {},
  };
}

function makeNpmClient(existingHosts: ProxyHost[] = []): NPMApiClient {
  return {
    getProxyHosts: vi.fn().mockResolvedValue(existingHosts),
    getProxyHostById: vi.fn(),
    createProxyHost: vi.fn().mockResolvedValue(makeProxyHost(99, ['app.example.com'])),
    updateProxyHost: vi.fn().mockResolvedValue(makeProxyHost(1, ['app.example.com'])),
    deleteProxyHost: vi.fn(),
    getCertificates: vi.fn().mockResolvedValue([]),
    createCertificate: vi.fn(),
  } as unknown as NPMApiClient;
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

function makeContainer(name = '/my-app', id = 'abc123'): ContainerInspect {
  return {
    Id: id,
    Name: name,
    Config: { Env: ['VIRTUAL_HOST=app.example.com'] },
    NetworkSettings: { Networks: { 'proxy-network': { IPAddress: '172.20.0.5' } } },
  };
}

describe('ContainerProcessor.process() — create path (AC: 1, 5)', () => {
  beforeEach(() => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 3000,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('172.20.0.5');
    vi.mocked(resolveCertificate).mockResolvedValue(42);
  });

  it('calls createProxyHost with correct full payload and returns "created"', async () => {
    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('created');
    expect(npmClient.createProxyHost).toHaveBeenCalledWith({
      domain_names: ['app.example.com'],
      forward_host: '172.20.0.5',
      forward_port: 3000,
      forward_scheme: 'http',
      certificate_id: 42,
      ssl_forced: true,
      allow_websocket_upgrade: true,
      block_exploits: true,
    });
    expect(npmClient.updateProxyHost).not.toHaveBeenCalled();
  });

  it('logs proxy_host_created with trigger, container_id, domain, duration_ms', async () => {
    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    await processor.process(makeContainer('/my-app', 'cid123'), 'startup');

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host_created',
        container_id: 'cid123',
        container_name: 'my-app',
        domain: 'app.example.com',
        trigger: 'startup',
        result: 'created',
        duration_ms: expect.any(Number),
      }),
    );
  });

  it('uses PROXY_NETWORK_NAME from config when calling resolveForwardHost', async () => {
    const npmClient = makeNpmClient([]);
    const processor = new ContainerProcessor(mockConfig, npmClient, makeLogger());
    await processor.process(makeContainer(), 'event');
    expect(resolveForwardHost).toHaveBeenCalledWith(
      expect.any(Object),
      'auto',
      'proxy-network',
      undefined,
    );
  });

  it('passes HOST_NETWORK_FORWARD_HOST from config to resolveForwardHost', async () => {
    const npmClient = makeNpmClient([]);
    const processor = new ContainerProcessor(
      { ...mockConfig, HOST_NETWORK_FORWARD_HOST: '172.18.0.1' },
      npmClient,
      makeLogger(),
    );
    await processor.process(makeContainer(), 'event');
    expect(resolveForwardHost).toHaveBeenCalledWith(
      expect.any(Object),
      'auto',
      'proxy-network',
      '172.18.0.1',
    );
  });
});

describe('ContainerProcessor.process() — update path (AC: 2)', () => {
  beforeEach(() => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 8080,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('172.20.0.5');
  });

  it('calls updateProxyHost with only forward_host and forward_port patch and returns "updated"', async () => {
    const existing = makeProxyHost(7, ['app.example.com']);
    const npmClient = makeNpmClient([existing]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('updated');
    expect(npmClient.updateProxyHost).toHaveBeenCalledWith(7, {
      forward_host: '172.20.0.5',
      forward_port: 8080,
    });
    expect(npmClient.createProxyHost).not.toHaveBeenCalled();
  });

  it('logs proxy_host_updated with trigger and domain', async () => {
    const existing = makeProxyHost(7, ['app.example.com']);
    const npmClient = makeNpmClient([existing]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    await processor.process(makeContainer('/svc', 'xyz'), 'reconcile');

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host_updated',
        container_id: 'xyz',
        trigger: 'reconcile',
        result: 'updated',
      }),
    );
  });
});

describe('ContainerProcessor.process() — multi-domain with Promise.allSettled (AC: 3)', () => {
  it('processes both domains; a failure on one does not prevent the other', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['a.example.com', 'b.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('172.20.0.5');
    vi.mocked(resolveCertificate)
      .mockRejectedValueOnce(new CertError('rate limited', ErrorCode.CERT_RATE_LIMIT))
      .mockResolvedValueOnce(5);

    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    // b.example.com succeeded
    expect(npmClient.createProxyHost).toHaveBeenCalledTimes(1);
    expect(npmClient.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ domain_names: ['b.example.com'] }),
    );
    // result is 'created' because one domain succeeded
    expect(result).toBe('created');
  });
});

describe('ContainerProcessor.process() — rate-limit error handling (AC: 4)', () => {
  it('logs warn with CERT_RATE_LIMIT error_code and domain; does not throw', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('172.20.0.5');
    vi.mocked(resolveCertificate).mockRejectedValue(
      new CertError('rate limited', ErrorCode.CERT_RATE_LIMIT),
    );

    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'domain_failed',
        error_code: ErrorCode.CERT_RATE_LIMIT,
        domain: 'app.example.com',
      }),
    );
  });
});

describe('ContainerProcessor.process() — no config (AC: 1)', () => {
  it('returns "skipped" when container has no VIRTUAL_HOST', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const npmClient = makeNpmClient([]);
    const processor = new ContainerProcessor(mockConfig, npmClient, makeLogger());
    const result = await processor.process(makeContainer(), 'event');
    expect(result).toBe('skipped');
    expect(npmClient.getProxyHosts).not.toHaveBeenCalled();
  });
});

describe('ContainerProcessor.process() — branch coverage (certId=null, non-AppError, non-Error)', () => {
  it('creates proxy host with certificate_id:null and ssl_forced:false when certId is null', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('172.20.0.5');
    vi.mocked(resolveCertificate).mockResolvedValue(null as unknown as number);

    const npmClient = makeNpmClient([]);
    const processor = new ContainerProcessor(mockConfig, npmClient, makeLogger());
    await processor.process(makeContainer(), 'event');

    expect(npmClient.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ certificate_id: null, ssl_forced: false }),
    );
  });

  it('logs UNKNOWN_ERROR when a non-AppError error is thrown', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockRejectedValue(new Error('generic error'));

    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'UNKNOWN_ERROR' }));
  });

  it('handles non-Error thrown values (string) with String(err) in message', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockRejectedValue('string error');

    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'string error', stack: undefined }),
      }),
    );
  });

  it('handles rejected processDomain (log.warn throws) via allSettled ternary false branch', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockRejectedValue(new Error('resolve failed'));

    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    vi.mocked(log.warn).mockImplementation(() => {
      throw new Error('logger crashed');
    });
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'event');
    expect(result).toBe('failed');
  });
});

describe('ContainerProcessor.process() — PROXY_HOST_EXISTS skipped path', () => {
  beforeEach(() => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    vi.mocked(resolveForwardHost).mockResolvedValue('10.0.0.1');
  });

  it('returns "skipped" and logs proxy_host_exists when forward_host and port already match', async () => {
    const existing = makeProxyHost(7, ['app.example.com']);
    // existing has forward_host: '10.0.0.1', forward_port: 80 — matches mock above
    const npmClient = makeNpmClient([existing]);
    const log = makeLogger();
    const processor = new ContainerProcessor(mockConfig, npmClient, log);
    const result = await processor.process(makeContainer(), 'startup');

    expect(result).toBe('skipped');
    expect(npmClient.updateProxyHost).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host_exists',
        domain: 'app.example.com',
        trigger: 'startup',
        result: 'skipped',
        error_code: 'PROXY_HOST_EXISTS',
      }),
    );
  });

  it('still updates when only forward_port differs', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 9090,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    const existing = makeProxyHost(7, ['app.example.com']); // port 80
    const npmClient = makeNpmClient([existing]);
    const processor = new ContainerProcessor(mockConfig, npmClient, makeLogger());
    const result = await processor.process(makeContainer(), 'event');

    expect(result).toBe('updated');
    expect(npmClient.updateProxyHost).toHaveBeenCalled();
  });

  it('process() returns "skipped" when all domains are already up-to-date', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['a.example.com', 'b.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    const existingA = makeProxyHost(1, ['a.example.com']); // forward_host: 10.0.0.1, port: 80
    const existingB = makeProxyHost(2, ['b.example.com']); // same
    const npmClient = makeNpmClient([existingA, existingB]);
    const processor = new ContainerProcessor(mockConfig, npmClient, makeLogger());
    const result = await processor.process(makeContainer(), 'reconcile');

    expect(result).toBe('skipped');
    expect(npmClient.updateProxyHost).not.toHaveBeenCalled();
  });
});

describe('ContainerProcessor — DI constructor (AC: 5)', () => {
  it('accepts injected mocks without instantiating concrete classes internally', () => {
    const npmClient = makeNpmClient([]);
    const log = makeLogger();
    expect(() => new ContainerProcessor(mockConfig, npmClient, log)).not.toThrow();
  });
});

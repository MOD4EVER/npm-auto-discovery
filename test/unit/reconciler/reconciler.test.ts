import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerProcessor } from '../../../src/reconciler/container-processor.js';
import { Reconciler } from '../../../src/reconciler/reconciler.js';
import type { Config } from '../../../src/types/config.js';
import type {
  ContainerInfo,
  ContainerInspect,
  DockerClient,
  DockerEvent,
} from '../../../src/types/docker.js';
import { ErrorCode, NPMApiError } from '../../../src/types/errors.js';
import type { NPMApiClient, ProxyHost } from '../../../src/types/npm-api.js';

vi.mock('../../../src/reconciler/parse-container-config.js', () => ({
  parseContainerConfig: vi.fn(),
}));

vi.mock('../../../src/reconciler/diff.js', () => ({
  diffState: vi.fn().mockReturnValue([]),
}));

import { diffState } from '../../../src/reconciler/diff.js';
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

function makeContainerInfo(id: string): ContainerInfo {
  return { Id: id, Names: [`/${id}`] };
}

function makeContainerInspect(id: string): ContainerInspect {
  return {
    Id: id,
    Name: `/${id}`,
    Config: { Env: [`VIRTUAL_HOST=${id}.example.com`] },
    NetworkSettings: { Networks: {} },
  };
}

function makeProxyHost(id: number, ...domains: string[]): ProxyHost {
  return {
    id,
    domain_names: domains,
    forward_host: '127.0.0.1',
    forward_port: 80,
    forward_scheme: 'http',
    ssl_forced: false,
    certificate_id: null,
    advanced_config: '',
    access_list_id: 0,
    hsts_enabled: false,
    hsts_subdomains: false,
    http2_support: false,
    block_exploits: false,
    caching_enabled: false,
    allow_websocket_upgrade: false,
    meta: {},
  };
}

function makeDockerClient(
  containers: ContainerInfo[] = [],
  inspectFn?: (id: string) => Promise<ContainerInspect>,
): DockerClient {
  return {
    listContainers: vi.fn().mockResolvedValue(containers),
    inspectContainer: vi
      .fn()
      .mockImplementation(inspectFn ?? ((id: string) => Promise.resolve(makeContainerInspect(id)))),
    getEventStream: vi.fn().mockResolvedValue(new EventEmitter()),
  } as unknown as DockerClient;
}

function makeContainerProcessor(): ContainerProcessor {
  return {
    process: vi.fn().mockResolvedValue('created'),
  } as unknown as ContainerProcessor;
}

function makeNpmClient(): NPMApiClient {
  return {
    getProxyHosts: vi.fn().mockResolvedValue([]),
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
    // biome-ignore lint/suspicious/noExplicitAny: logger mock
  } as any;
}

function makeReconciler(
  overrides: {
    docker?: DockerClient;
    processor?: ContainerProcessor;
    log?: Logger;
    npm?: NPMApiClient;
    config?: Config;
  } = {},
): {
  reconciler: Reconciler;
  docker: DockerClient;
  processor: ContainerProcessor;
  log: Logger;
  npm: NPMApiClient;
} {
  const docker = overrides.docker ?? makeDockerClient();
  const processor = overrides.processor ?? makeContainerProcessor();
  const log = overrides.log ?? makeLogger();
  const npm = overrides.npm ?? makeNpmClient();
  const config = overrides.config ?? mockConfig;
  return {
    reconciler: new Reconciler(config, docker, npm, processor, log),
    docker,
    processor,
    log,
    npm,
  };
}

describe('Reconciler.runStartupScan() — startup_complete log (AC: 1)', () => {
  it('logs startup_complete with correct counters for 3 containers (2 managed, 1 without)', async () => {
    vi.mocked(parseContainerConfig)
      .mockReturnValueOnce({
        domains: ['a.example.com'],
        port: 80,
        forwardHostMode: 'auto',
        sslCertId: undefined,
      })
      .mockReturnValueOnce({
        domains: ['b.example.com'],
        port: 80,
        forwardHostMode: 'auto',
        sslCertId: undefined,
      })
      .mockReturnValueOnce(null); // third container: no VIRTUAL_HOST

    const docker = makeDockerClient([
      makeContainerInfo('c1'),
      makeContainerInfo('c2'),
      makeContainerInfo('c3'),
    ]);
    const processor = makeContainerProcessor();
    vi.mocked(processor.process).mockResolvedValueOnce('created').mockResolvedValueOnce('updated');

    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.runStartupScan();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'startup_complete',
        containers_found: 3,
        containers_managed: 2,
        proxy_hosts_created: 1,
        proxy_hosts_updated: 1,
      }),
    );
  });

  it('startup_complete uses snake_case field names', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.runStartupScan();

    const call = vi
      .mocked(log.info)
      .mock.calls.find((c) => (c[0] as Record<string, unknown>).action === 'startup_complete');
    expect(call).toBeDefined();
    const fields = Object.keys((call?.[0] ?? {}) as Record<string, unknown>);
    for (const f of fields) {
      expect(f).not.toMatch(/[A-Z]/);
    }
  });

  it('still emits startup_complete even when one container fails', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    const docker = makeDockerClient([makeContainerInfo('c1'), makeContainerInfo('c2')]);
    vi.mocked(docker.inspectContainer)
      .mockResolvedValueOnce(makeContainerInspect('c1'))
      .mockRejectedValueOnce(new Error('docker inspect failed'));

    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.runStartupScan();

    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ action: 'startup_complete' }));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'startup_container_error' }),
      expect.any(String),
    );
  });

  it('counts "skipped" result in managed but not in created/updated', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    const processor = makeContainerProcessor();
    vi.mocked(processor.process).mockResolvedValue('skipped');

    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.runStartupScan();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'startup_complete',
        containers_managed: 1,
        proxy_hosts_created: 0,
        proxy_hosts_updated: 0,
      }),
    );
  });
});

describe('Reconciler.startEventStream() — event handling (AC: 4)', () => {
  it('calls containerProcessor.process with trigger "event" on start event', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);
    vi.mocked(docker.inspectContainer).mockResolvedValue(makeContainerInspect('c1'));

    const processor = makeContainerProcessor();
    const { reconciler } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    const startEvent: DockerEvent = { action: 'start', id: 'c1', Actor: { Attributes: {} } };
    emitter.emit('data', startEvent);
    await new Promise((r) => setTimeout(r, 10));

    expect(processor.process).toHaveBeenCalledWith(expect.objectContaining({ Id: 'c1' }), 'event');
  });

  it('logs container_removed for destroy event without calling process', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    const destroyEvent: DockerEvent = { action: 'destroy', id: 'c1', Actor: { Attributes: {} } };
    emitter.emit('data', destroyEvent);
    await new Promise((r) => setTimeout(r, 10));

    expect(processor.process).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'container_removed', container_id: 'c1' }),
    );
  });

  it('silently ignores unrecognized event types (no error thrown)', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    const unknownEvent = { action: 'die', id: 'c1', Actor: { Attributes: {} } } as DockerEvent;
    expect(() => emitter.emit('data', unknownEvent)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(processor.process).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('event handler exception does not crash the stream — next event still processed', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);
    vi.mocked(docker.inspectContainer)
      .mockRejectedValueOnce(new Error('inspect failed'))
      .mockResolvedValue(makeContainerInspect('c2'));

    const processor = makeContainerProcessor();
    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'start', id: 'c1', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));
    emitter.emit('data', { action: 'start', id: 'c2', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'event_handler_error' }),
      expect.any(String),
    );
    expect(processor.process).toHaveBeenCalledWith(expect.objectContaining({ Id: 'c2' }), 'event');
  });
});

describe('Reconciler.stop() / drain()', () => {
  it('stop() sets shutdown signal; no errors thrown', async () => {
    const { reconciler } = makeReconciler();
    expect(() => reconciler.stop()).not.toThrow();
  });

  it('drain() resolves immediately when no in-flight ops', async () => {
    const { reconciler } = makeReconciler();
    await expect(reconciler.drain()).resolves.toBeUndefined();
  });

  it('drain() awaits all tracked in-flight ops before resolving', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    let resolveInspect!: (v: ContainerInspect) => void;
    const inspectPromise = new Promise<ContainerInspect>((resolve) => {
      resolveInspect = resolve;
    });
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);
    vi.mocked(docker.inspectContainer).mockReturnValue(inspectPromise);

    const { reconciler } = makeReconciler({ docker });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'start', id: 'c1', Actor: { Attributes: {} } });

    let drainResolved = false;
    const drainPromise = reconciler.drain().then(() => {
      drainResolved = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(drainResolved).toBe(false);

    resolveInspect(makeContainerInspect('c1'));
    await drainPromise;
    expect(drainResolved).toBe(true);
  });
});

describe('Reconciler — branch coverage (non-Error throws, shutdownSignal)', () => {
  it('startup error handler handles non-Error thrown value (string)', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue({
      domains: ['app.example.com'],
      port: 80,
      forwardHostMode: 'auto',
      sslCertId: undefined,
    });
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    vi.mocked(docker.inspectContainer).mockRejectedValue('string-thrown-error');

    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.runStartupScan();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'string-thrown-error', stack: undefined }),
      }),
      expect.any(String),
    );
  });

  it('event handler handles non-Error thrown value (string)', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);
    vi.mocked(docker.inspectContainer).mockRejectedValue('string-event-error');

    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'start', id: 'c1', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'string-event-error', stack: undefined }),
      }),
      expect.any(String),
    );
  });

  it('shutdownSignal=true prevents event from being processed', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();
    reconciler.stop();

    emitter.emit('data', { action: 'start', id: 'c1', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));
    expect(processor.process).not.toHaveBeenCalled();
  });
});

describe('Reconciler — credential guard (AC: 6)', () => {
  it('no log call contains password or token values', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.runStartupScan();

    const allLogCalls = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls].map(
      (c) => JSON.stringify(c),
    );

    for (const logStr of allLogCalls) {
      expect(logStr).not.toContain('secret');
      expect(logStr).not.toContain('admin@example.com');
    }
  });
});

describe('Reconciler.startReconcileLoop() / stopReconcileLoop() (Story 3.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startReconcileLoop() uses config.RECONCILE_INTERVAL_MS as the interval', async () => {
    const config = { ...mockConfig, RECONCILE_INTERVAL_MS: 60_000 };
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm, config });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(docker.listContainers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(docker.listContainers).toHaveBeenCalledTimes(1);
  });

  it('timer fires → listContainers called (cycle runs)', async () => {
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);

    expect(docker.listContainers).toHaveBeenCalledTimes(1);
  });

  it('reconcileRunning=true when second tick fires → second cycle skipped with warn log', async () => {
    let resolveListContainers!: (v: ContainerInfo[]) => void;
    const blockingPromise = new Promise<ContainerInfo[]>((resolve) => {
      resolveListContainers = resolve;
    });
    const docker = makeDockerClient([]);
    vi.mocked(docker.listContainers).mockReturnValueOnce(blockingPromise).mockResolvedValue([]);
    const npm = makeNpmClient();
    const { reconciler, log } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    // First tick — cycle starts but listContainers is blocked
    await vi.advanceTimersByTimeAsync(300_001);
    // Second tick — cycle should be skipped
    await vi.advanceTimersByTimeAsync(300_001);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reconcile_skipped', reason: 'previous_cycle_running' }),
    );
    expect(docker.listContainers).toHaveBeenCalledTimes(1);

    // Unblock to clean up
    resolveListContainers([]);
  });

  it('NPM getProxyHosts throws NPM_UNREACHABLE → logs warn, loop NOT stopped, next tick works', async () => {
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts)
      .mockRejectedValueOnce(new NPMApiError('unreachable', ErrorCode.NPM_UNREACHABLE))
      .mockResolvedValue([]);
    const { reconciler, log } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    // Flush pending microtasks/promises
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconcile_cycle_error',
        error_code: ErrorCode.NPM_UNREACHABLE,
      }),
    );

    // Next tick should work without error
    vi.mocked(log.warn).mockClear();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reconcile_cycle_error' }),
    );
  });

  it('create action → containerProcessor.process(container, "reconcile") called', async () => {
    const container = makeContainerInspect('c1');
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(container);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts).mockResolvedValue([]);
    vi.mocked(diffState).mockReturnValue([{ type: 'create', container }]);

    const processor = makeContainerProcessor();
    const { reconciler } = makeReconciler({ docker, npm, processor });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(processor.process).toHaveBeenCalledWith(container, 'reconcile');
  });

  it('cleanup action → logs orphaned_proxy_host with cleanup_behavior none', async () => {
    const proxyHost = makeProxyHost(42, 'orphan.example.com');
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts).mockResolvedValue([proxyHost]);
    vi.mocked(diffState).mockReturnValue([{ type: 'cleanup', proxyHost, cleanupBehavior: 'none' }]);

    const { reconciler, log } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'orphaned_proxy_host',
        cleanup_behavior: 'none',
        result: 'skipped',
        trigger: 'reconcile',
      }),
    );
  });

  it('stopReconcileLoop() → clearInterval called, subsequent timer ticks do nothing', async () => {
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    reconciler.stopReconcileLoop();

    await vi.advanceTimersByTimeAsync(300_001);
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it('stopReconcileLoop() is idempotent — calling twice does not throw', () => {
    const { reconciler } = makeReconciler();
    reconciler.startReconcileLoop();
    expect(() => {
      reconciler.stopReconcileLoop();
      reconciler.stopReconcileLoop();
    }).not.toThrow();
  });

  it('stop() before interval fires → shutdownSignal skips reconcile tick', async () => {
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();

    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it('non-AppError thrown during reconcile cycle → logs UNKNOWN_ERROR', async () => {
    const docker = makeDockerClient([]);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts).mockRejectedValueOnce('plain string error');
    const { reconciler, log } = makeReconciler({ docker, npm });

    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconcile_cycle_error',
        error_code: ErrorCode.UNKNOWN_ERROR,
      }),
    );
  });
});

describe('Reconciler — destroy/remove event handling (Story 3.3)', () => {
  it('destroy event → logs container_removed with correct shape', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'destroy', id: 'abc123', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(log.info).toHaveBeenCalledWith({
      action: 'container_removed',
      container_id: 'abc123',
      cleanup_behavior: 'none',
      result: 'skipped',
    });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('remove event → same log output as destroy (same code path)', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler, log } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'remove', id: 'abc123', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(log.info).toHaveBeenCalledWith({
      action: 'container_removed',
      container_id: 'abc123',
      cleanup_behavior: 'none',
      result: 'skipped',
    });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('destroy followed by start for same container ID → process called for start, NOT for destroy', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);
    vi.mocked(docker.inspectContainer).mockResolvedValue(makeContainerInspect('abc123'));

    const processor = makeContainerProcessor();
    const { reconciler } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'destroy', id: 'abc123', Actor: { Attributes: {} } });
    emitter.emit('data', { action: 'start', id: 'abc123', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 20));

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(processor.process).toHaveBeenCalledWith(
      expect.objectContaining({ Id: 'abc123' }),
      'event',
    );
  });

  it('no npmClient method called during destroy event processing', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'destroy', id: 'abc123', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(npm.getProxyHosts).not.toHaveBeenCalled();
  });

  it('no npmClient method called during remove event processing', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const npm = makeNpmClient();
    const { reconciler } = makeReconciler({ docker, npm });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'remove', id: 'abc123', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(npm.getProxyHosts).not.toHaveBeenCalled();
  });

  it('event handler does NOT crash on destroy event (returns cleanly)', async () => {
    vi.mocked(parseContainerConfig).mockReturnValue(null);
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const { reconciler, log } = makeReconciler({ docker });
    await reconciler.startEventStream();

    expect(() =>
      emitter.emit('data', { action: 'destroy', id: 'abc123', Actor: { Attributes: {} } }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('event with empty id → handleEvent returns early, no processing', async () => {
    const emitter = new EventEmitter();
    const docker = makeDockerClient([], undefined);
    vi.mocked(docker.getEventStream).mockResolvedValue(emitter as NodeJS.ReadableStream);

    const processor = makeContainerProcessor();
    const { reconciler } = makeReconciler({ docker, processor });
    await reconciler.startEventStream();

    emitter.emit('data', { action: 'start', id: '', Actor: { Attributes: {} } });
    await new Promise((r) => setTimeout(r, 10));

    expect(processor.process).not.toHaveBeenCalled();
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });
});

describe('Reconciler — applyReconcileAction catch branch coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs reconcile_action_error with AppError code when process() throws AppError', async () => {
    const container = makeContainerInspect('c1');
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(container);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts).mockResolvedValue([]);
    vi.mocked(diffState).mockReturnValue([{ type: 'create', container }]);

    const processor = makeContainerProcessor();
    vi.mocked(processor.process).mockRejectedValue(
      new NPMApiError('NPM unreachable', ErrorCode.NPM_UNREACHABLE),
    );

    const { reconciler, log } = makeReconciler({ docker, npm, processor });
    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconcile_action_error',
        error_code: ErrorCode.NPM_UNREACHABLE,
        trigger: 'reconcile',
      }),
    );
  });

  it('logs reconcile_action_error with UNKNOWN_ERROR when process() throws non-Error', async () => {
    const container = makeContainerInspect('c1');
    const docker = makeDockerClient([makeContainerInfo('c1')]);
    vi.mocked(docker.inspectContainer).mockResolvedValue(container);
    const npm = makeNpmClient();
    vi.mocked(npm.getProxyHosts).mockResolvedValue([]);
    vi.mocked(diffState).mockReturnValue([{ type: 'create', container }]);

    const processor = makeContainerProcessor();
    vi.mocked(processor.process).mockRejectedValue('string-action-error');

    const { reconciler, log } = makeReconciler({ docker, npm, processor });
    reconciler.startReconcileLoop();
    await vi.advanceTimersByTimeAsync(300_001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconcile_action_error',
        error_code: ErrorCode.UNKNOWN_ERROR,
        err: expect.objectContaining({ message: 'string-action-error' }),
      }),
    );
  });
});

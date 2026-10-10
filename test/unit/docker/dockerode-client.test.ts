import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerodeClient } from '../../../src/docker/dockerode-client.js';
import { createEventStream, RECONNECT_DELAY_MS } from '../../../src/docker/event-stream.js';
import type { DockerEvent } from '../../../src/types/docker.js';

function makeDockerMock(overrides: Partial<Record<string, unknown>> = {}): Dockerode {
  return {
    ping: vi.fn().mockResolvedValue({}),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        Id: 'abc',
        Name: '/test',
        Config: { Env: [] },
        NetworkSettings: { Networks: {} },
      }),
    }),
    getEvents: vi.fn().mockResolvedValue(new PassThrough()),
    ...overrides,
  } as unknown as Dockerode;
}

function pushRawEvent(
  stream: PassThrough,
  event: Partial<{ Action: string; id: string; Actor: { Attributes: Record<string, string> } }>,
): void {
  stream.push(Buffer.from(JSON.stringify(event)));
}

describe('DockerodeClient.listContainers()', () => {
  it('maps raw dockerode output to ContainerInfo[] shape', async () => {
    const rawContainers = [
      {
        Id: 'cid1',
        Names: ['/web'],
        Image: 'nginx',
        State: 'running',
        NetworkSettings: {
          Networks: { bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1' } },
        },
      },
    ];
    const docker = makeDockerMock({ listContainers: vi.fn().mockResolvedValue(rawContainers) });
    const client = new DockerodeClient(docker);

    const result = await client.listContainers();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      Id: 'cid1',
      Names: ['/web'],
      Image: 'nginx',
      State: 'running',
      NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } } },
    });
  });

  it('returns empty array when no containers running', async () => {
    const docker = makeDockerMock({ listContainers: vi.fn().mockResolvedValue([]) });
    const client = new DockerodeClient(docker);
    expect(await client.listContainers()).toEqual([]);
  });
});

describe('DockerodeClient.inspectContainer()', () => {
  it('maps raw dockerode inspect output to ContainerInspect shape', async () => {
    const rawInspect = {
      Id: 'cid1',
      Name: '/web',
      Config: { Env: ['PORT=80', 'HOST=example.com'] },
      HostConfig: { NetworkMode: 'bridge', Privileged: false },
      NetworkSettings: {
        Networks: { bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1' } },
      },
    };
    const docker = makeDockerMock({
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue(rawInspect),
      }),
    });
    const client = new DockerodeClient(docker);

    const result = await client.inspectContainer('cid1');

    expect(result).toEqual({
      Id: 'cid1',
      Name: '/web',
      Config: { Env: ['PORT=80', 'HOST=example.com'] },
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } } },
    });
  });

  it('maps null Env to null', async () => {
    const rawInspect = {
      Id: 'cid2',
      Name: '/noenv',
      Config: { Env: null },
      NetworkSettings: { Networks: {} },
    };
    const docker = makeDockerMock({
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue(rawInspect),
      }),
    });
    const client = new DockerodeClient(docker);
    const result = await client.inspectContainer('cid2');
    expect(result.Config.Env).toBeNull();
  });
});

describe('DockerodeClient.getEventStream()', () => {
  it('returns a readable stream', async () => {
    const docker = makeDockerMock();
    const client = new DockerodeClient(docker);
    const stream = await client.getEventStream();
    expect(stream).toBeDefined();
    expect(typeof stream.on).toBe('function');
  });

  it('returns the same stream on repeated calls', async () => {
    const docker = makeDockerMock();
    const client = new DockerodeClient(docker);
    const s1 = await client.getEventStream();
    const s2 = await client.getEventStream();
    expect(s1).toBe(s2);
  });

  it('destroys the open stream on closeEventStream and returns a new one after', async () => {
    const docker = makeDockerMock();
    const client = new DockerodeClient(docker);
    const s1 = await client.getEventStream();
    client.closeEventStream();
    const s2 = await client.getEventStream();
    expect(s2).not.toBe(s1);
  });

  it('does not throw when closeEventStream is called with no open stream', () => {
    const docker = makeDockerMock();
    const client = new DockerodeClient(docker);
    expect(() => client.closeEventStream()).not.toThrow();
  });
});

describe('DockerodeClient.create()', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns a DockerodeClient instance when ping resolves', async () => {
    const MockDockerode = vi.fn();
    MockDockerode.prototype.ping = vi.fn().mockResolvedValue({});
    MockDockerode.prototype.getEvents = vi.fn().mockResolvedValue(new PassThrough());
    vi.doMock('dockerode', () => ({ default: MockDockerode }));

    const { DockerodeClient: DC } = await import('../../../src/docker/dockerode-client.js');
    const instance = await DC.create('/var/run/docker.sock');
    expect(instance).toBeInstanceOf(DC);
  });

  it('throws DockerConnectionError with DOCKER_SOCKET_ERROR when ping fails', async () => {
    const MockDockerode = vi.fn();
    MockDockerode.prototype.ping = vi.fn().mockRejectedValue(new Error('ENOENT'));
    vi.doMock('dockerode', () => ({ default: MockDockerode }));

    const { DockerodeClient: DC } = await import('../../../src/docker/dockerode-client.js');
    await expect(DC.create('/nonexistent.sock')).rejects.toMatchObject({
      code: 'DOCKER_SOCKET_ERROR',
      name: 'DockerConnectionError',
    });
  });
});

describe('createEventStream — event filtering', () => {
  it('forwards start events', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    pushRawEvent(rawStream, {
      Action: 'start',
      id: 'cid1',
      Actor: { Attributes: { name: 'web' } },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ action: 'start', id: 'cid1' });
  });

  it('forwards destroy events', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    pushRawEvent(rawStream, { Action: 'destroy', id: 'cid2', Actor: { Attributes: {} } });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ action: 'destroy', id: 'cid2' });
  });

  it('forwards remove events', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    pushRawEvent(rawStream, { Action: 'remove', id: 'cid3', Actor: { Attributes: {} } });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ action: 'remove', id: 'cid3' });
  });

  it('silently drops stop and die events — no data emitted', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    pushRawEvent(rawStream, { Action: 'stop', id: 'cid1', Actor: { Attributes: {} } });
    pushRawEvent(rawStream, { Action: 'die', id: 'cid2', Actor: { Attributes: {} } });
    await Promise.resolve();

    expect(received).toHaveLength(0);
  });

  it('silently drops kill, pause, and other unknown actions', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    pushRawEvent(rawStream, { Action: 'kill', id: 'cid1', Actor: { Attributes: {} } });
    pushRawEvent(rawStream, { Action: 'pause', id: 'cid2', Actor: { Attributes: {} } });
    pushRawEvent(rawStream, { Action: 'rename', id: 'cid3', Actor: { Attributes: {} } });
    await Promise.resolve();

    expect(received).toHaveLength(0);
  });

  it('silently discards malformed JSON chunks', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: unknown[] = [];
    out.on('data', (e: unknown) => received.push(e));

    rawStream.push(Buffer.from('not valid json {{{'));
    await Promise.resolve();

    expect(received).toHaveLength(0);
  });

  it('reuses the provided output PassThrough stream', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const provided = new PassThrough({ objectMode: true });

    const returned = await createEventStream(docker, provided);
    expect(returned).toBe(provided);
  });

  it('discards event with no id field', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    rawStream.push(Buffer.from(JSON.stringify({ Action: 'start', Actor: { Attributes: {} } })));
    await Promise.resolve();

    expect(received).toHaveLength(0);
  });

  it('defaults Actor.Attributes to empty object when Actor is missing', async () => {
    const rawStream = new PassThrough();
    const docker = makeDockerMock({ getEvents: vi.fn().mockResolvedValue(rawStream) });
    const out = (await createEventStream(docker)) as PassThrough;

    const received: DockerEvent[] = [];
    out.on('data', (e: DockerEvent) => received.push(e));

    rawStream.push(Buffer.from(JSON.stringify({ Action: 'destroy', id: 'cid1' })));
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].Actor.Attributes).toEqual({});
  });
});

describe('createEventStream — reconnect on stream end', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reconnects after stream end within RECONNECT_DELAY_MS', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    await createEventStream(docker);

    expect(getEvents).toHaveBeenCalledTimes(1);

    rawStream.emit('end');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it('does NOT reconnect before the delay expires', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    await createEventStream(docker);
    rawStream.emit('end');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 100);
    await Promise.resolve();

    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('reconnects after stream error within RECONNECT_DELAY_MS', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    await createEventStream(docker);

    rawStream.emit('error', new Error('socket hang up'));

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it('keeps the same output stream after reconnect so callers stay subscribed', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    const out = await createEventStream(docker);

    rawStream.emit('end');
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    const outAfterReconnect = await createEventStream(docker, out as PassThrough);
    expect(outAfterReconnect).toBe(out);
  });

  it('fires only one reconnect when rawStream emits both error and end', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    await createEventStream(docker);
    rawStream.emit('error', new Error('socket hang up'));
    rawStream.emit('end');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    // Only one reconnect despite two events
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect when output stream is already destroyed', async () => {
    const rawStream = new PassThrough();
    const getEvents = vi.fn().mockResolvedValue(rawStream);
    const docker = makeDockerMock({ getEvents });

    const out = (await createEventStream(docker)) as PassThrough;
    out.destroy();
    rawStream.emit('end');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    // out is destroyed — reconnect timer fires but skips getEvents
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('schedules reconnect when getEvents fails initially', async () => {
    const getEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(new PassThrough());
    const docker = makeDockerMock({ getEvents });

    await createEventStream(docker);

    expect(getEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    await Promise.resolve();

    expect(getEvents).toHaveBeenCalledTimes(2);
  });
});

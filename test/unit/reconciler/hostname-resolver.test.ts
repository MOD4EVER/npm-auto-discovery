import { describe, expect, it } from 'vitest';
import { resolveForwardHost } from '../../../src/reconciler/hostname-resolver.js';
import type { ContainerInspect } from '../../../src/types/docker.js';
import { DockerConnectionError, ErrorCode } from '../../../src/types/errors.js';

function makeContainer(
  name: string,
  networks: Record<string, { IPAddress: string }>,
): ContainerInspect {
  return {
    Id: 'abc123',
    Name: name,
    Config: { Env: [] },
    NetworkSettings: { Networks: networks },
  };
}

describe('resolveForwardHost — auto mode', () => {
  it('returns DNS name when container is on proxy network', async () => {
    const info = makeContainer('/my-app', { 'proxy-network': { IPAddress: '172.20.0.5' } });
    const result = await resolveForwardHost(info, 'auto', 'proxy-network');
    expect(result).toBe('my-app');
  });

  it('strips leading slash from container name', async () => {
    const info = makeContainer('/some-service', { 'proxy-network': { IPAddress: '172.20.0.2' } });
    const result = await resolveForwardHost(info, 'auto', 'proxy-network');
    expect(result).toBe('some-service');
  });

  it('falls back to proxy-network IP when container is not on proxy network', async () => {
    const info = makeContainer('/my-app', {
      'proxy-network': { IPAddress: '172.20.0.5' },
      bridge: { IPAddress: '172.17.0.3' },
    });
    // container IS on proxy-network so returns DNS name
    const result = await resolveForwardHost(info, 'auto', 'other-network');
    // not on other-network → falls back to first IP from proxy-network
    expect(result).toBe('172.20.0.5');
  });

  it('falls back to IP on another network when not on proxy network', async () => {
    const info = makeContainer('/my-app', { bridge: { IPAddress: '172.17.0.3' } });
    const result = await resolveForwardHost(info, 'auto', 'proxy-network');
    expect(result).toBe('172.17.0.3');
  });

  it('throws CONTAINER_NO_IP when no networks at all', async () => {
    const info = makeContainer('/my-app', {});
    await expect(resolveForwardHost(info, 'auto', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });

  it('treats empty IPAddress string as absent and throws CONTAINER_NO_IP', async () => {
    const info = makeContainer('/my-app', { bridge: { IPAddress: '' } });
    await expect(resolveForwardHost(info, 'auto', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });
});

describe('resolveForwardHost — ip mode', () => {
  it('returns IP directly without checking DNS', async () => {
    const info = makeContainer('/my-app', { 'proxy-network': { IPAddress: '172.20.0.5' } });
    const result = await resolveForwardHost(info, 'ip', 'proxy-network');
    expect(result).toBe('172.20.0.5');
  });

  it('returns fallback IP when proxy network IP is empty', async () => {
    const info = makeContainer('/my-app', {
      'proxy-network': { IPAddress: '' },
      bridge: { IPAddress: '172.17.0.3' },
    });
    const result = await resolveForwardHost(info, 'ip', 'proxy-network');
    expect(result).toBe('172.17.0.3');
  });

  it('throws CONTAINER_NO_IP when no IP anywhere', async () => {
    const info = makeContainer('/my-app', {});
    await expect(resolveForwardHost(info, 'ip', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });
});

describe('resolveForwardHost — defensive null guards', () => {
  it('handles null Networks (type-cast) via ?? {} fallback in auto mode', async () => {
    const info = {
      Id: 'abc',
      Name: '/my-app',
      Config: { Env: [] },
      NetworkSettings: { Networks: null },
    } as unknown as ContainerInspect;
    await expect(resolveForwardHost(info, 'auto', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });

  it('auto mode falls back to IP when container name is empty string after slash-strip', async () => {
    const info = {
      Id: 'abc',
      Name: '',
      Config: { Env: [] },
      NetworkSettings: { Networks: { 'proxy-network': { IPAddress: '172.20.0.5' } } },
    } as unknown as ContainerInspect;
    const result = await resolveForwardHost(info, 'auto', 'proxy-network');
    expect(result).toBe('172.20.0.5');
  });
});

describe('resolveForwardHost — dns mode', () => {
  it('returns DNS name when container is on proxy network', async () => {
    const info = makeContainer('/my-app', { 'proxy-network': { IPAddress: '172.20.0.5' } });
    const result = await resolveForwardHost(info, 'dns', 'proxy-network');
    expect(result).toBe('my-app');
  });

  it('throws CONTAINER_NO_IP without IP fallback when not on proxy network', async () => {
    const info = makeContainer('/my-app', { bridge: { IPAddress: '172.17.0.3' } });
    await expect(resolveForwardHost(info, 'dns', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });

  it('throws CONTAINER_NO_IP when Networks is empty', async () => {
    const info = makeContainer('/my-app', {});
    await expect(resolveForwardHost(info, 'dns', 'proxy-network')).rejects.toSatisfy(
      (e: unknown) => e instanceof DockerConnectionError && e.code === ErrorCode.CONTAINER_NO_IP,
    );
  });
});

describe('resolveForwardHost — network_mode: host', () => {
  function makeHostModeContainer(): ContainerInspect {
    return {
      Id: 'abc123',
      Name: '/game-node',
      Config: { Env: [] },
      HostConfig: { NetworkMode: 'host' },
      NetworkSettings: { Networks: { host: { IPAddress: '' } } },
    };
  }

  it('returns the configured host address regardless of mode', async () => {
    for (const mode of ['auto', 'dns', 'ip'] as const) {
      const result = await resolveForwardHost(
        makeHostModeContainer(),
        mode,
        'proxy-network',
        '172.18.0.1',
      );
      expect(result).toBe('172.18.0.1');
    }
  });

  it('throws CONTAINER_NO_IP mentioning HOST_NETWORK_FORWARD_HOST when it is not set', async () => {
    await expect(
      resolveForwardHost(makeHostModeContainer(), 'auto', 'proxy-network'),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DockerConnectionError &&
        e.code === ErrorCode.CONTAINER_NO_IP &&
        e.message.includes('HOST_NETWORK_FORWARD_HOST'),
    );
  });
});

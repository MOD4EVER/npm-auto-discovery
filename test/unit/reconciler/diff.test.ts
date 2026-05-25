import { describe, expect, it } from 'vitest';
import type { ReconcileAction } from '../../../src/reconciler/diff.js';
import { diffState } from '../../../src/reconciler/diff.js';
import type { ContainerInspect } from '../../../src/types/docker.js';
import type { ProxyHost } from '../../../src/types/npm-api.js';

function makeContainer(id: string, virtualHost: string, port = '80'): ContainerInspect {
  return {
    Id: id,
    Name: `/${id}`,
    Config: { Env: [`VIRTUAL_HOST=${virtualHost}`, `VIRTUAL_PORT=${port}`] },
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

describe('diffState()', () => {
  it('AC1: 3 managed containers, 2 matching proxy hosts → 1 create action for unregistered container', () => {
    const c1 = makeContainer('c1', 'a.example.com');
    const c2 = makeContainer('c2', 'b.example.com');
    const c3 = makeContainer('c3', 'c.example.com');
    const ph1 = makeProxyHost(1, 'a.example.com');
    const ph2 = makeProxyHost(2, 'b.example.com');

    const actions = diffState([c1, c2, c3], [ph1, ph2]);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('create');
    if (actions[0].type === 'create') {
      expect(actions[0].container.Id).toBe('c3');
    }
  });

  it('AC2: NPM proxy host with no running container → 1 cleanup action with cleanupBehavior none', () => {
    const ph = makeProxyHost(1, 'orphan.example.com');

    const actions = diffState([], [ph]);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('cleanup');
    if (actions[0].type === 'cleanup') {
      expect(actions[0].cleanupBehavior).toBe('none');
      expect(actions[0].proxyHost).toBe(ph);
    }
  });

  it('AC3: all containers have matching proxy hosts → empty array', () => {
    const c1 = makeContainer('c1', 'a.example.com');
    const ph1 = makeProxyHost(1, 'a.example.com');

    const actions = diffState([c1], [ph1]);

    expect(actions).toHaveLength(0);
  });

  it('AC4: container with 2 domains, only 1 proxy host exists → 1 create action (not 2)', () => {
    const c1 = makeContainer('c1', 'a.example.com,b.example.com');
    const ph1 = makeProxyHost(1, 'a.example.com');

    const actions = diffState([c1], [ph1]);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('create');
    const createActions = actions.filter(
      (a): a is Extract<ReconcileAction, { type: 'create' }> => a.type === 'create',
    );
    expect(createActions).toHaveLength(1);
    expect(createActions[0].container.Id).toBe('c1');
  });

  it('container with no VIRTUAL_HOST → not included in any action', () => {
    const c = {
      Id: 'c1',
      Name: '/c1',
      Config: { Env: ['SOME_VAR=value'] },
      NetworkSettings: { Networks: {} },
    } satisfies ContainerInspect;
    const ph = makeProxyHost(1, 'orphan.example.com');

    const actions = diffState([c], [ph]);

    // container not managed → no create; proxy host has no match → cleanup
    const creates = actions.filter((a) => a.type === 'create');
    expect(creates).toHaveLength(0);
  });

  it('proxy host with multiple domain_names where one is still managed → NOT orphaned', () => {
    const c1 = makeContainer('c1', 'managed.example.com');
    const ph = makeProxyHost(1, 'managed.example.com', 'other.example.com');

    const actions = diffState([c1], [ph]);

    const cleanups = actions.filter((a) => a.type === 'cleanup');
    expect(cleanups).toHaveLength(0);
  });

  it('empty containers + empty proxyHosts → empty array', () => {
    expect(diffState([], [])).toEqual([]);
  });

  it('diffState result is a new array each call — no shared state between calls', () => {
    const c1 = makeContainer('c1', 'a.example.com');

    const result1 = diffState([c1], []);
    const result2 = diffState([c1], []);

    expect(result1).not.toBe(result2);
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
  });

  it('ContainerInspect in CreateAction is the same reference passed in (no deep copy)', () => {
    const c1 = makeContainer('c1', 'a.example.com');

    const actions = diffState([c1], []);

    expect(actions).toHaveLength(1);
    if (actions[0].type === 'create') {
      expect(actions[0].container).toBe(c1);
    }
  });

  it('container with null Env → skipped (not managed)', () => {
    const c: ContainerInspect = {
      Id: 'c1',
      Name: '/c1',
      Config: { Env: null },
      NetworkSettings: { Networks: {} },
    };

    const actions = diffState([c], []);

    expect(actions).toHaveLength(0);
  });

  it('multiple containers with missing domains → one create action per container', () => {
    const c1 = makeContainer('c1', 'a.example.com');
    const c2 = makeContainer('c2', 'b.example.com');

    const actions = diffState([c1, c2], []);

    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.type === 'create')).toBe(true);
  });
});

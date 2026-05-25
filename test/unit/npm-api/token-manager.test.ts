import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../../../src/npm-api/token-manager.js';
import type { Config } from '../../../src/types/config.js';
import { ErrorCode, NPMApiError } from '../../../src/types/errors.js';

const makeJwt = (iat: number, exp: number): string => {
  const payload = Buffer.from(JSON.stringify({ iat, exp })).toString('base64url');
  return `header.${payload}.sig`;
};

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

function makeAxiosMock(token = makeJwt(1000, 2000)): AxiosInstance {
  return {
    post: vi.fn().mockResolvedValue({ data: { token } }),
  } as unknown as AxiosInstance;
}

describe('TokenManager.initialize()', () => {
  it('calls POST /api/tokens with email and password', async () => {
    const axiosMock = makeAxiosMock();
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    expect(axiosMock.post).toHaveBeenCalledWith('/api/tokens', {
      identity: mockConfig.NPM_EMAIL,
      secret: mockConfig.NPM_PASSWORD,
    });
  });

  it('caches the token after initialize', async () => {
    const token = makeJwt(1000, 2000);
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    expect(tm.getToken()).toBe(token);
  });

  it('throws NPMApiError with NPM_AUTH_FAILED when POST fails', async () => {
    const axiosMock = makeAxiosMock();
    vi.mocked(axiosMock.post).mockRejectedValue(new Error('network error'));
    const tm = new TokenManager(mockConfig, axiosMock);
    await expect(tm.initialize()).rejects.toThrow(NPMApiError);
    await expect(tm.initialize()).rejects.toMatchObject({ code: ErrorCode.NPM_AUTH_FAILED });
  });

  it('does NOT expose the token or password in any console output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = makeJwt(1000, 2000);
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    const allCalls = [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls].flat();
    for (const call of allCalls) {
      expect(String(call)).not.toContain(token);
      expect(String(call)).not.toContain(mockConfig.NPM_PASSWORD);
    }
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });
});

describe('TokenManager.getToken()', () => {
  it('throws NPMApiError if called before initialize', () => {
    const tm = new TokenManager(mockConfig, makeAxiosMock());
    expect(() => tm.getToken()).toThrow(NPMApiError);
  });

  it('returns the cached token after initialize', async () => {
    const token = makeJwt(1000, 2000);
    const tm = new TokenManager(mockConfig, makeAxiosMock(token));
    await tm.initialize();
    expect(tm.getToken()).toBe(token);
  });
});

describe('TokenManager.startRenewalLoop()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not throw when called before initialize (no token)', () => {
    const tm = new TokenManager(mockConfig, makeAxiosMock());
    expect(() => tm.startRenewalLoop()).not.toThrow();
  });

  it('schedules renewal immediately (min delay) when token TTL is zero (exp == iat)', async () => {
    const token = makeJwt(100, 100); // exp == iat → ttlMs = 0
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    tm.startRenewalLoop();
    // Should not fire before MIN_RENEWAL_DELAY_MS (1000ms)
    await vi.advanceTimersByTimeAsync(999);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    tm.stopRenewalLoop();
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  it('throws NPMApiError when token has fewer than 3 JWT segments', async () => {
    const axiosMock = {
      post: vi.fn().mockResolvedValue({ data: { token: 'not.a.valid.jwt' } }),
    } as unknown as AxiosInstance;
    const tm = new TokenManager(mockConfig, axiosMock as unknown as import('axios').AxiosInstance);
    await tm.initialize();
    // The malformed token will cause parseJwtPayload to throw
    // startRenewalLoop should propagate this as NPMApiError
    expect(() => {
      // Override token with a 2-segment malformed JWT
      (tm as unknown as { token: string }).token = 'only.two';
      tm.startRenewalLoop();
    }).toThrow(NPMApiError);
    tm.stopRenewalLoop();
  });

  it('fires renewal at 80% of TTL', async () => {
    // TTL = 10s → renewal at 8000ms
    const token = makeJwt(0, 10);
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    tm.startRenewalLoop();

    // At 7999ms — should NOT have renewed yet
    await vi.advanceTimersByTimeAsync(7999);
    expect(axiosMock.post).toHaveBeenCalledTimes(1);

    // At exactly 8000ms — renewal fires
    // advanceTimersByTimeAsync waits for triggered async callbacks
    // The next renewal timer (set by startRenewalLoop inside renewToken) needs
    // another 8000ms — so no infinite loop here
    await vi.advanceTimersByTimeAsync(1);
    // Allow microtasks from the async renewToken to settle
    await Promise.resolve();
    await Promise.resolve();
    tm.stopRenewalLoop();
    expect(axiosMock.post).toHaveBeenCalledTimes(2);
  });

  it('does not crash on NPM unreachable during renewal', async () => {
    const token = makeJwt(0, 10);
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();

    vi.mocked(axiosMock.post).mockRejectedValue(new Error('connection refused'));
    tm.startRenewalLoop();

    // Trigger renewal — should log NPM_UNREACHABLE and schedule a retry without crashing
    await vi.advanceTimersByTimeAsync(8001);
    await Promise.resolve();
    await Promise.resolve();
    // Stop before the retry timer fires to avoid an infinite test loop
    tm.stopRenewalLoop();

    // Still has the cached token from before
    expect(tm.getToken()).toBe(token);
  });
});

describe('TokenManager.stopRenewalLoop()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('prevents renewal from firing after stop', async () => {
    const token = makeJwt(0, 10);
    const axiosMock = makeAxiosMock(token);
    const tm = new TokenManager(mockConfig, axiosMock);
    await tm.initialize();
    tm.startRenewalLoop();
    tm.stopRenewalLoop();

    await vi.advanceTimersByTimeAsync(10_000);
    // Only the initial initialize call, no renewal
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  it('is safe to call multiple times without throwing', () => {
    const tm = new TokenManager(mockConfig, makeAxiosMock());
    expect(() => {
      tm.stopRenewalLoop();
      tm.stopRenewalLoop();
    }).not.toThrow();
  });
});

import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosNPMApiClient } from '../../../src/npm-api/axios-npm-api-client.js';
import type { TokenManager } from '../../../src/npm-api/token-manager.js';
import type { Config } from '../../../src/types/config.js';
import { ErrorCode, NPMApiError } from '../../../src/types/errors.js';
import type { ProxyHost } from '../../../src/types/npm-api.js';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(),
    },
  };
});

import axios from 'axios';

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

const mockProxyHost: ProxyHost = {
  id: 1,
  domain_names: ['app.example.com'],
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

function makeTokenManagerMock(token = 'mock-jwt-token'): TokenManager {
  return {
    getToken: vi.fn().mockReturnValue(token),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as TokenManager;
}

function makeLoggerMock(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

type ReqInterceptorFn = (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig;
type ErrInterceptorFn = (error: unknown) => Promise<unknown>;

interface MockHttpClient {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  interceptors: {
    request: { use: ReturnType<typeof vi.fn> };
    response: { use: ReturnType<typeof vi.fn> };
  };
  capturedReqInterceptor: () => ReqInterceptorFn;
  capturedErrInterceptor: () => ErrInterceptorFn;
}

function makeHttpClientMock(): MockHttpClient {
  let reqInterceptor: ReqInterceptorFn = (c) => c;
  let errInterceptor: ErrInterceptorFn = async (e) => {
    throw e;
  };

  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: {
        use: vi.fn().mockImplementation((fn: ReqInterceptorFn) => {
          reqInterceptor = fn;
        }),
      },
      response: {
        use: vi
          .fn()
          .mockImplementation((_: (r: AxiosResponse) => AxiosResponse, errFn: ErrInterceptorFn) => {
            errInterceptor = errFn;
          }),
      },
    },
    capturedReqInterceptor: () => reqInterceptor,
    capturedErrInterceptor: () => errInterceptor,
  };
}

const silentLog = pino({ level: 'silent' });

function buildClient(token = 'mock-jwt-token', log: Logger = silentLog, config = mockConfig) {
  const mock = makeHttpClientMock();
  vi.mocked(axios.create).mockReturnValue(mock as unknown as AxiosInstance);
  const tokenManager = makeTokenManagerMock(token);
  const client = new AxiosNPMApiClient(config, tokenManager, log);
  return { client, mock, tokenManager };
}

// ─── Existing interceptor tests (unchanged) ────────────────────────────────

describe('AxiosNPMApiClient — request interceptor', () => {
  it('injects Authorization Bearer header on each request', () => {
    const { mock, tokenManager } = buildClient('my-token');
    const interceptor = mock.capturedReqInterceptor();
    const fakeConfig = { headers: {} } as InternalAxiosRequestConfig;
    const result = interceptor(fakeConfig);
    expect(result.headers.Authorization).toBe(`Bearer ${tokenManager.getToken()}`);
  });
});

describe('AxiosNPMApiClient — response interceptor (401 retry)', () => {
  it('calls tokenManager.initialize() and updates header on first 401', async () => {
    const { mock, tokenManager } = buildClient('new-token');
    const errInterceptor = mock.capturedErrInterceptor();

    const originalRequest = {
      headers: {} as Record<string, string>,
      _retry: undefined as boolean | undefined,
    } as InternalAxiosRequestConfig & { _retry?: boolean };

    const axiosError = {
      response: { status: 401, data: undefined },
      config: originalRequest,
      message: 'Unauthorized',
      isAxiosError: true,
    };

    try {
      await errInterceptor(axiosError);
    } catch {
      // expected: httpClient is not callable in this mock
    }

    expect(tokenManager.initialize).toHaveBeenCalledOnce();
    expect(originalRequest._retry).toBe(true);
    expect(originalRequest.headers.Authorization).toBe('Bearer new-token');
  });

  it('does NOT re-authenticate on second 401 (prevents infinite retry loop)', async () => {
    const { mock, tokenManager } = buildClient();
    const errInterceptor = mock.capturedErrInterceptor();

    const retriedRequest = {
      headers: {} as Record<string, string>,
      _retry: true,
    } as InternalAxiosRequestConfig & { _retry?: boolean };

    const error = {
      response: { status: 401, data: undefined },
      config: retriedRequest,
      message: 'Unauthorized',
    };

    await expect(errInterceptor(error)).rejects.toBeInstanceOf(NPMApiError);
    expect(tokenManager.initialize).not.toHaveBeenCalled();
  });

  it('throws NPMApiError when tokenManager.initialize() throws during 401 retry', async () => {
    const { mock, tokenManager } = buildClient();
    const errInterceptor = mock.capturedErrInterceptor();
    vi.mocked(tokenManager.initialize).mockRejectedValue(new NPMApiError('auth failed'));

    const originalRequest = {
      headers: {} as Record<string, string>,
      _retry: undefined as boolean | undefined,
    } as InternalAxiosRequestConfig & { _retry?: boolean };

    const axiosError = {
      response: { status: 401, data: undefined },
      config: originalRequest,
      message: 'Unauthorized',
      isAxiosError: true,
    };

    await expect(errInterceptor(axiosError)).rejects.toBeInstanceOf(NPMApiError);
    expect(tokenManager.initialize).toHaveBeenCalledOnce();
  });

  it('throws NPMApiError with NPM_AUTH_FAILED code on 401', async () => {
    const { mock } = buildClient();
    const errInterceptor = mock.capturedErrInterceptor();

    const req = { headers: {}, _retry: true } as InternalAxiosRequestConfig & { _retry?: boolean };
    const error = {
      response: { status: 401, data: 'denied' },
      config: req,
      message: 'Unauthorized',
    };

    let thrown: unknown;
    try {
      await errInterceptor(error);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(NPMApiError);
    if (thrown instanceof NPMApiError) {
      expect(thrown.code).toBe(ErrorCode.NPM_AUTH_FAILED);
      expect(thrown.statusCode).toBe(401);
    }
  });

  it('throws NPMApiError with NPM_API_ERROR code on non-401 errors', async () => {
    const { mock } = buildClient();
    const errInterceptor = mock.capturedErrInterceptor();

    const req = { headers: {}, _retry: false } as InternalAxiosRequestConfig & { _retry?: boolean };
    const error = {
      response: { status: 503, data: undefined },
      config: req,
      message: 'Service Unavailable',
    };

    let thrown: unknown;
    try {
      await errInterceptor(error);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(NPMApiError);
    if (thrown instanceof NPMApiError) {
      expect(thrown.code).toBe(ErrorCode.NPM_API_ERROR);
      expect(thrown.statusCode).toBe(503);
    }
  });
});

describe('AxiosNPMApiClient — response interceptor (success path)', () => {
  it('passes successful responses through unchanged', () => {
    const { mock } = buildClient();
    const successInterceptor = mock.interceptors.response.use.mock.calls[0]?.[0] as
      | ((r: AxiosResponse) => AxiosResponse)
      | undefined;
    const fakeResponse = { data: { ok: true }, status: 200 } as AxiosResponse;
    expect(successInterceptor?.(fakeResponse)).toBe(fakeResponse);
  });
});

// ─── CRUD methods ──────────────────────────────────────────────────────────

describe('AxiosNPMApiClient — getProxyHosts()', () => {
  it('calls GET /api/nginx/proxy-hosts and returns parsed array', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockResolvedValue({ data: [mockProxyHost] });
    const result = await client.getProxyHosts();
    expect(mock.get).toHaveBeenCalledWith('/api/nginx/proxy-hosts');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1 });
  });
});

describe('AxiosNPMApiClient — getProxyHostById()', () => {
  it('calls GET /api/nginx/proxy-hosts/:id and returns host', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockResolvedValue({ data: mockProxyHost, status: 200 });
    const result = await client.getProxyHostById(1);
    expect(mock.get).toHaveBeenCalledWith('/api/nginx/proxy-hosts/1');
    expect(result).toMatchObject({ id: 1 });
  });

  it('logs NPM_API_ERROR and throws NPMApiError when response has unexpected schema', async () => {
    const log = makeLoggerMock();
    // NPM_MAX_RETRIES=0 to avoid real sleeps in schema-validation tests
    const { client, mock } = buildClient('token', log, { ...mockConfig, NPM_MAX_RETRIES: 0 });
    vi.mocked(mock.get).mockResolvedValue({ data: { unexpected: 'shape' }, status: 200 });

    await expect(client.getProxyHostById(1)).rejects.toBeInstanceOf(NPMApiError);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: ErrorCode.NPM_API_ERROR }),
      expect.any(String),
    );
  });

  it('does NOT log NPM password or token in error logs', async () => {
    const log = makeLoggerMock();
    const { client, mock } = buildClient('my-secret-token', log, {
      ...mockConfig,
      NPM_MAX_RETRIES: 0,
    });
    vi.mocked(mock.get).mockResolvedValue({ data: 'bad', status: 200 });

    await expect(client.getProxyHostById(1)).rejects.toBeInstanceOf(NPMApiError);

    const logCall = vi.mocked(log.error).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const logStr = JSON.stringify(logCall ?? {});
    expect(logStr).not.toContain('my-secret-token');
    expect(logStr).not.toContain('secret');
  });
});

describe('AxiosNPMApiClient — createProxyHost()', () => {
  it('calls POST /api/nginx/proxy-hosts with exact payload and returns ProxyHost', async () => {
    const { client, mock } = buildClient();
    const input = {
      domain_names: ['app.example.com'],
      forward_host: '10.0.0.1',
      forward_port: 80,
      forward_scheme: 'http' as const,
    };
    vi.mocked(mock.post).mockResolvedValue({ data: { id: 1, ...input } });
    const result = await client.createProxyHost(input);
    expect(mock.post).toHaveBeenCalledWith('/api/nginx/proxy-hosts', input);
    expect(result).toMatchObject({ id: 1 });
  });
});

describe('AxiosNPMApiClient — createProxyHost() schema validation', () => {
  it('throws NPMApiError when POST response has unexpected schema', async () => {
    const log = makeLoggerMock();
    const { client, mock } = buildClient('token', log, { ...mockConfig, NPM_MAX_RETRIES: 0 });
    vi.mocked(mock.post).mockResolvedValue({ data: { unexpected: 'shape' }, status: 200 });

    await expect(
      client.createProxyHost({
        domain_names: ['x.com'],
        forward_host: 'h',
        forward_port: 80,
        forward_scheme: 'http',
      }),
    ).rejects.toBeInstanceOf(NPMApiError);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: ErrorCode.NPM_API_ERROR }),
      expect.any(String),
    );
  });
});

describe('AxiosNPMApiClient — updateProxyHost() schema validation', () => {
  it('throws NPMApiError when GET response has unexpected schema', async () => {
    const log = makeLoggerMock();
    const { client, mock } = buildClient('token', log, { ...mockConfig, NPM_MAX_RETRIES: 0 });
    vi.mocked(mock.get).mockResolvedValue({ data: { broken: true }, status: 200 });

    await expect(client.updateProxyHost(1, { forward_port: 9090 })).rejects.toBeInstanceOf(
      NPMApiError,
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: ErrorCode.NPM_API_ERROR }),
      expect.any(String),
    );
  });
});

describe('AxiosNPMApiClient — updateProxyHost()', () => {
  it('fetches current state via GET then sends full merged object via PUT', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockResolvedValue({ data: mockProxyHost });
    const updated = { ...mockProxyHost, forward_port: 8080 };
    vi.mocked(mock.put).mockResolvedValue({ data: updated });

    const result = await client.updateProxyHost(1, { forward_port: 8080 });

    expect(mock.get).toHaveBeenCalledWith('/api/nginx/proxy-hosts/1');
    const { id: _id, ...writableFields } = mockProxyHost;
    expect(mock.put).toHaveBeenCalledWith('/api/nginx/proxy-hosts/1', {
      ...writableFields,
      forward_port: 8080,
    });
    // NPM-managed fields (block_exploits, etc.) are preserved
    expect(result.block_exploits).toBe(true);
  });
});

describe('AxiosNPMApiClient — deleteProxyHost()', () => {
  it('calls DELETE /api/nginx/proxy-hosts/:id', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.delete).mockResolvedValue({ data: undefined });
    await client.deleteProxyHost(7);
    expect(mock.delete).toHaveBeenCalledWith('/api/nginx/proxy-hosts/7');
  });
});

describe('AxiosNPMApiClient — getCertificates()', () => {
  it('calls GET /api/nginx/certificates', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockResolvedValue({ data: [] });
    const result = await client.getCertificates();
    expect(mock.get).toHaveBeenCalledWith('/api/nginx/certificates');
    expect(result).toEqual([]);
  });
});

describe('AxiosNPMApiClient — createCertificate()', () => {
  it('calls POST /api/nginx/certificates with letsencrypt provider', async () => {
    const { client, mock } = buildClient();
    const domains = ['example.com'];
    vi.mocked(mock.post).mockResolvedValue({ data: { id: 2, domain_names: domains } });
    const result = await client.createCertificate(domains);
    expect(mock.post).toHaveBeenCalledWith('/api/nginx/certificates', {
      provider: 'letsencrypt',
      domain_names: domains,
    });
    expect(result).toMatchObject({ id: 2 });
  });
});

// ─── withRetry — exponential backoff ───────────────────────────────────────

describe('AxiosNPMApiClient — withRetry exponential backoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('retries up to NPM_MAX_RETRIES times on failure, then throws NPMApiError', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockRejectedValue(new NPMApiError('err', ErrorCode.NPM_API_ERROR, 500));

    // Eagerly catch to avoid PromiseRejectionHandledWarning during timer advancement
    const errorCapture = client.getProxyHosts().catch((e: unknown) => e);
    // NPM_MAX_RETRIES=3: sleep 1s + 2s + 4s = 7s
    await vi.advanceTimersByTimeAsync(7_000);

    const error = await errorCapture;
    expect(error).toBeInstanceOf(NPMApiError);
    // 4 total calls: attempts 0, 1, 2, 3
    expect(mock.get).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry on 4xx client errors (except 429)', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get).mockRejectedValue(
      new NPMApiError('forbidden', ErrorCode.NPM_API_ERROR, 403),
    );

    const errorCapture = client.getProxyHosts().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    const error = await errorCapture;
    expect(error).toBeInstanceOf(NPMApiError);
    if (error instanceof NPMApiError) {
      expect(error.statusCode).toBe(403);
    }
    // Only one attempt — no retry for 4xx
    expect(mock.get).toHaveBeenCalledTimes(1);
  });

  it('returns result when retry succeeds on second attempt', async () => {
    const { client, mock } = buildClient();
    vi.mocked(mock.get)
      .mockRejectedValueOnce(new NPMApiError('err', ErrorCode.NPM_API_ERROR, 500))
      .mockResolvedValueOnce({ data: [mockProxyHost] });

    const resultCapture = client.getProxyHosts();
    await vi.advanceTimersByTimeAsync(1_000); // first backoff: 2^0 * 1000ms

    const result = await resultCapture;
    expect(result).toHaveLength(1);
    expect(mock.get).toHaveBeenCalledTimes(2);
  });
});

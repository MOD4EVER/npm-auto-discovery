import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { Logger } from 'pino';
import type { Config } from '../types/config.js';
import { ErrorCode, NPMApiError } from '../types/errors.js';
import type {
  Certificate,
  CreateProxyHostInput,
  NPMApiClient,
  ProxyHost,
} from '../types/npm-api.js';
import {
  createProxyHost,
  deleteProxyHost,
  getProxyHostById,
  getProxyHosts,
  updateProxyHost,
} from './proxy-hosts.js';
import type { TokenManager } from './token-manager.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: Error = new Error('No attempts made');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Do not retry 4xx client errors (except 429 rate limit) — they are permanent failures
      if (
        err instanceof NPMApiError &&
        err.statusCode !== undefined &&
        err.statusCode >= 400 &&
        err.statusCode < 500 &&
        err.statusCode !== 429
      ) {
        throw err;
      }
      if (attempt < maxRetries) {
        await sleep(2 ** attempt * 1000);
      }
    }
  }
  throw new NPMApiError('Max retries exceeded', ErrorCode.NPM_API_ERROR, undefined, lastError);
}

export class AxiosNPMApiClient implements NPMApiClient {
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly config: Config,
    private readonly tokenManager: TokenManager,
    private readonly log: Logger,
  ) {
    this.httpClient = axios.create({
      baseURL: config.NPM_URL,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.httpClient.interceptors.request.use((reqConfig) => {
      reqConfig.headers.Authorization = `Bearer ${this.tokenManager.getToken()}`;
      return reqConfig;
    });

    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          try {
            await this.tokenManager.initialize();
          } catch {
            throw this.normalizeError(error);
          }
          originalRequest.headers.Authorization = `Bearer ${this.tokenManager.getToken()}`;
          return this.httpClient(originalRequest);
        }
        throw this.normalizeError(error);
      },
    );
  }

  async getProxyHosts(): Promise<ProxyHost[]> {
    return withRetry(() => getProxyHosts(this.httpClient), this.config.NPM_MAX_RETRIES);
  }

  async getProxyHostById(id: number): Promise<ProxyHost> {
    return withRetry(
      () => getProxyHostById(this.httpClient, id, this.log),
      this.config.NPM_MAX_RETRIES,
    );
  }

  async createProxyHost(input: CreateProxyHostInput): Promise<ProxyHost> {
    return withRetry(
      () => createProxyHost(this.httpClient, input, this.log),
      this.config.NPM_MAX_RETRIES,
    );
  }

  async updateProxyHost(id: number, patch: Partial<ProxyHost>): Promise<ProxyHost> {
    return withRetry(
      () => updateProxyHost(this.httpClient, id, patch, this.log),
      this.config.NPM_MAX_RETRIES,
    );
  }

  async deleteProxyHost(id: number): Promise<void> {
    return withRetry(() => deleteProxyHost(this.httpClient, id), this.config.NPM_MAX_RETRIES);
  }

  async getCertificates(): Promise<Certificate[]> {
    return withRetry(
      () => this.httpClient.get<Certificate[]>('/api/nginx/certificates').then((r) => r.data),
      this.config.NPM_MAX_RETRIES,
    );
  }

  async createCertificate(domains: string[]): Promise<Certificate> {
    return withRetry(
      () =>
        this.httpClient
          .post<Certificate>('/api/nginx/certificates', {
            provider: 'letsencrypt',
            domain_names: domains,
          })
          .then((r) => r.data),
      this.config.NPM_MAX_RETRIES,
    );
  }

  private normalizeError(error: AxiosError): NPMApiError {
    const status = error.response?.status;
    const code = status === 401 ? ErrorCode.NPM_AUTH_FAILED : ErrorCode.NPM_API_ERROR;
    return new NPMApiError(error.message, code, status, error.response?.data);
  }
}

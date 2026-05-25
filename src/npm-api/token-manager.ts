import type { AxiosInstance } from 'axios';
import type { Logger } from 'pino';
import type { Config } from '../types/config.js';
import { ErrorCode, NPMApiError } from '../types/errors.js';

interface JwtPayload {
  exp: number;
  iat: number;
}

const MIN_RENEWAL_DELAY_MS = 1_000;

export class TokenManager {
  private token: string | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly axiosInstance: AxiosInstance,
    private readonly log?: Logger,
  ) {}

  async initialize(): Promise<void> {
    try {
      const response = await this.axiosInstance.post<{ token: string }>('/api/tokens', {
        identity: this.config.NPM_EMAIL,
        secret: this.config.NPM_PASSWORD,
      });
      this.token = response.data.token;
    } catch {
      throw new NPMApiError('NPM authentication failed', ErrorCode.NPM_AUTH_FAILED);
    }
  }

  getToken(): string {
    if (this.token === null) {
      throw new NPMApiError(
        'TokenManager not initialized — call initialize() first',
        ErrorCode.NPM_AUTH_FAILED,
      );
    }
    return this.token;
  }

  startRenewalLoop(): void {
    if (this.token === null) return;
    const payload = this.parseJwtPayload(this.token);
    const ttlMs = (payload.exp - payload.iat) * 1000;
    if (ttlMs <= 0) {
      // Expired or zero-TTL token — schedule renewal after minimum delay to avoid tight loop
      this.renewalTimer = setTimeout(() => void this.renewToken(), MIN_RENEWAL_DELAY_MS);
      return;
    }
    const renewAt = Math.max(ttlMs * 0.8, MIN_RENEWAL_DELAY_MS);
    this.renewalTimer = setTimeout(() => void this.renewToken(), renewAt);
  }

  stopRenewalLoop(): void {
    if (this.renewalTimer !== null) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private async renewToken(): Promise<void> {
    try {
      await this.initialize();
      this.startRenewalLoop();
    } catch (err) {
      this.log?.warn({
        action: 'token_renewal_failed',
        error_code: ErrorCode.NPM_UNREACHABLE,
        /* c8 ignore next */
        err: { message: err instanceof Error ? err.message : String(err) },
      });
      this.renewalTimer = setTimeout(() => void this.renewToken(), MIN_RENEWAL_DELAY_MS);
    }
  }

  private parseJwtPayload(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length < 3 || !parts[1]) {
      throw new NPMApiError('Malformed JWT received from NPM', ErrorCode.NPM_AUTH_FAILED);
    }
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as JwtPayload;
  }
}

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCertificate } from '../../../src/npm-api/certificates.js';
import { CertError, ErrorCode } from '../../../src/types/errors.js';
import type { Certificate, NPMApiClient } from '../../../src/types/npm-api.js';

function makeCert(id: number, domain_names: string[]): Certificate {
  return { id, domain_names, expires_on: '2099-01-01', provider: 'letsencrypt' };
}

function makeNpmClient(overrides: Partial<NPMApiClient> = {}): NPMApiClient {
  return {
    getProxyHosts: vi.fn(),
    getProxyHostById: vi.fn(),
    createProxyHost: vi.fn(),
    updateProxyHost: vi.fn(),
    deleteProxyHost: vi.fn(),
    getCertificates: vi.fn(),
    createCertificate: vi.fn(),
    ...overrides,
  } as unknown as NPMApiClient;
}

function makeLogger(): Logger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

describe('resolveCertificate — stage 1: explicit sslCertId', () => {
  it('returns sslCertId immediately without any API calls', async () => {
    const npmClient = makeNpmClient();
    const logger = makeLogger();
    const result = await resolveCertificate('app.example.com', 42, npmClient, logger);
    expect(result).toBe(42);
    expect(npmClient.getCertificates).not.toHaveBeenCalled();
    expect(npmClient.createCertificate).not.toHaveBeenCalled();
  });
});

describe('resolveCertificate — stage 2: exact match', () => {
  let npmClient: NPMApiClient;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('returns cert id for exact domain match without calling createCertificate', async () => {
    npmClient = makeNpmClient({
      getCertificates: vi
        .fn()
        .mockResolvedValue([makeCert(5, ['app.example.com', 'other.example.com'])]),
    });
    const result = await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(result).toBe(5);
    expect(npmClient.createCertificate).not.toHaveBeenCalled();
  });

  it('calls getCertificates exactly once even when exact match is found', async () => {
    npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(3, ['app.example.com'])]),
    });
    await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(npmClient.getCertificates).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCertificate — stage 3: wildcard match', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('returns wildcard cert id when no exact match but wildcard matches', async () => {
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(7, ['*.example.com'])]),
    });
    const result = await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(result).toBe(7);
    expect(npmClient.createCertificate).not.toHaveBeenCalled();
  });

  it('does NOT match *.example.com against example.com (zero subdomain levels)', async () => {
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(7, ['*.example.com'])]),
      createCertificate: vi.fn().mockResolvedValue(makeCert(99, ['example.com'])),
    });
    const result = await resolveCertificate('example.com', undefined, npmClient, logger);
    expect(result).toBe(99);
    expect(npmClient.createCertificate).toHaveBeenCalledWith(['example.com']);
  });

  it('does NOT match *.example.com against deep.sub.example.com (two subdomain levels)', async () => {
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(7, ['*.example.com'])]),
      createCertificate: vi.fn().mockResolvedValue(makeCert(99, ['deep.sub.example.com'])),
    });
    const result = await resolveCertificate('deep.sub.example.com', undefined, npmClient, logger);
    expect(result).toBe(99);
    expect(npmClient.createCertificate).toHaveBeenCalled();
  });

  it('DOES match *.example.com against app.example.com (one subdomain level)', async () => {
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(7, ['*.example.com'])]),
    });
    const result = await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(result).toBe(7);
  });

  it('calls getCertificates exactly once for both exact and wildcard scans', async () => {
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([makeCert(7, ['*.example.com'])]),
    });
    await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(npmClient.getCertificates).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCertificate — stage 4: createCertificate', () => {
  it('calls createCertificate when no existing cert matches and returns new cert id', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockResolvedValue(makeCert(20, ['app.example.com'])),
    });
    const result = await resolveCertificate('app.example.com', undefined, npmClient, logger);
    expect(result).toBe(20);
    expect(npmClient.createCertificate).toHaveBeenCalledWith(['app.example.com']);
  });
});

describe('resolveCertificate — wildcard match branch coverage', () => {
  it('skips non-wildcard cert patterns in matchesWildcard (continue branch)', async () => {
    const logger = makeLogger();
    // cert has both a non-wildcard and a wildcard domain_name
    const npmClient = makeNpmClient({
      getCertificates: vi
        .fn()
        .mockResolvedValue([makeCert(7, ['static.example.com', '*.example.com'])]),
    });
    const result = await resolveCertificate('app.example.com', undefined, npmClient, logger);
    // non-wildcard 'static.example.com' is skipped; wildcard '*.example.com' matches
    expect(result).toBe(7);
  });

  it('handleCertError with non-Error thrown value uses String(err) for message', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockRejectedValue('plain string error'),
    });
    await expect(
      resolveCertificate('app.example.com', undefined, npmClient, logger),
    ).rejects.toMatchObject({ code: ErrorCode.CERT_FAILED });
  });
});

describe('resolveCertificate — rate-limit error handling', () => {
  it('throws CertError with CERT_RATE_LIMIT when error message contains "rate limit"', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockRejectedValue(new Error('rate limit exceeded')),
    });
    await expect(
      resolveCertificate('app.example.com', undefined, npmClient, logger),
    ).rejects.toMatchObject({ code: ErrorCode.CERT_RATE_LIMIT });
    expect(npmClient.createCertificate).toHaveBeenCalledTimes(1);
  });

  it('throws CertError with CERT_RATE_LIMIT when error message contains "too many"', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockRejectedValue(new Error('too many requests')),
    });
    await expect(
      resolveCertificate('app.example.com', undefined, npmClient, logger),
    ).rejects.toMatchObject({ code: ErrorCode.CERT_RATE_LIMIT });
  });

  it('logs warn with structured fields on rate-limit error', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockRejectedValue(new Error('rate limit exceeded')),
    });
    await expect(
      resolveCertificate('app.example.com', undefined, npmClient, logger),
    ).rejects.toBeInstanceOf(CertError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cert_rate_limit', domain: 'app.example.com' }),
    );
  });

  it('throws CertError with CERT_FAILED for generic non-rate-limit errors', async () => {
    const logger = makeLogger();
    const npmClient = makeNpmClient({
      getCertificates: vi.fn().mockResolvedValue([]),
      createCertificate: vi.fn().mockRejectedValue(new Error('internal server error')),
    });
    await expect(
      resolveCertificate('app.example.com', undefined, npmClient, logger),
    ).rejects.toMatchObject({ code: ErrorCode.CERT_FAILED });
  });
});

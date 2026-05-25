import { describe, expect, it, vi } from 'vitest';
import { parseConfig, safeConfig } from '../../src/config.js';
import { ConfigValidationError, ErrorCode } from '../../src/types/errors.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const validEnv = {
  NPM_URL: 'http://npm:81',
  NPM_EMAIL: 'admin@example.com',
  NPM_PASSWORD: 'secret123',
};

describe('parseConfig()', () => {
  it('returns a fully-typed Config when all required fields are present', () => {
    const config = parseConfig(validEnv);
    expect(config.NPM_URL).toBe('http://npm:81');
    expect(config.NPM_EMAIL).toBe('admin@example.com');
    expect(config.NPM_PASSWORD).toBe('secret123');
  });

  it('applies correct defaults for optional fields', () => {
    const config = parseConfig(validEnv);
    expect(config.RECONCILE_INTERVAL_MS).toBe(300_000);
    expect(config.FORWARD_HOST_MODE).toBe('auto');
    expect(config.PROXY_NETWORK_NAME).toBe('proxy-network');
    expect(config.NPM_MAX_RETRIES).toBe(3);
    expect(config.HEALTH_PORT).toBe(8080);
    expect(config.NPM_CREDENTIALS_FILE).toBeUndefined();
  });

  it('coerces numeric env vars from string to number', () => {
    const config = parseConfig({ ...validEnv, HEALTH_PORT: '9090', NPM_MAX_RETRIES: '5' });
    expect(config.HEALTH_PORT).toBe(9090);
    expect(config.NPM_MAX_RETRIES).toBe(5);
  });

  it('throws ConfigValidationError with field NPM_URL when NPM_URL is missing', () => {
    const env = { NPM_EMAIL: 'a@b.com', NPM_PASSWORD: 'x' };
    let caught: unknown;
    try {
      parseConfig(env);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    if (caught instanceof ConfigValidationError) {
      expect(caught.field).toBe('NPM_URL');
      expect(caught.code).toBe(ErrorCode.CONFIG_VALIDATION_ERROR);
    }
  });

  it('throws ConfigValidationError when NPM_EMAIL is missing', () => {
    expect(() => parseConfig({ NPM_URL: 'http://npm:81', NPM_PASSWORD: 'x' })).toThrow(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when NPM_PASSWORD is missing', () => {
    expect(() => parseConfig({ NPM_URL: 'http://npm:81', NPM_EMAIL: 'a@b.com' })).toThrow(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when NPM_URL is not a valid URL', () => {
    expect(() => parseConfig({ ...validEnv, NPM_URL: 'not-a-url' })).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when NPM_EMAIL is not a valid email', () => {
    expect(() => parseConfig({ ...validEnv, NPM_EMAIL: 'not-an-email' })).toThrow(
      ConfigValidationError,
    );
  });

  it('accepts all FORWARD_HOST_MODE enum values', () => {
    expect(parseConfig({ ...validEnv, FORWARD_HOST_MODE: 'dns' }).FORWARD_HOST_MODE).toBe('dns');
    expect(parseConfig({ ...validEnv, FORWARD_HOST_MODE: 'ip' }).FORWARD_HOST_MODE).toBe('ip');
    expect(parseConfig({ ...validEnv, FORWARD_HOST_MODE: 'auto' }).FORWARD_HOST_MODE).toBe('auto');
  });

  it('throws ConfigValidationError for invalid FORWARD_HOST_MODE', () => {
    expect(() => parseConfig({ ...validEnv, FORWARD_HOST_MODE: 'invalid' })).toThrow(
      ConfigValidationError,
    );
  });
});

describe('parseConfig() with NPM_CREDENTIALS_FILE', () => {
  it('reads NPM_EMAIL and NPM_PASSWORD from credentials file', () => {
    vi.mocked(readFileSync).mockReturnValue(
      'NPM_EMAIL=file@example.com\nNPM_PASSWORD=filepassword\n',
    );
    const config = parseConfig({
      NPM_URL: 'http://npm:81',
      NPM_CREDENTIALS_FILE: '/run/secrets/npm-creds',
    });
    expect(config.NPM_EMAIL).toBe('file@example.com');
    expect(config.NPM_PASSWORD).toBe('filepassword');
    expect(readFileSync).toHaveBeenCalledWith('/run/secrets/npm-creds', 'utf-8');
    vi.mocked(readFileSync).mockReset();
  });

  it('credentials file takes precedence over env vars', () => {
    vi.mocked(readFileSync).mockReturnValue('NPM_EMAIL=file@example.com\nNPM_PASSWORD=from-file\n');
    const config = parseConfig({
      ...validEnv,
      NPM_CREDENTIALS_FILE: '/run/secrets/npm-creds',
    });
    expect(config.NPM_EMAIL).toBe('file@example.com');
    expect(config.NPM_PASSWORD).toBe('from-file');
    vi.mocked(readFileSync).mockReset();
  });

  it('skips lines without = sign in credentials file', () => {
    vi.mocked(readFileSync).mockReturnValue(
      '# comment\nNPM_EMAIL=file@example.com\nNPM_PASSWORD=filepassword\n\nno-equals-skipped\n',
    );
    const config = parseConfig({
      NPM_URL: 'http://npm:81',
      NPM_CREDENTIALS_FILE: '/run/secrets/npm-creds',
    });
    expect(config.NPM_EMAIL).toBe('file@example.com');
    expect(config.NPM_PASSWORD).toBe('filepassword');
    vi.mocked(readFileSync).mockReset();
  });

  it('throws ConfigValidationError when credentials file cannot be read', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    expect(() =>
      parseConfig({ NPM_URL: 'http://npm:81', NPM_CREDENTIALS_FILE: '/missing/creds' }),
    ).toThrow(ConfigValidationError);
    vi.mocked(readFileSync).mockReset();
  });

  it('ignores unrecognised keys in credentials file', () => {
    vi.mocked(readFileSync).mockReturnValue(
      'NPM_EMAIL=file@example.com\nNPM_PASSWORD=filepassword\nUNKNOWN_KEY=ignored\n',
    );
    const config = parseConfig({
      NPM_URL: 'http://npm:81',
      NPM_CREDENTIALS_FILE: '/run/secrets/npm-creds',
    });
    expect(config.NPM_EMAIL).toBe('file@example.com');
    expect(config.NPM_PASSWORD).toBe('filepassword');
    vi.mocked(readFileSync).mockReset();
  });
});

describe('safeConfig()', () => {
  it('redacts NPM_EMAIL and NPM_PASSWORD', () => {
    const config = parseConfig(validEnv);
    const safe = safeConfig(config);
    expect(safe.NPM_EMAIL).toBe('[REDACTED]');
    expect(safe.NPM_PASSWORD).toBe('[REDACTED]');
  });

  it('preserves non-sensitive fields', () => {
    const config = parseConfig(validEnv);
    const safe = safeConfig(config);
    expect(safe.NPM_URL).toBe('http://npm:81');
    expect(safe.HEALTH_PORT).toBe(8080);
    expect(safe.FORWARD_HOST_MODE).toBe('auto');
  });

  it('does not contain plaintext credentials anywhere in output', () => {
    const config = parseConfig({ ...validEnv, NPM_PASSWORD: 'supersecret123' });
    const safe = safeConfig(config);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('supersecret123');
    expect(serialized).not.toContain('admin@example.com');
  });
});

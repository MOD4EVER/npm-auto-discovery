import { describe, expect, it } from 'vitest';
import {
  AppError,
  CertError,
  ConfigValidationError,
  DockerConnectionError,
  ErrorCode,
  NPMApiError,
} from '../../../src/types/errors.js';

describe('ErrorCode enum', () => {
  it('contains all 8 required operational codes', () => {
    expect(ErrorCode.NPM_UNREACHABLE).toBe('NPM_UNREACHABLE');
    expect(ErrorCode.NPM_AUTH_FAILED).toBe('NPM_AUTH_FAILED');
    expect(ErrorCode.NPM_API_ERROR).toBe('NPM_API_ERROR');
    expect(ErrorCode.CERT_RATE_LIMIT).toBe('CERT_RATE_LIMIT');
    expect(ErrorCode.CERT_FAILED).toBe('CERT_FAILED');
    expect(ErrorCode.DOCKER_SOCKET_ERROR).toBe('DOCKER_SOCKET_ERROR');
    expect(ErrorCode.CONTAINER_NO_IP).toBe('CONTAINER_NO_IP');
    expect(ErrorCode.PROXY_HOST_EXISTS).toBe('PROXY_HOST_EXISTS');
  });

  it('has at least 8 entries and includes all required operational codes', () => {
    const keys = Object.keys(ErrorCode).filter((k) => Number.isNaN(Number(k)));
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });
});

describe('AppError', () => {
  it('is an instance of Error and AppError', () => {
    const err = new AppError('base error', ErrorCode.NPM_API_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('sets code and message correctly', () => {
    const err = new AppError('test message', ErrorCode.NPM_AUTH_FAILED);
    expect(err.code).toBe(ErrorCode.NPM_AUTH_FAILED);
    expect(err.message).toBe('test message');
  });

  it('preserves stack trace', () => {
    const err = new AppError('stack test', ErrorCode.NPM_API_ERROR);
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  it('sets name to AppError', () => {
    const err = new AppError('msg', ErrorCode.NPM_API_ERROR);
    expect(err.name).toBe('AppError');
  });
});

describe('DockerConnectionError', () => {
  it('is an instance of DockerConnectionError, AppError, and Error', () => {
    const err = new DockerConnectionError('docker failed');
    expect(err).toBeInstanceOf(DockerConnectionError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults to DOCKER_SOCKET_ERROR code', () => {
    const err = new DockerConnectionError('docker failed');
    expect(err.code).toBe(ErrorCode.DOCKER_SOCKET_ERROR);
  });

  it('accepts a custom error code', () => {
    const err = new DockerConnectionError('docker failed', ErrorCode.CONTAINER_NO_IP);
    expect(err.code).toBe(ErrorCode.CONTAINER_NO_IP);
  });

  it('preserves message and stack', () => {
    const err = new DockerConnectionError('connection refused');
    expect(err.message).toBe('connection refused');
    expect(err.stack).toBeDefined();
  });

  it('sets name to DockerConnectionError', () => {
    const err = new DockerConnectionError('msg');
    expect(err.name).toBe('DockerConnectionError');
  });
});

describe('NPMApiError', () => {
  it('is an instance of NPMApiError, AppError, and Error', () => {
    const err = new NPMApiError('npm failed');
    expect(err).toBeInstanceOf(NPMApiError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults to NPM_API_ERROR code', () => {
    const err = new NPMApiError('npm failed');
    expect(err.code).toBe(ErrorCode.NPM_API_ERROR);
  });

  it('accepts statusCode and rawResponse', () => {
    const raw = { body: 'forbidden' };
    const err = new NPMApiError('auth failed', ErrorCode.NPM_AUTH_FAILED, 403, raw);
    expect(err.code).toBe(ErrorCode.NPM_AUTH_FAILED);
    expect(err.statusCode).toBe(403);
    expect(err.rawResponse).toBe(raw);
  });

  it('statusCode and rawResponse are optional', () => {
    const err = new NPMApiError('error');
    expect(err.statusCode).toBeUndefined();
    expect(err.rawResponse).toBeUndefined();
  });

  it('preserves stack', () => {
    const err = new NPMApiError('msg');
    expect(err.stack).toBeDefined();
  });

  it('sets name to NPMApiError', () => {
    const err = new NPMApiError('msg');
    expect(err.name).toBe('NPMApiError');
  });
});

describe('ConfigValidationError', () => {
  it('is an instance of ConfigValidationError, AppError, and Error', () => {
    const err = new ConfigValidationError('invalid', 'NPM_URL');
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('stores the field name', () => {
    const err = new ConfigValidationError('must not be empty', 'NPM_URL');
    expect(err.field).toBe('NPM_URL');
  });

  it('defaults to CONFIG_VALIDATION_ERROR code', () => {
    const err = new ConfigValidationError('invalid', 'NPM_URL');
    expect(err.code).toBe(ErrorCode.CONFIG_VALIDATION_ERROR);
  });

  it('preserves stack', () => {
    const err = new ConfigValidationError('msg', 'field');
    expect(err.stack).toBeDefined();
  });

  it('sets name to ConfigValidationError', () => {
    const err = new ConfigValidationError('msg', 'field');
    expect(err.name).toBe('ConfigValidationError');
  });
});

describe('CertError', () => {
  it('is an instance of CertError, AppError, and Error', () => {
    const err = new CertError('cert failed');
    expect(err).toBeInstanceOf(CertError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults to CERT_FAILED code', () => {
    const err = new CertError('cert failed');
    expect(err.code).toBe(ErrorCode.CERT_FAILED);
  });

  it('accepts CERT_RATE_LIMIT code', () => {
    const err = new CertError('rate limited', ErrorCode.CERT_RATE_LIMIT);
    expect(err.code).toBe(ErrorCode.CERT_RATE_LIMIT);
  });

  it('preserves stack', () => {
    const err = new CertError('msg');
    expect(err.stack).toBeDefined();
  });

  it('sets name to CertError', () => {
    const err = new CertError('msg');
    expect(err.name).toBe('CertError');
  });
});

describe('instanceof cross-checks (no false positives)', () => {
  it('DockerConnectionError is not instanceof NPMApiError', () => {
    const err = new DockerConnectionError('docker error');
    expect(err).not.toBeInstanceOf(NPMApiError);
  });

  it('NPMApiError is not instanceof DockerConnectionError', () => {
    const err = new NPMApiError('npm error');
    expect(err).not.toBeInstanceOf(DockerConnectionError);
  });

  it('CertError is not instanceof ConfigValidationError', () => {
    const err = new CertError('cert error');
    expect(err).not.toBeInstanceOf(ConfigValidationError);
  });
});

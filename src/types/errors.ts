export enum ErrorCode {
  NPM_UNREACHABLE = 'NPM_UNREACHABLE',
  NPM_AUTH_FAILED = 'NPM_AUTH_FAILED',
  NPM_API_ERROR = 'NPM_API_ERROR',
  CERT_RATE_LIMIT = 'CERT_RATE_LIMIT',
  CERT_FAILED = 'CERT_FAILED',
  DOCKER_SOCKET_ERROR = 'DOCKER_SOCKET_ERROR',
  CONTAINER_NO_IP = 'CONTAINER_NO_IP',
  PROXY_HOST_EXISTS = 'PROXY_HOST_EXISTS',
  CONFIG_VALIDATION_ERROR = 'CONFIG_VALIDATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class DockerConnectionError extends AppError {
  constructor(
    message: string,
    public override readonly code: ErrorCode = ErrorCode.DOCKER_SOCKET_ERROR,
  ) {
    super(message, code);
    this.name = 'DockerConnectionError';
    Object.setPrototypeOf(this, DockerConnectionError.prototype);
  }
}

export class NPMApiError extends AppError {
  constructor(
    message: string,
    public override readonly code: ErrorCode = ErrorCode.NPM_API_ERROR,
    public readonly statusCode?: number,
    public readonly rawResponse?: unknown,
  ) {
    super(message, code);
    this.name = 'NPMApiError';
    Object.setPrototypeOf(this, NPMApiError.prototype);
  }
}

export class ConfigValidationError extends AppError {
  constructor(
    message: string,
    public readonly field: string,
    public override readonly code: ErrorCode = ErrorCode.CONFIG_VALIDATION_ERROR,
  ) {
    super(message, code);
    this.name = 'ConfigValidationError';
    Object.setPrototypeOf(this, ConfigValidationError.prototype);
  }
}

export class CertError extends AppError {
  constructor(
    message: string,
    public override readonly code: ErrorCode = ErrorCode.CERT_FAILED,
  ) {
    super(message, code);
    this.name = 'CertError';
    Object.setPrototypeOf(this, CertError.prototype);
  }
}

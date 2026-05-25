import type { Logger } from 'pino';
import { CertError, ErrorCode } from '../types/errors.js';
import type { Certificate, NPMApiClient } from '../types/npm-api.js';

function matchesWildcard(domain: string, cert: Certificate): boolean {
  for (const pattern of cert.domain_names) {
    if (!pattern.startsWith('*.')) continue;
    const wildcardBase = pattern.slice(2);
    const parts = domain.split('.');
    const baseParts = wildcardBase.split('.');
    if (parts.length !== baseParts.length + 1) continue;
    if (domain.endsWith(`.${wildcardBase}`)) return true;
  }
  return false;
}

function handleCertError(domain: string, err: unknown, logger: Logger): never {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('too many')) {
    logger.warn({
      action: 'cert_rate_limit',
      error_code: ErrorCode.CERT_RATE_LIMIT,
      domain,
      guidance:
        "Let's Encrypt rate limit hit for domain. Wait 1 hour before retrying. See: https://letsencrypt.org/docs/rate-limits/",
    });
    throw new CertError(
      `Let's Encrypt rate limit hit for domain "${domain}": ${message}`,
      ErrorCode.CERT_RATE_LIMIT,
    );
  }
  throw new CertError(
    `Certificate creation failed for domain "${domain}": ${message}`,
    ErrorCode.CERT_FAILED,
  );
}

export async function resolveCertificate(
  domain: string,
  sslCertId: number | undefined,
  npmClient: NPMApiClient,
  logger: Logger,
): Promise<number> {
  if (sslCertId !== undefined) {
    return sslCertId;
  }

  const certs = await npmClient.getCertificates();

  const exactMatch = certs.find((c) => c.domain_names.includes(domain));
  if (exactMatch) {
    return exactMatch.id;
  }

  const wildcardMatch = certs.find((c) => matchesWildcard(domain, c));
  if (wildcardMatch) {
    return wildcardMatch.id;
  }

  try {
    const newCert = await npmClient.createCertificate([domain]);
    return newCert.id;
  } catch (err) {
    return handleCertError(domain, err, logger);
  }
}

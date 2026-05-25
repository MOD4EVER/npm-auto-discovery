import type { ContainerConfig } from '../types/npm-api.js';

function parseEnvMap(env: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of env) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) continue;
    const key = entry.slice(0, eqIdx);
    const value = entry.slice(eqIdx + 1);
    map[key] = value;
  }
  return map;
}

export function parseContainerConfig(env: string[] | null): ContainerConfig | null {
  if (!env || env.length === 0) return null;

  const envMap = parseEnvMap(env);

  const rawVirtualHost = envMap.VIRTUAL_HOST;
  if (!rawVirtualHost || rawVirtualHost.trim() === '') return null;

  const domains = rawVirtualHost
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (domains.length === 0) return null;

  const rawPort = envMap.VIRTUAL_PORT;
  const parsedPort = rawPort !== undefined ? Number.parseInt(rawPort, 10) : Number.NaN;
  const port = !Number.isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 80;

  const rawCertId = envMap.VIRTUAL_SSL_CERT_ID;
  let sslCertId: number | undefined;
  if (rawCertId !== undefined) {
    const parsed = Number.parseInt(rawCertId, 10);
    sslCertId = !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined;
  }

  const rawMode = envMap.FORWARD_HOST_MODE;
  const forwardHostMode: 'auto' | 'dns' | 'ip' =
    rawMode === 'dns' || rawMode === 'ip' ? rawMode : 'auto';

  return { domains, port, sslCertId, forwardHostMode };
}

import type { AxiosInstance } from 'axios';
import type { Logger } from 'pino';
import { ErrorCode, NPMApiError } from '../types/errors.js';
import type { CreateProxyHostInput, ProxyHost } from '../types/npm-api.js';

function isProxyHost(data: unknown): data is ProxyHost {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).id === 'number' &&
    Array.isArray((data as Record<string, unknown>).domain_names)
  );
}

export async function getProxyHosts(http: AxiosInstance): Promise<ProxyHost[]> {
  const res = await http.get<ProxyHost[]>('/api/nginx/proxy-hosts');
  return res.data;
}

export async function getProxyHostById(
  http: AxiosInstance,
  id: number,
  log: Logger,
): Promise<ProxyHost> {
  const res = await http.get<unknown>(`/api/nginx/proxy-hosts/${id}`);
  if (!isProxyHost(res.data)) {
    log.error(
      { error_code: ErrorCode.NPM_API_ERROR, raw_response: res.data },
      'Unexpected NPM response schema',
    );
    throw new NPMApiError(
      'Unexpected NPM response schema',
      ErrorCode.NPM_API_ERROR,
      res.status,
      res.data,
    );
  }
  return res.data;
}

export async function createProxyHost(
  http: AxiosInstance,
  config: CreateProxyHostInput,
  log?: Logger,
): Promise<ProxyHost> {
  const res = await http.post<unknown>('/api/nginx/proxy-hosts', config);
  if (!isProxyHost(res.data)) {
    log?.error(
      { error_code: ErrorCode.NPM_API_ERROR, raw_response: res.data },
      'Unexpected NPM response schema',
    );
    throw new NPMApiError(
      'Unexpected NPM response schema',
      ErrorCode.NPM_API_ERROR,
      res.status,
      res.data,
    );
  }
  return res.data;
}

export async function updateProxyHost(
  http: AxiosInstance,
  id: number,
  patch: Partial<CreateProxyHostInput>,
  log?: Logger,
): Promise<ProxyHost> {
  const current = await http.get<unknown>(`/api/nginx/proxy-hosts/${id}`);
  if (!isProxyHost(current.data)) {
    log?.error(
      { error_code: ErrorCode.NPM_API_ERROR, raw_response: current.data },
      'Unexpected NPM response schema',
    );
    throw new NPMApiError(
      'Unexpected NPM response schema',
      ErrorCode.NPM_API_ERROR,
      current.status,
      current.data,
    );
  }
  // Only send writable fields — NPM rejects read-only fields (id, created_on, etc.) with 400
  const {
    domain_names,
    forward_host,
    forward_port,
    forward_scheme,
    ssl_forced,
    certificate_id,
    advanced_config,
    access_list_id,
    hsts_enabled,
    hsts_subdomains,
    http2_support,
    block_exploits,
    caching_enabled,
    allow_websocket_upgrade,
    meta,
  } = current.data;
  const body: CreateProxyHostInput = {
    domain_names,
    forward_host,
    forward_port,
    forward_scheme,
    ssl_forced,
    certificate_id,
    advanced_config,
    access_list_id,
    hsts_enabled,
    hsts_subdomains,
    http2_support,
    block_exploits,
    caching_enabled,
    allow_websocket_upgrade,
    meta,
    ...patch,
  };
  const res = await http.put<ProxyHost>(`/api/nginx/proxy-hosts/${id}`, body);
  return res.data;
}

export async function deleteProxyHost(http: AxiosInstance, id: number): Promise<void> {
  await http.delete(`/api/nginx/proxy-hosts/${id}`);
}

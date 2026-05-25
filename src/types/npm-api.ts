export interface ProxyHost {
  id: number;
  domain_names: string[];
  forward_host: string;
  forward_port: number;
  forward_scheme: 'http' | 'https';
  ssl_forced: boolean;
  certificate_id: number | null;
  advanced_config: string;
  access_list_id: number;
  hsts_enabled: boolean;
  hsts_subdomains: boolean;
  http2_support: boolean;
  block_exploits: boolean;
  caching_enabled: boolean;
  allow_websocket_upgrade: boolean;
  meta: Record<string, unknown>;
}

export interface Certificate {
  id: number;
  domain_names: string[];
  expires_on: string;
  provider: string;
}

export interface ContainerConfig {
  domains: string[];
  port: number;
  sslCertId: number | undefined;
  forwardHostMode: 'auto' | 'dns' | 'ip';
}

export interface OperationLog {
  action: string;
  container_id: string;
  container_name: string;
  domain: string;
  trigger: string;
  result: string;
  duration_ms: number;
  error_code?: string;
}

export interface CreateProxyHostInput {
  domain_names: string[];
  forward_host: string;
  forward_port: number;
  forward_scheme: 'http' | 'https';
  ssl_forced?: boolean;
  certificate_id?: number | null;
  advanced_config?: string;
  access_list_id?: number;
  hsts_enabled?: boolean;
  hsts_subdomains?: boolean;
  http2_support?: boolean;
  block_exploits?: boolean;
  caching_enabled?: boolean;
  allow_websocket_upgrade?: boolean;
  meta?: Record<string, unknown>;
}

export interface NPMApiClient {
  getProxyHosts(): Promise<ProxyHost[]>;
  getProxyHostById(id: number): Promise<ProxyHost>;
  createProxyHost(config: CreateProxyHostInput): Promise<ProxyHost>;
  updateProxyHost(id: number, patch: Partial<CreateProxyHostInput>): Promise<ProxyHost>;
  deleteProxyHost(id: number): Promise<void>;
  getCertificates(): Promise<Certificate[]>;
  createCertificate(domains: string[]): Promise<Certificate>;
}

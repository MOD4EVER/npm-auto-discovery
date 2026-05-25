import type { Logger } from 'pino';
import { resolveCertificate } from '../npm-api/certificates.js';
import type { Config } from '../types/config.js';
import type { ContainerInspect } from '../types/docker.js';
import { AppError, ErrorCode } from '../types/errors.js';
import type { ContainerConfig, NPMApiClient } from '../types/npm-api.js';
import { resolveForwardHost } from './hostname-resolver.js';
import { parseContainerConfig } from './parse-container-config.js';

type ProcessResult = 'created' | 'updated' | 'skipped' | 'failed';

export class ContainerProcessor {
  constructor(
    private readonly config: Config,
    private readonly npmClient: NPMApiClient,
    private readonly log: Logger,
  ) {}

  async process(
    container: ContainerInspect,
    trigger: 'startup' | 'event' | 'reconcile',
  ): Promise<ProcessResult> {
    const containerConfig = parseContainerConfig(container.Config.Env);
    if (!containerConfig) return 'skipped';

    const settled = await Promise.allSettled(
      containerConfig.domains.map((domain) =>
        this.processDomain(domain, containerConfig, container, trigger),
      ),
    );

    const values = settled.map((r) =>
      r.status === 'fulfilled' ? r.value : ('failed' as ProcessResult),
    );
    if (values.includes('created')) return 'created';
    if (values.includes('updated')) return 'updated';
    if (values.includes('failed')) return 'failed';
    return 'skipped';
  }

  private async processDomain(
    domain: string,
    containerConfig: ContainerConfig,
    container: ContainerInspect,
    trigger: 'startup' | 'event' | 'reconcile',
  ): Promise<ProcessResult> {
    const container_id = container.Id;
    const container_name = container.Name.replace(/^\//, '');
    const start = Date.now();

    try {
      const hosts = await this.npmClient.getProxyHosts();
      const existing = hosts.find((h) => h.domain_names.includes(domain));
      const resolvedHost = await resolveForwardHost(
        container,
        containerConfig.forwardHostMode,
        this.config.PROXY_NETWORK_NAME,
      );

      if (!existing) {
        const certId = await resolveCertificate(
          domain,
          containerConfig.sslCertId,
          this.npmClient,
          this.log,
        );
        await this.npmClient.createProxyHost({
          domain_names: [domain],
          forward_host: resolvedHost,
          forward_port: containerConfig.port,
          forward_scheme: 'http',
          certificate_id: certId ?? null,
          ssl_forced: certId != null,
          allow_websocket_upgrade: true,
          block_exploits: true,
        });
        this.log.info({
          action: 'proxy_host_created',
          container_id,
          container_name,
          domain,
          trigger,
          result: 'created',
          duration_ms: Date.now() - start,
        });
        return 'created';
      }

      if (
        existing.forward_host === resolvedHost &&
        existing.forward_port === containerConfig.port
      ) {
        this.log.info({
          action: 'proxy_host_exists',
          container_id,
          container_name,
          domain,
          trigger,
          result: 'skipped',
          error_code: ErrorCode.PROXY_HOST_EXISTS,
          duration_ms: Date.now() - start,
        });
        return 'skipped';
      }

      await this.npmClient.updateProxyHost(existing.id, {
        forward_host: resolvedHost,
        forward_port: containerConfig.port,
      });
      this.log.info({
        action: 'proxy_host_updated',
        container_id,
        container_name,
        domain,
        trigger,
        result: 'updated',
        duration_ms: Date.now() - start,
      });
      return 'updated';
    } catch (err) {
      this.handleDomainError(err, domain, container_id, trigger);
      return 'failed';
    }
  }

  private handleDomainError(
    err: unknown,
    domain: string,
    container_id: string,
    trigger: string,
  ): void {
    const error_code = err instanceof AppError ? err.code : ErrorCode.UNKNOWN_ERROR;
    this.log.warn({
      action: 'domain_failed',
      container_id,
      domain,
      trigger,
      error_code,
      err: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });
  }
}

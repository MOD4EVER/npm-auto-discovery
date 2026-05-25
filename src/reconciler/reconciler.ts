import type { Logger } from 'pino';
import type { Config } from '../types/config.js';
import type { ContainerInspect, DockerClient, DockerEvent } from '../types/docker.js';
import { AppError, ErrorCode } from '../types/errors.js';
import type { NPMApiClient } from '../types/npm-api.js';
import type { ContainerProcessor } from './container-processor.js';
import type { ReconcileAction } from './diff.js';
import { diffState } from './diff.js';
import { parseContainerConfig } from './parse-container-config.js';

export class Reconciler {
  private shutdownSignal = false;
  private readonly inFlightOps = new Set<Promise<void>>();
  private reconcileIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconcileRunning = false;

  constructor(
    private readonly config: Config,
    private readonly dockerClient: DockerClient,
    private readonly npmClient: NPMApiClient,
    private readonly containerProcessor: ContainerProcessor,
    private readonly log: Logger,
  ) {}

  private track(op: Promise<void>): void {
    this.inFlightOps.add(op);
    op.finally(() => this.inFlightOps.delete(op)).catch(() => {});
  }

  async runStartupScan(): Promise<void> {
    const containers = await this.dockerClient.listContainers();
    let managed = 0;
    let created = 0;
    let updated = 0;

    await Promise.allSettled(
      containers.map(async (c) => {
        try {
          const info = await this.dockerClient.inspectContainer(c.Id);
          const containerConfig = parseContainerConfig(info.Config.Env);
          if (!containerConfig) return;
          managed++;
          const result = await this.containerProcessor.process(info, 'startup');
          if (result === 'created') created++;
          if (result === 'updated') updated++;
        } catch (err) {
          this.log.warn(
            {
              action: 'startup_container_error',
              container_id: c.Id,
              err: {
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              },
            },
            'Error processing container during startup scan',
          );
        }
      }),
    );

    this.log.info({
      action: 'startup_complete',
      containers_found: containers.length,
      containers_managed: managed,
      proxy_hosts_created: created,
      proxy_hosts_updated: updated,
    });
  }

  async startEventStream(): Promise<void> {
    const stream = await this.dockerClient.getEventStream();
    stream.on('data', (event: DockerEvent) => {
      if (this.shutdownSignal) return;
      this.track(this.handleEvent(event));
    });
  }

  startReconcileLoop(): void {
    this.reconcileIntervalId = setInterval(() => {
      if (this.shutdownSignal) return;
      if (this.reconcileRunning) {
        this.log.warn({ action: 'reconcile_skipped', reason: 'previous_cycle_running' });
        return;
      }
      this.track(this.runReconcileCycle());
    }, this.config.RECONCILE_INTERVAL_MS);
  }

  stopReconcileLoop(): void {
    if (this.reconcileIntervalId !== null) {
      clearInterval(this.reconcileIntervalId);
      this.reconcileIntervalId = null;
    }
  }

  private async runReconcileCycle(): Promise<void> {
    this.reconcileRunning = true;
    const cycleStart = Date.now();
    try {
      const containers = await this.dockerClient.listContainers();
      const inspectResults = await Promise.allSettled(
        containers.map((c) => this.dockerClient.inspectContainer(c.Id)),
      );
      const inspected = inspectResults
        .filter((r): r is PromiseFulfilledResult<ContainerInspect> => r.status === 'fulfilled')
        .map((r) => r.value);

      const proxyHosts = await this.npmClient.getProxyHosts();
      const actions = diffState(inspected, proxyHosts);

      await Promise.allSettled(actions.map((a) => this.applyReconcileAction(a)));

      this.log.info({
        action: 'reconcile_complete',
        actions_create: actions.filter((a) => a.type === 'create').length,
        actions_cleanup: actions.filter((a) => a.type === 'cleanup').length,
        duration_ms: Date.now() - cycleStart,
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : ErrorCode.UNKNOWN_ERROR;
      this.log.warn({
        action: 'reconcile_cycle_error',
        error_code: code,
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      this.reconcileRunning = false;
    }
  }

  private async applyReconcileAction(action: ReconcileAction): Promise<void> {
    try {
      if (action.type === 'create') {
        await this.containerProcessor.process(action.container, 'reconcile');
      } else {
        this.log.info({
          action: 'orphaned_proxy_host',
          proxy_host_id: action.proxyHost.id,
          domain: action.proxyHost.domain_names[0],
          cleanup_behavior: action.cleanupBehavior,
          result: 'skipped',
          trigger: 'reconcile',
        });
      }
    } catch (err) {
      const code = err instanceof AppError ? err.code : ErrorCode.UNKNOWN_ERROR;
      this.log.warn({
        action: 'reconcile_action_error',
        error_code: code,
        trigger: 'reconcile',
        err: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async handleEvent(event: DockerEvent): Promise<void> {
    if (!event.id) return;
    try {
      if (event.action === 'start') {
        const info = await this.dockerClient.inspectContainer(event.id);
        await this.containerProcessor.process(info, 'event');
      } else if (event.action === 'destroy' || event.action === 'remove') {
        this.log.info({
          action: 'container_removed',
          container_id: event.id,
          cleanup_behavior: 'none',
          result: 'skipped',
        });
      }
    } catch (err) {
      this.log.warn(
        {
          action: 'event_handler_error',
          container_id: event.id,
          trigger: 'event',
          err: {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
        },
        'Error processing Docker event',
      );
    }
  }

  stop(): void {
    this.shutdownSignal = true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlightOps]);
  }
}

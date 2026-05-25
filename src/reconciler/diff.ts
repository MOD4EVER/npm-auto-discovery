import type { ContainerInspect } from '../types/docker.js';
import type { ProxyHost } from '../types/npm-api.js';
import { parseContainerConfig } from './parse-container-config.js';

export type CleanupBehavior = 'none';

export interface CreateAction {
  type: 'create';
  container: ContainerInspect;
}

export interface CleanupAction {
  type: 'cleanup';
  proxyHost: ProxyHost;
  cleanupBehavior: CleanupBehavior;
}

export type ReconcileAction = CreateAction | CleanupAction;

export function diffState(
  containers: ContainerInspect[],
  proxyHosts: ProxyHost[],
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const managedDomains = new Set<string>();
  const containersNeedingCreate = new Set<string>();

  for (const container of containers) {
    const config = parseContainerConfig(container.Config.Env);
    if (!config) continue;
    for (const domain of config.domains) {
      managedDomains.add(domain);
      const exists = proxyHosts.some((h) => h.domain_names.includes(domain));
      if (!exists && !containersNeedingCreate.has(container.Id)) {
        containersNeedingCreate.add(container.Id);
        actions.push({ type: 'create', container });
      }
    }
  }

  for (const proxyHost of proxyHosts) {
    if (proxyHost.domain_names.every((d) => !managedDomains.has(d))) {
      actions.push({ type: 'cleanup', proxyHost, cleanupBehavior: 'none' });
    }
  }

  return actions;
}

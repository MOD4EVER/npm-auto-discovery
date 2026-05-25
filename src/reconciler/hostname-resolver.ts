import type { ContainerInspect } from '../types/docker.js';
import { DockerConnectionError, ErrorCode } from '../types/errors.js';

function getDockerDnsName(info: ContainerInspect, proxyNetworkName: string): string | null {
  const onSharedNetwork = proxyNetworkName in (info.NetworkSettings?.Networks ?? {});
  if (!onSharedNetwork) return null;
  const name = info.Name?.replace(/^\//, '');
  return name || null;
}

function getContainerIp(info: ContainerInspect, networkName: string): string {
  const networks = info.NetworkSettings?.Networks ?? {};
  const targetNet = networks[networkName];
  if (targetNet?.IPAddress) return targetNet.IPAddress;
  for (const net of Object.values(networks)) {
    if (net.IPAddress) return net.IPAddress;
  }
  throw new DockerConnectionError('No IP found for container', ErrorCode.CONTAINER_NO_IP);
}

export async function resolveForwardHost(
  containerInfo: ContainerInspect,
  mode: 'auto' | 'dns' | 'ip',
  proxyNetworkName: string,
): Promise<string> {
  if (mode === 'ip') {
    return getContainerIp(containerInfo, proxyNetworkName);
  }

  if (mode === 'dns') {
    const dnsName = getDockerDnsName(containerInfo, proxyNetworkName);
    if (!dnsName) {
      throw new DockerConnectionError(
        `Container "${containerInfo.Name}" is not on network "${proxyNetworkName}" — DNS not resolvable`,
        ErrorCode.CONTAINER_NO_IP,
      );
    }
    return dnsName;
  }

  // mode === 'auto': DNS first, IP fallback
  const dnsName = getDockerDnsName(containerInfo, proxyNetworkName);
  if (dnsName) return dnsName;

  return getContainerIp(containerInfo, proxyNetworkName);
}

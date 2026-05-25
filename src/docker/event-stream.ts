import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import type { DockerEvent } from '../types/docker.js';

export const RECONNECT_DELAY_MS = 3_000;

const ALLOWED_ACTIONS = new Set<string>(['start', 'destroy', 'remove']);

interface RawDockerEvent {
  Action?: string;
  id?: string;
  Actor?: { Attributes?: Record<string, string> };
}

export async function createEventStream(
  docker: Dockerode,
  output?: PassThrough,
  log?: Pick<Logger, 'debug'>,
): Promise<NodeJS.ReadableStream> {
  const out = output ?? new PassThrough({ objectMode: true });

  let rawStream: NodeJS.ReadableStream;
  try {
    rawStream = await docker.getEvents({ filters: { type: ['container'] } });
  } catch {
    scheduleReconnect(docker, out);
    return out;
  }

  rawStream.on('data', (chunk: Buffer | string) => {
    try {
      const raw = JSON.parse(chunk.toString()) as RawDockerEvent;
      const action = raw.Action ?? '';
      if (!ALLOWED_ACTIONS.has(action)) return;
      if (!raw.id) {
        log?.debug('Docker event with no container id discarded');
        return;
      }
      const event: DockerEvent = {
        action: action as DockerEvent['action'],
        id: raw.id,
        Actor: { Attributes: raw.Actor?.Attributes ?? {} },
      };
      out.push(event);
    } catch {
      log?.debug('Malformed JSON chunk from Docker event stream discarded');
    }
  });

  let reconnectScheduled = false;
  const scheduleOnce = (): void => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    scheduleReconnect(docker, out);
  };

  rawStream.on('end', scheduleOnce);
  rawStream.on('error', scheduleOnce);

  return out;
}

function scheduleReconnect(docker: Dockerode, out: PassThrough): void {
  setTimeout(() => {
    if (out.destroyed) return;
    void createEventStream(docker, out);
  }, RECONNECT_DELAY_MS);
}

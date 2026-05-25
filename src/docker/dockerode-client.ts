import type { PassThrough } from 'node:stream';
import Dockerode from 'dockerode';
import type { Logger } from 'pino';
import type { ContainerInfo, ContainerInspect, DockerClient } from '../types/docker.js';
import { DockerConnectionError } from '../types/errors.js';
import { createEventStream } from './event-stream.js';

export class DockerodeClient implements DockerClient {
  private outputStream: PassThrough | null = null;

  constructor(
    private readonly docker: Dockerode,
    private readonly log?: Pick<Logger, 'debug'>,
  ) {}

  static async create(
    socketPath = '/var/run/docker.sock',
    log?: Pick<Logger, 'debug'>,
  ): Promise<DockerodeClient> {
    const docker = new Dockerode({ socketPath });
    try {
      await docker.ping();
    } catch (err) {
      throw new DockerConnectionError(`Docker socket unavailable at ${socketPath}: ${String(err)}`);
    }
    return new DockerodeClient(docker, log);
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const raw = await this.docker.listContainers({ all: false });
    return raw.map((c) => ({
      Id: c.Id,
      Names: c.Names,
      Image: c.Image,
      State: c.State,
      NetworkSettings: {
        Networks: Object.fromEntries(
          Object.entries(c.NetworkSettings.Networks).map(([k, v]) => [
            k,
            { IPAddress: v.IPAddress },
          ]),
        ),
      },
    }));
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const raw = await this.docker.getContainer(id).inspect();
    return {
      Id: raw.Id,
      Name: raw.Name,
      Config: { Env: raw.Config.Env ?? null },
      NetworkSettings: {
        Networks: Object.fromEntries(
          Object.entries(raw.NetworkSettings.Networks).map(([k, v]) => [
            k,
            { IPAddress: v.IPAddress },
          ]),
        ),
      },
    };
  }

  async getEventStream(): Promise<NodeJS.ReadableStream> {
    if (!this.outputStream) {
      this.outputStream = (await createEventStream(
        this.docker,
        undefined,
        this.log,
      )) as PassThrough;
    }
    return this.outputStream;
  }

  closeEventStream(): void {
    if (this.outputStream) {
      this.outputStream.destroy();
      this.outputStream = null;
    }
  }
}

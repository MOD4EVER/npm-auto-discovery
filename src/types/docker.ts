export interface ContainerInfo {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Config: {
    Env: string[] | null;
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
}

export interface DockerEvent {
  action: 'start' | 'destroy' | 'remove';
  id: string;
  Actor: {
    Attributes: Record<string, string>;
  };
}

export interface DockerClient {
  listContainers(): Promise<ContainerInfo[]>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  getEventStream(): Promise<NodeJS.ReadableStream>;
  closeEventStream(): void;
}

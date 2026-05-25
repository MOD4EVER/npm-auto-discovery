import axios from 'axios';
import pino from 'pino';
import { checkCliFlags } from './cli.js';
import { parseConfig } from './config.js';
import { DockerodeClient } from './docker/dockerode-client.js';
import { HealthServer } from './health/health-server.js';
import { AxiosNPMApiClient } from './npm-api/axios-npm-api-client.js';
import { TokenManager } from './npm-api/token-manager.js';
import { ContainerProcessor } from './reconciler/container-processor.js';
import { Reconciler } from './reconciler/reconciler.js';
import { AppError, ConfigValidationError, ErrorCode } from './types/errors.js';
import { VERSION } from './version.js';

function extractErrorCode(reason: unknown): string {
  if (reason instanceof AppError) return reason.code;
  return ErrorCode.UNKNOWN_ERROR;
}

async function main(): Promise<void> {
  // Step 1: Parse and validate configuration
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error('Fatal: configuration error —', err.message);
      process.exit(1);
    }
    throw err;
  }

  // Step 2: Initialize structured logger
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

  // Log startup banner (AC: 1 / Task 4)
  log.info({ action: 'service_starting', version: VERSION, node_version: process.version });

  // Create Axios instance and initialize TokenManager
  const axiosInstance = axios.create({ baseURL: config.NPM_URL, timeout: 10_000 });
  const tokenManager = new TokenManager(config, axiosInstance, log);
  try {
    await tokenManager.initialize();
  } catch (err) {
    log.fatal({
      action: 'startup_failed',
      error_code: extractErrorCode(err),
      err: { message: err instanceof Error ? err.message : String(err) },
    });
    process.exit(1);
  }

  // Create DockerodeClient — ONE instance (AC: 1)
  let dockerClient: DockerodeClient;
  try {
    dockerClient = await DockerodeClient.create(undefined, log);
  } catch (err) {
    log.fatal({
      action: 'startup_failed',
      error_code: extractErrorCode(err),
      err: { message: err instanceof Error ? err.message : String(err) },
    });
    process.exit(1);
  }

  // Create AxiosNPMApiClient — ONE instance (AC: 1)
  const npmClient = new AxiosNPMApiClient(config, tokenManager, log);

  // Start HealthServer
  const healthServer = new HealthServer(config, npmClient, dockerClient);
  await healthServer.start();

  // Start Reconciler (startup scan + event loop)
  const containerProcessor = new ContainerProcessor(config, npmClient, log);
  const reconciler = new Reconciler(config, dockerClient, npmClient, containerProcessor, log);

  log.info({ action: 'event_stream_starting' });
  await reconciler.runStartupScan();
  await reconciler.startEventStream();
  reconciler.startReconcileLoop();
  log.info({ action: 'event_stream_ready' });

  // Start token renewal loop
  tokenManager.startRenewalLoop();

  // Graceful shutdown handler (AC: 2, 3)
  let shutdownInProgress = false;
  async function shutdown(signal: string): Promise<void> {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log.info({ action: 'shutdown_initiated', signal });
    reconciler.stop();
    reconciler.stopReconcileLoop();
    await reconciler.drain();
    dockerClient.closeEventStream();
    await healthServer.stop();
    tokenManager.stopRenewalLoop();
    log.info({ action: 'shutdown_complete' });
    process.exit(0);
  }

  // Register SIGTERM / SIGINT handlers (AC: 2, 3)
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Global error handlers — no silent crashes (AC: 4)
  process.on('unhandledRejection', (reason: unknown) => {
    log.fatal({
      level: 'fatal',
      error_code: extractErrorCode(reason),
      err: {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    });
    process.exit(1);
  });

  process.on('uncaughtException', (err: Error) => {
    log.fatal({
      level: 'fatal',
      error_code: extractErrorCode(err),
      err: {
        message: err.message,
        stack: err.stack,
      },
    });
    process.exit(1);
  });
}

if (checkCliFlags(process.argv.slice(2))) {
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});

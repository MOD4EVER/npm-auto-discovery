import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigValidationError } from './types/errors.js';

const configSchema = z.object({
  NPM_URL: z.string().url('NPM_URL must be a valid URL'),
  NPM_EMAIL: z.string().email('NPM_EMAIL must be a valid email'),
  NPM_PASSWORD: z.string().min(1, 'NPM_PASSWORD must not be empty'),
  RECONCILE_INTERVAL_MS: z.coerce.number().positive().default(300_000),
  FORWARD_HOST_MODE: z.enum(['auto', 'dns', 'ip']).default('auto'),
  PROXY_NETWORK_NAME: z.string().default('proxy-network'),
  NPM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NPM_CREDENTIALS_FILE: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

function loadCredentialsFile(filePath: string, env: Record<string, string | undefined>): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(
      `Cannot read credentials file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      'NPM_CREDENTIALS_FILE',
    );
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('=')) continue;
    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed
      .slice(eqIndex + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    if (key === 'NPM_EMAIL' || key === 'NPM_PASSWORD') {
      env[key] = value;
    }
  }
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const merged: Record<string, string | undefined> = { ...env };

  if (merged.NPM_CREDENTIALS_FILE) {
    loadCredentialsFile(merged.NPM_CREDENTIALS_FILE, merged);
  }

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0];
    /* c8 ignore next 3 */
    if (!issue) {
      throw new ConfigValidationError('Configuration validation failed', 'unknown');
    }
    const field = String(issue.path[0]);
    throw new ConfigValidationError(
      `Configuration error: ${issue.message} (field: ${field})`,
      field,
    );
  }
  return result.data;
}

export function safeConfig(config: Config): Record<string, unknown> {
  return {
    NPM_URL: config.NPM_URL,
    NPM_EMAIL: '[REDACTED]',
    NPM_PASSWORD: '[REDACTED]',
    RECONCILE_INTERVAL_MS: config.RECONCILE_INTERVAL_MS,
    FORWARD_HOST_MODE: config.FORWARD_HOST_MODE,
    PROXY_NETWORK_NAME: config.PROXY_NETWORK_NAME,
    NPM_MAX_RETRIES: config.NPM_MAX_RETRIES,
    HEALTH_PORT: config.HEALTH_PORT,
    NPM_CREDENTIALS_FILE: config.NPM_CREDENTIALS_FILE,
  };
}

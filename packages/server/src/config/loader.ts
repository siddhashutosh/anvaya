/**
 * Configuration loading: defaults -> file -> environment, validated, then frozen
 * (FR-8.1, FR-8.2). Invalid configuration aborts startup with a precise message —
 * a server running on config it does not understand is worse than one that
 * refuses to start.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigurationError, ERROR_CODES } from '@anvaya/core';
import { configSchema, type Config } from './schema.js';

export interface LoadConfigOptions {
  readonly file?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: Record<string, unknown>;
}

const DEFAULT_CONFIG_FILE = 'anvaya.config.json';

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const fileConfig = readConfigFile(options.file ?? env.ANVAYA_CONFIG ?? DEFAULT_CONFIG_FILE, options.file !== undefined);
  const envConfig = readEnv(env);

  const merged = deepMerge(deepMerge(fileConfig, envConfig), options.overrides ?? {});

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid configuration: ${details}`, {
      code: ERROR_CODES.CONFIG_INVALID,
      context: { issues: parsed.error.issues.length },
    });
  }
  return deepFreeze(parsed.data);
}

function readConfigFile(path: string, required: boolean): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, unknown>;
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    // An absent default config file is the normal case (NFR-6.2): the server must
    // start with zero configuration. An absent *explicit* file is an error.
    if (missing && !required) return {};
    throw new ConfigurationError(`Could not read config file: ${path}`, {
      code: missing ? ERROR_CODES.CONFIG_MISSING : ERROR_CODES.CONFIG_INVALID,
      cause: e,
      context: { path },
    });
  }
}

/** ANVAYA_<SECTION>_<KEY> — e.g. ANVAYA_SERVER_PORT, ANVAYA_JUDGE_ENABLED. */
function readEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const set = (section: string, key: string, value: unknown): void => {
    const bucket = (out[section] as Record<string, unknown>) ?? {};
    bucket[key] = value;
    out[section] = bucket;
  };

  const mappings: readonly [string, string, string, 'string' | 'number' | 'boolean' | 'csv'][] = [
    ['ANVAYA_HOST', 'server', 'host', 'string'],
    ['ANVAYA_PORT', 'server', 'port', 'number'],
    ['ANVAYA_DEV_MODE', 'server', 'devMode', 'boolean'],
    ['ANVAYA_CORS_ORIGINS', 'server', 'corsOrigins', 'csv'],
    ['ANVAYA_SERVE_UI', 'server', 'serveUi', 'boolean'],
    ['ANVAYA_UI_PATH', 'server', 'uiPath', 'string'],
    ['ANVAYA_DB_PATH', 'storage', 'path', 'string'],
    ['ANVAYA_API_KEY', 'ingest', 'apiKey', 'string'],
    ['ANVAYA_INGEST_QUEUE_SIZE', 'ingest', 'maxQueueSize', 'number'],
    ['ANVAYA_TRACE_IDLE_MS', 'ingest', 'traceIdleMs', 'number'],
    ['ANVAYA_DETECTION_ENABLED', 'detection', 'enabled', 'boolean'],
    ['ANVAYA_JUDGE_ENABLED', 'judge', 'enabled', 'boolean'],
    ['ANVAYA_JUDGE_PROVIDER', 'judge', 'provider', 'string'],
    ['ANVAYA_JUDGE_MODEL', 'judge', 'model', 'string'],
    ['ANVAYA_JUDGE_BASE_URL', 'judge', 'baseUrl', 'string'],
    ['ANVAYA_JUDGE_SAMPLE_RATE', 'judge', 'sampleRate', 'number'],
    ['ANTHROPIC_API_KEY', 'judge', 'apiKey', 'string'],
    ['ANVAYA_ALERTS_WEBHOOK', 'alerts', 'webhookUrl', 'string'],
    ['ANVAYA_LOG_LEVEL', 'logging', 'level', 'string'],
    ['ANVAYA_LOG_FORMAT', 'logging', 'format', 'string'],
    ['ANVAYA_REDACTION_ENABLED', 'redaction', 'enabled', 'boolean'],
    ['ANVAYA_RETENTION_DAYS', 'retention', 'maxAgeDays', 'number'],
  ];

  for (const [envKey, section, key, type] of mappings) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    if (type === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) set(section, key, n);
    } else if (type === 'boolean') {
      set(section, key, raw === 'true' || raw === '1');
    } else if (type === 'csv') {
      set(section, key, raw.split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      set(section, key, raw);
    }
  }

  // A judge API key alone is not consent to spend money — the tier still has to
  // be turned on explicitly (ADR-0003).
  return out;
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const SECRET_KEYS = new Set(['apiKey', 'webhookUrl']);

/** Effective config with every secret masked, for the startup log (LG-12). */
export function redactConfig(config: Config): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = SECRET_KEYS.has(k) && v ? '[REDACTED]' : walk(v);
    }
    return out;
  };
  return walk(config as unknown as Record<string, unknown>);
}

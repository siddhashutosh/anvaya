import { ConfigurationError, ERROR_CODES, type Logger } from '@anvaya/core';
import type { Config } from '../config/schema.js';
import { SqliteStorage } from './sqlite/storage.js';
import { PostgresStorage } from './postgres/storage.js';
import type { Storage } from './types.js';

export type * from './types.js';
export { SqliteStorage } from './sqlite/storage.js';
export { PostgresStorage } from './postgres/storage.js';
export { PostgresClient } from './postgres/client.js';
export type { PgDriver } from './postgres/client.js';

/**
 * Storage factory — the only place a driver is named (FR-5.1, NFR-7.2).
 *
 * `sqlite` is the zero-configuration local default; `postgres` is what a
 * serverless deployment needs, because there is no durable local filesystem.
 */
export function createStorage(config: Config, logger: Logger): Storage {
  if (config.storage.driver === 'postgres') {
    const connectionString = config.storage.connectionString;
    if (!connectionString) {
      throw new ConfigurationError(
        'storage.driver is "postgres" but no connection string was provided (set DATABASE_URL)',
        { code: ERROR_CODES.CONFIG_MISSING },
      );
    }
    return new PostgresStorage({ connectionString, logger });
  }

  return new SqliteStorage({
    path: config.storage.path,
    busyTimeoutMs: config.storage.busyTimeoutMs,
    logger,
  });
}

import type { Logger } from '@anvaya/core';
import type { Config } from '../config/schema.js';
import { SqliteStorage } from './sqlite/storage.js';
import type { Storage } from './types.js';

export type * from './types.js';
export { SqliteStorage } from './sqlite/storage.js';

/**
 * Storage factory. The only place a driver is named — everything downstream sees
 * the `Storage` port (FR-5.1, NFR-7.2).
 */
export function createStorage(config: Config, logger: Logger): Storage {
  return new SqliteStorage({
    path: config.storage.path,
    busyTimeoutMs: config.storage.busyTimeoutMs,
    logger,
  });
}

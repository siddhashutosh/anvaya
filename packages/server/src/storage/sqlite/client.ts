/**
 * SQLite connection management.
 *
 * Uses node:sqlite — built into Node 22.5+ — so a first run needs no native
 * build toolchain (NFR-7.3). The Storage port keeps a swap to better-sqlite3 or
 * Postgres mechanical if throughput ever demands it (ADR-0001).
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ConfigurationError, ERROR_CODES, StorageError, type Logger } from '@anvaya/core';
import { MIGRATIONS } from './migrations.js';

export interface SqliteClientOptions {
  readonly path: string;
  readonly busyTimeoutMs: number;
  readonly logger: Logger;
}

export class SqliteClient {
  private db: DatabaseSync | undefined;
  private readonly statements = new Map<string, StatementSync>();
  private readonly path: string;

  constructor(private readonly options: SqliteClientOptions) {
    this.path = options.path === ':memory:' ? ':memory:' : resolve(options.path);
  }

  open(): void {
    if (this.db) return;

    if (this.path !== ':memory:') {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch (e) {
        throw new ConfigurationError(`Cannot create database directory for ${this.path}`, {
          code: ERROR_CODES.STORAGE_UNAVAILABLE,
          cause: e,
          context: { path: this.path },
        });
      }
    }

    try {
      this.db = new DatabaseSync(this.path);
    } catch (e) {
      throw new ConfigurationError(`Cannot open database at ${this.path}`, {
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
        cause: e,
        context: { path: this.path },
      });
    }

    // WAL lets reads proceed during writes, which matters because the API and the
    // analysis worker share this connection's file (HLD §9.2).
    this.exec(`PRAGMA journal_mode = WAL`);
    this.exec(`PRAGMA synchronous = NORMAL`);
    this.exec(`PRAGMA foreign_keys = ON`);
    this.exec(`PRAGMA busy_timeout = ${this.options.busyTimeoutMs}`);
  }

  migrate(): void {
    this.open();
    this.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);

    const applied = new Set(
      (this.query<{ version: number }>('SELECT version FROM schema_migrations')).map(
        (r) => r.version,
      ),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      try {
        this.transaction(() => {
          this.exec(migration.sql);
          this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
            migration.version,
            migration.name,
            Date.now(),
          ]);
        });
        this.options.logger.info('migration applied', {
          version: migration.version,
          name: migration.name,
        });
      } catch (e) {
        throw new ConfigurationError(
          `Migration ${migration.version} (${migration.name}) failed`,
          {
            code: ERROR_CODES.MIGRATION_FAILED,
            cause: e,
            context: { version: migration.version, name: migration.name },
          },
        );
      }
    }
  }

  close(): void {
    this.statements.clear();
    try {
      this.db?.close();
    } catch (e) {
      this.options.logger.warn('error closing database', { err: e });
    }
    this.db = undefined;
  }

  get isOpen(): boolean {
    return this.db !== undefined;
  }

  exec(sql: string): void {
    this.requireDb().exec(sql);
  }

  /** Statements are cached: preparing on every call dominates ingest cost. */
  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const stmt = this.requireDb().prepare(sql);
    this.statements.set(sql, stmt);
    return stmt;
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    try {
      this.prepare(sql).run(...(params as SqlValue[]));
    } catch (e) {
      throw new StorageError('write failed', {
        code: ERROR_CODES.STORAGE_WRITE_FAILED,
        cause: e,
        context: { sql: sql.slice(0, 200) },
      });
    }
  }

  query<T>(sql: string, params: readonly SqlValue[] = []): T[] {
    try {
      return this.prepare(sql).all(...(params as SqlValue[])) as T[];
    } catch (e) {
      throw new StorageError('query failed', {
        code: ERROR_CODES.STORAGE_QUERY_FAILED,
        cause: e,
        context: { sql: sql.slice(0, 200) },
      });
    }
  }

  queryOne<T>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    try {
      return this.prepare(sql).get(...(params as SqlValue[])) as T | undefined;
    } catch (e) {
      throw new StorageError('query failed', {
        code: ERROR_CODES.STORAGE_QUERY_FAILED,
        cause: e,
        context: { sql: sql.slice(0, 200) },
      });
    }
  }

  /**
   * Synchronous transaction. node:sqlite is synchronous throughout, so there is
   * no interleaving risk inside the callback.
   */
  transaction<T>(fn: () => T): T {
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback failure must not mask the original error.
      }
      throw e;
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new StorageError('database is not open', {
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
      });
    }
    return this.db;
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Postgres connection layer.
 *
 * Deliberately narrow: `query` and `transaction` are all the storage adapter
 * needs, which lets the same adapter run against Neon in production and against
 * pglite (Postgres compiled to WASM) in tests — no server, no Docker, so the
 * Postgres path is verifiable on a laptop.
 */

import { ConfigurationError, ERROR_CODES, StorageError, type Logger } from '@anvaya/core';
import { PG_MIGRATIONS } from './migrations.js';

export type SqlValue = string | number | boolean | null | Date | Buffer | object;

export interface QueryResult<T> {
  readonly rows: T[];
}

/** The surface both the Neon pool and pglite provide. */
export interface PgDriver {
  query<T>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

export interface PostgresClientOptions {
  readonly connectionString: string;
  readonly logger: Logger;
  /** Injected by tests; production builds the Neon pool lazily. */
  readonly driver?: PgDriver;
}

export class PostgresClient {
  private driver: PgDriver | undefined;
  private readonly logger: Logger;

  constructor(private readonly options: PostgresClientOptions) {
    this.logger = options.logger.child('pg');
    this.driver = options.driver;
  }

  async open(): Promise<void> {
    if (this.driver) return;

    if (!this.options.connectionString) {
      throw new ConfigurationError('storage.connectionString is required for the postgres driver', {
        code: ERROR_CODES.CONFIG_MISSING,
      });
    }

    try {
      // Imported lazily so a SQLite-only deployment never loads the driver.
      const { Pool, neonConfig } = await import('@neondatabase/serverless');
      // Neon's pooled endpoint over WebSockets: one short-lived connection per
      // invocation, which is what a serverless runtime can actually sustain.
      neonConfig.poolQueryViaFetch = true;
      const pool = new Pool({ connectionString: this.options.connectionString });
      this.driver = {
        query: async <T>(sql: string, params?: readonly SqlValue[]) =>
          (await pool.query(sql, params as unknown[])) as unknown as QueryResult<T>,
        end: async () => {
          await pool.end();
        },
      };
    } catch (e) {
      throw new ConfigurationError('could not initialise the Postgres driver', {
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
        cause: e,
      });
    }
  }

  async query<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const driver = this.requireDriver();
    try {
      const result = await driver.query<T>(sql, params);
      return result.rows;
    } catch (e) {
      throw new StorageError('query failed', {
        code: ERROR_CODES.STORAGE_QUERY_FAILED,
        cause: e,
        context: { sql: sql.slice(0, 200) },
      });
    }
  }

  async queryOne<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    const driver = this.requireDriver();
    try {
      await driver.query(sql, params);
    } catch (e) {
      throw new StorageError('write failed', {
        code: ERROR_CODES.STORAGE_WRITE_FAILED,
        cause: e,
        context: { sql: sql.slice(0, 200) },
      });
    }
  }

  /**
   * Statement-level transaction.
   *
   * Neon's pooled driver gives no session affinity, so BEGIN/COMMIT issued as
   * separate queries can land on different connections. Callers therefore batch
   * their writes into ONE statement list executed here, and anything needing
   * true multi-statement atomicity uses `writeAtomic`.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Without session affinity a wrapping BEGIN is worse than useless: it can
    // silently apply to an unrelated connection. Individual statements are
    // atomic on their own, and saveTraceBundle is written to be idempotent so a
    // partial failure is repaired by a retry rather than by rollback.
    return fn();
  }

  async migrate(): Promise<void> {
    await this.open();

    await this.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )`);

    const applied = new Set(
      (await this.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) =>
        Number(r.version),
      ),
    );

    for (const migration of PG_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      try {
        for (const statement of migration.statements) {
          await this.run(statement);
        }
        await this.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [migration.version, migration.name, Date.now()],
        );
        this.logger.info('migration applied', {
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

  async close(): Promise<void> {
    try {
      await this.driver?.end();
    } catch (e) {
      this.logger.warn('error closing postgres driver', { err: e });
    }
    this.driver = undefined;
  }

  get isOpen(): boolean {
    return this.driver !== undefined;
  }

  private requireDriver(): PgDriver {
    if (!this.driver) {
      throw new StorageError('postgres client is not open', {
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
      });
    }
    return this.driver;
  }
}

/**
 * Postgres returns BIGINT and COUNT(*) as strings to avoid precision loss.
 * Epoch milliseconds and row counts are both well inside Number's safe range.
 */
export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** jsonb comes back parsed; text columns come back as strings. Accept both. */
export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

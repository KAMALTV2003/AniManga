import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  NexusError,
  asNexusError,
  type ComponentHealth,
  type LifecycleComponent,
} from '@nexus-ai/core';
import BetterSqlite3, { type Database as DatabaseConnection } from 'better-sqlite3';

import { MIGRATIONS, type Migration } from './migrations.js';

export type MigrationMode = 'apply' | 'validate' | 'manual';

export interface SqliteDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly migrationMode?: MigrationMode;
}

export interface MigrationStatus {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly applied: readonly number[];
  readonly pending: readonly number[];
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export class SqliteDatabase implements LifecycleComponent {
  readonly name = 'database';
  readonly #options: Required<Omit<SqliteDatabaseOptions, 'path'>> & { readonly path: string };
  #connection: DatabaseConnection | undefined;

  constructor(options: SqliteDatabaseOptions) {
    if (options.path.trim().length === 0) {
      throw new TypeError('Database path cannot be empty');
    }
    this.#options = {
      path: options.path,
      busyTimeoutMs: options.busyTimeoutMs ?? 5_000,
      migrationMode: options.migrationMode ?? 'apply',
    };
  }

  get path(): string {
    return this.#options.path;
  }

  get connection(): DatabaseConnection {
    if (!this.#connection) {
      throw new NexusError({
        code: 'DATABASE_NOT_STARTED',
        message: 'Database connection is not started',
        component: 'database.sqlite',
        severity: 'high',
      });
    }
    return this.#connection;
  }

  async start(): Promise<void> {
    if (this.#connection) return;
    try {
      if (this.#options.path !== ':memory:') {
        if (existsSync(this.#options.path) && lstatSync(this.#options.path).isSymbolicLink()) {
          throw new NexusError({
            code: 'DATABASE_SYMLINK_BLOCKED',
            message: 'Database path cannot be a symbolic link',
            component: 'database.sqlite',
            severity: 'high',
            details: { path: this.#options.path },
          });
        }
        const directory = dirname(this.#options.path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        try {
          chmodSync(directory, 0o700);
        } catch {
          // Permission hardening is best effort on platforms without POSIX modes.
        }
      }
      const connection = new BetterSqlite3(this.#options.path);
      this.#connection = connection;
      connection.pragma('foreign_keys = ON');
      connection.pragma(`busy_timeout = ${this.#options.busyTimeoutMs}`);
      connection.pragma('trusted_schema = OFF');
      connection.pragma('synchronous = FULL');
      if (this.#options.path !== ':memory:') {
        connection.pragma('journal_mode = WAL');
        try {
          chmodSync(this.#options.path, 0o600);
        } catch {
          // Permission hardening is best effort on platforms without POSIX modes.
        }
      }

      if (this.#options.migrationMode === 'apply') {
        this.applyMigrations();
      } else if (this.#options.migrationMode === 'validate') {
        const status = this.migrationStatus();
        if (status.pending.length > 0) {
          throw new NexusError({
            code: 'DATABASE_MIGRATIONS_PENDING',
            message: `${status.pending.length} database migration(s) are pending`,
            component: 'database.migrations',
            severity: 'high',
            details: { pending: status.pending },
          });
        }
      }
    } catch (error) {
      this.#connection?.close();
      this.#connection = undefined;
      throw asNexusError(error, {
        code: 'DATABASE_START_FAILED',
        component: 'database.sqlite',
        retryable: true,
        severity: 'critical',
        details: { path: this.#options.path },
      });
    }
  }

  async backup(destination: string): Promise<void> {
    if (destination.trim().length === 0 || destination === this.#options.path) {
      throw new TypeError('Backup destination must be a distinct non-empty path');
    }
    if (existsSync(destination)) {
      throw new NexusError({
        code: 'DATABASE_BACKUP_EXISTS',
        message: 'Backup destination already exists',
        component: 'database.sqlite',
        severity: 'high',
        details: { destination },
      });
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    await this.connection.backup(destination);
    try {
      chmodSync(destination, 0o600);
    } catch {
      // Permission hardening is best effort on platforms without POSIX modes.
    }
  }

  async stop(): Promise<void> {
    if (!this.#connection) return;
    this.#connection.close();
    this.#connection = undefined;
  }

  async health(): Promise<ComponentHealth> {
    if (!this.#connection) return { status: 'unhealthy', details: { reason: 'not_started' } };
    try {
      const result = this.#connection.pragma('quick_check', { simple: true }) as string;
      const status = this.migrationStatus();
      if (result !== 'ok' || status.pending.length > 0) {
        return { status: 'unhealthy', details: { quickCheck: result, pending: status.pending } };
      }
      return {
        status: 'healthy',
        details: { path: this.#options.path, schemaVersion: status.currentVersion },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  applyMigrations(): MigrationStatus {
    const database = this.connection;
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const existing = database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as AppliedMigrationRow[];
    this.#verifyAppliedMigrations(existing);
    const appliedVersions = new Set(existing.map((row) => row.version));

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      const apply = database.transaction((current: Migration) => {
        database.exec(current.sql);
        database
          .prepare(
            'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(current.version, current.name, current.checksum, new Date().toISOString());
      });
      apply.immediate(migration);
    }
    return this.migrationStatus();
  }

  migrationStatus(): MigrationStatus {
    const database = this.connection;
    const hasTable = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { readonly present: number } | undefined;
    const rows = hasTable
      ? (database
          .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
          .all() as AppliedMigrationRow[])
      : [];
    this.#verifyAppliedMigrations(rows);
    const applied = rows.map((row) => row.version);
    const appliedSet = new Set(applied);
    const pending = MIGRATIONS.filter((item) => !appliedSet.has(item.version)).map(
      (item) => item.version,
    );
    return {
      currentVersion: applied.at(-1) ?? 0,
      latestVersion: MIGRATIONS.at(-1)?.version ?? 0,
      applied,
      pending,
    };
  }

  #verifyAppliedMigrations(rows: readonly AppliedMigrationRow[]): void {
    for (const row of rows) {
      const expected = MIGRATIONS.find((item) => item.version === row.version);
      if (!expected) {
        throw new NexusError({
          code: 'DATABASE_UNKNOWN_MIGRATION',
          message: `Database contains unknown migration version ${row.version}`,
          component: 'database.migrations',
          severity: 'critical',
          details: { version: row.version, name: row.name },
        });
      }
      if (expected.name !== row.name || expected.checksum !== row.checksum) {
        throw new NexusError({
          code: 'DATABASE_MIGRATION_DRIFT',
          message: `Database migration ${row.version} does not match source`,
          component: 'database.migrations',
          severity: 'critical',
          details: { version: row.version, expectedName: expected.name, actualName: row.name },
        });
      }
    }
  }
}

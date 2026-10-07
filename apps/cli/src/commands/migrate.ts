import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { loadNexusConfig } from '@nexus-ai/config';
import { NexusError } from '@nexus-ai/core';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';

export interface MigrationReport {
  readonly migrated: boolean;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly backupPath: string | null;
  readonly health: string;
}

export async function migrateDatabase(startDir: string): Promise<MigrationReport> {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'manual',
  });
  try {
    await database.start();
    const before = database.migrationStatus();
    if (before.pending.length === 0) {
      new ProjectRepository(database).upsert({
        id: loaded.config.project.id,
        name: loaded.config.project.name,
        rootPath: loaded.projectRoot,
      });
      const health = await database.health();
      return {
        migrated: false,
        fromVersion: before.currentVersion,
        toVersion: before.currentVersion,
        applied: [],
        backupPath: null,
        health: health.status,
      };
    }

    const backupDirectory = path.join(loaded.config.runtime.dataDir, 'backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(backupDirectory);
    const canonicalDataDirectory = await realpath(loaded.config.runtime.dataDir);
    const canonicalBackupDirectory = await realpath(backupDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !canonicalBackupDirectory.startsWith(`${canonicalDataDirectory}${path.sep}`)
    ) {
      throw new NexusError({
        code: 'DATABASE_BACKUP_PATH_UNSAFE',
        component: 'cli.migrate',
        severity: 'high',
        message: 'Database backup directory escapes the configured data directory',
      });
    }
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backupPath = path.join(
      canonicalBackupDirectory,
      `nexus-v${String(before.currentVersion)}-before-v${String(before.latestVersion)}-${timestamp}.db`,
    );
    await database.backup(backupPath);
    const after = database.applyMigrations();
    new ProjectRepository(database).upsert({
      id: loaded.config.project.id,
      name: loaded.config.project.name,
      rootPath: loaded.projectRoot,
    });
    const health = await database.health();
    if (health.status !== 'healthy') {
      throw new NexusError({
        code: 'DATABASE_MIGRATION_HEALTH_FAILED',
        component: 'cli.migrate',
        severity: 'critical',
        message: 'Database failed its health check after migration',
        details: { backupPath, health: health.details },
      });
    }
    return {
      migrated: true,
      fromVersion: before.currentVersion,
      toVersion: after.currentVersion,
      applied: before.pending,
      backupPath,
      health: health.status,
    };
  } finally {
    await database.stop();
  }
}

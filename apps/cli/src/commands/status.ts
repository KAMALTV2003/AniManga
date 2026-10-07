import { loadNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase, SystemRepository, type SystemCounts } from '@nexus-ai/database';

export interface StatusReport {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly version: string;
  readonly environment: string;
  readonly project: { readonly id: string; readonly name: string; readonly root: string };
  readonly database: {
    readonly path: string;
    readonly schemaVersion: number;
    readonly latestSchemaVersion: number;
    readonly health: string;
  };
  readonly counts: SystemCounts;
  readonly checkedAt: string;
}

export async function getStatus(startDir: string): Promise<StatusReport> {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    const health = await database.health();
    const migrations = database.migrationStatus();
    const counts = new SystemRepository(database).counts();
    return {
      status: health.status,
      version: '0.1.0-dev.1',
      environment: loaded.config.environment,
      project: {
        id: loaded.config.project.id,
        name: loaded.config.project.name,
        root: loaded.projectRoot,
      },
      database: {
        path: loaded.config.database.path,
        schemaVersion: migrations.currentVersion,
        latestSchemaVersion: migrations.latestVersion,
        health: health.status,
      },
      counts,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await database.stop();
  }
}

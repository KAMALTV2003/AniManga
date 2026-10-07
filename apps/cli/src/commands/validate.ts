import { loadNexusConfig } from '@nexus-ai/config';
import { NexusError } from '@nexus-ai/core';
import { SqliteDatabase } from '@nexus-ai/database';

export interface ValidationReport {
  readonly valid: true;
  readonly configPath: string;
  readonly sources: readonly string[];
  readonly schemaVersion: number;
  readonly databaseCheck: string;
  readonly validatedAt: string;
}

export async function validateInstallation(startDir: string): Promise<ValidationReport> {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    const health = await database.health();
    if (health.status !== 'healthy') {
      throw new NexusError({
        code: 'VALIDATION_DATABASE_UNHEALTHY',
        message: 'Database validation did not pass',
        component: 'cli.validate',
        severity: 'critical',
        ...(health.details ? { details: health.details } : {}),
      });
    }
    return {
      valid: true,
      configPath: loaded.configPath,
      sources: loaded.sources,
      schemaVersion: database.migrationStatus().currentVersion,
      databaseCheck: 'ok',
      validatedAt: new Date().toISOString(),
    };
  } finally {
    await database.stop();
  }
}

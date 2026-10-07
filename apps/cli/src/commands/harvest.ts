import path from 'node:path';

import { loadNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase } from '@nexus-ai/database';
import { HarvestService, type HarvestRequest } from '@nexus-ai/harvest';

export async function harvestSkill(startDir: string, request: Omit<HarvestRequest, 'projectId'>) {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    return await new HarvestService({
      database,
      dataDirectory: loaded.config.runtime.dataDir,
      temporaryDirectory: path.join(loaded.config.runtime.dataDir, 'tmp'),
    }).harvest({ ...request, projectId: loaded.config.project.id });
  } finally {
    await database.stop();
  }
}

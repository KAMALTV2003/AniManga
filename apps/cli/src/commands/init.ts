import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { createDefaultConfig, projectConfigNames, serializeConfig } from '@nexus-ai/config';
import { NexusError } from '@nexus-ai/core';
import { ProjectRepository, SqliteDatabase, SystemRepository } from '@nexus-ai/database';

export interface InitResult {
  readonly status: 'initialized';
  readonly projectId: string;
  readonly projectRoot: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly gitignoreUpdated: boolean;
}

function ensureGitignore(projectRoot: string): boolean {
  const path = join(projectRoot, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const hasEntry = existing.split(/\r?\n/u).some((line) => line.trim() === '.nexus/');
  if (hasEntry) return false;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}\n# NEXUS local state\n.nexus/\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  return true;
}

export async function initializeProject(targetDirectory: string): Promise<InitResult> {
  const requestedRoot = resolve(targetDirectory);
  if (!existsSync(requestedRoot) || !lstatSync(requestedRoot).isDirectory()) {
    throw new NexusError({
      code: 'INIT_TARGET_INVALID',
      message: `Initialization target is not a directory: ${requestedRoot}`,
      component: 'cli.init',
      severity: 'high',
    });
  }
  const projectRoot = realpathSync(requestedRoot);
  for (const configName of projectConfigNames()) {
    const existing = join(projectRoot, configName);
    if (existsSync(existing)) {
      throw new NexusError({
        code: 'INIT_ALREADY_CONFIGURED',
        message: `NEXUS is already configured at ${existing}`,
        component: 'cli.init',
        severity: 'medium',
      });
    }
  }

  const config = createDefaultConfig(projectRoot, basename(projectRoot));
  const configPath = join(projectRoot, 'nexus.config.yaml');
  const databasePath = join(projectRoot, '.nexus', 'nexus.db');
  mkdirSync(join(projectRoot, '.nexus'), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, serializeConfig(config), { encoding: 'utf8', flag: 'wx', mode: 0o644 });

  const database = new SqliteDatabase({ path: databasePath, migrationMode: 'apply' });
  try {
    await database.start();
    new ProjectRepository(database).upsert({
      id: config.project.id,
      name: config.project.name,
      rootPath: projectRoot,
    });
    const system = new SystemRepository(database);
    system.setMetadata('nexus.version', '0.1.0-dev.1');
    system.setMetadata('project.initialized_at', new Date().toISOString());
    const migrationStatus = database.migrationStatus();
    const gitignoreUpdated = ensureGitignore(projectRoot);
    return {
      status: 'initialized',
      projectId: config.project.id,
      projectRoot,
      configPath,
      databasePath,
      schemaVersion: migrationStatus.currentVersion,
      gitignoreUpdated,
    };
  } catch (error) {
    throw new NexusError({
      code: 'INIT_DATABASE_FAILED',
      message:
        'Configuration was created, but database initialization failed; fix the reported cause and run nexus validate',
      component: 'cli.init',
      severity: 'critical',
      details: {
        configPath,
        databasePath,
        reason: error instanceof Error ? error.message : String(error),
      },
      cause: error,
    });
  } finally {
    await database.stop();
  }
}

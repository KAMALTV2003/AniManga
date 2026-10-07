import path from 'node:path';

import { loadNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase } from '@nexus-ai/database';
import {
  SkillRegistry,
  analyzeSkillSource,
  runSkillStructuralTests,
  type InstallSkillOptions,
  type SkillAnalysis,
} from '@nexus-ai/skills';

export interface SkillAnalysisReport extends Omit<SkillAnalysis, 'body'> {
  readonly source: {
    readonly type: 'local-directory' | 'zip-archive' | 'https-archive' | 'git-repository';
    readonly locator: string;
    readonly archiveSha256: string | null;
  };
  readonly instructionLines: number | null;
  readonly importedCodeExecuted: false;
}

export async function analyzeSkill(
  startDir: string,
  sourcePath: string,
): Promise<SkillAnalysisReport> {
  const loaded = loadNexusConfig({ startDir });
  const result = await analyzeSkillSource(
    sourcePath,
    path.join(loaded.config.runtime.dataDir, 'tmp'),
  );
  try {
    const { body, ...analysis } = result.analysis;
    return {
      ...analysis,
      source: {
        type: result.source.type,
        locator: result.source.locator,
        archiveSha256: result.source.archiveSha256,
      },
      instructionLines: body === null ? null : body.split(/\r?\n/u).length,
      importedCodeExecuted: false,
    };
  } finally {
    await result.source.cleanup();
  }
}

export async function testSkill(startDir: string, sourcePath: string) {
  const loaded = loadNexusConfig({ startDir });
  const result = await analyzeSkillSource(
    sourcePath,
    path.join(loaded.config.runtime.dataDir, 'tmp'),
  );
  try {
    return runSkillStructuralTests(result.analysis);
  } finally {
    await result.source.cleanup();
  }
}

export async function installSkill(
  startDir: string,
  sourcePath: string,
  options: Omit<InstallSkillOptions, 'projectId'>,
) {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  const result = await analyzeSkillSource(
    sourcePath,
    path.join(loaded.config.runtime.dataDir, 'tmp'),
  );
  try {
    await database.start();
    const registry = new SkillRegistry(database, loaded.config.runtime.dataDir);
    return await registry.install(result, {
      ...options,
      projectId: loaded.config.project.id,
    });
  } finally {
    await database.stop();
    await result.source.cleanup();
  }
}

export async function searchSkills(startDir: string, query: string, limit: number) {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    return new SkillRegistry(database, loaded.config.runtime.dataDir).search(
      query,
      limit,
      loaded.config.project.id,
    );
  } finally {
    await database.stop();
  }
}

export async function verifySkill(startDir: string, skillId: string, version?: string) {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    const result = await new SkillRegistry(database, loaded.config.runtime.dataDir).verifyInstalled(
      skillId,
      version,
    );
    const { body, ...analysis } = result.analysis;
    void body;
    return { analysis, structuralTests: result.structuralTests };
  } finally {
    await database.stop();
  }
}

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deterministicId } from '@nexus-ai/core';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';
import {
  SkillRegistry,
  analyzeSkillDirectory,
  analyzeSkillSource,
  runSkillStructuralTests,
} from '@nexus-ai/skills';
import { afterEach, describe, expect, it } from 'vitest';

import { createValidSkill } from './helpers.js';

const temporaryDirectories: string[] = [];
const databases: SqliteDatabase[] = [];

async function createRegistry(): Promise<{
  readonly registry: SkillRegistry;
  readonly database: SqliteDatabase;
  readonly dataDirectory: string;
}> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-registry-'));
  temporaryDirectories.push(dataDirectory);
  const database = new SqliteDatabase({ path: ':memory:', migrationMode: 'apply' });
  databases.push(database);
  await database.start();
  new ProjectRepository(database).upsert({
    id: 'prj_0123456789abcdef',
    name: 'Test project',
    rootPath: dataDirectory,
  });
  return { registry: new SkillRegistry(database, dataDirectory), database, dataDirectory };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('immutable Skill registry', () => {
  it('installs canonical metadata, provenance, inventory, search, and disabled script permissions', async () => {
    const { registry, database, dataDirectory } = await createRegistry();
    const sourceParent = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-source-'));
    temporaryDirectories.push(sourceParent);
    const root = await createValidSkill(sourceParent, 'release-notes', { executableScript: true });
    const analyzed = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));

    const installed = await registry.install(analyzed, {
      projectId: 'prj_0123456789abcdef',
      sourceCommit: 'abc123',
      changelog: 'Initial release',
    });

    expect(installed.installed).toBe(true);
    expect(installed.metadata.version).toBe('1.0.0');
    expect(installed.metadata.risk).toBe('unknown');
    expect(installed.metadata.scores.quality).toBeNull();
    expect(installed.metadata.source.commit).toBe('abc123');
    expect(installed.structuralTests.importedCodeExecuted).toBe(false);
    expect(
      JSON.parse(await readFile(path.join(installed.artifactPath, 'metadata.json'), 'utf8')),
    ).toEqual(installed.metadata);
    const scriptMode = (await stat(path.join(installed.artifactPath, 'scripts', 'never-run.sh')))
      .mode;
    expect(scriptMode & 0o111).toBe(0);
    const canonicalRoundTrip = await analyzeSkillDirectory(installed.artifactPath);
    expect(canonicalRoundTrip.valid).toBe(true);
    expect(
      canonicalRoundTrip.inventory.find((resource) => resource.kind === 'script')
        ?.executableInSource,
    ).toBe(true);

    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM skill_files').get()).toEqual({
      count: 3,
    });
    expect(
      database.connection.prepare('SELECT COUNT(*) AS count FROM provenance_records').get(),
    ).toEqual({ count: 1 });
    expect(registry.search('release notes')).toHaveLength(1);
    expect(registry.search('release notes', 20, 'prj_0123456789abcdef')).toHaveLength(1);
    expect(registry.search('release notes', 20, 'prj_ffffffffffffffff')).toHaveLength(0);
    expect((await registry.verifyInstalled(installed.skillId)).structuralTests.passed).toBe(true);

    const idempotent = await registry.install(analyzed, {
      projectId: 'prj_0123456789abcdef',
      sourceCommit: 'abc123',
    });
    expect(idempotent.installed).toBe(false);
    expect(idempotent.versionId).toBe(installed.versionId);
    await analyzed.source.cleanup();
  });

  it('enforces immutable version content and metadata', async () => {
    const { registry, dataDirectory } = await createRegistry();
    const sourceParent = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-source-'));
    temporaryDirectories.push(sourceParent);
    const root = await createValidSkill(sourceParent, 'immutable-skill');
    const first = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));
    await registry.install(first, { projectId: 'prj_0123456789abcdef' });

    await writeFile(path.join(root, 'references', 'guide.md'), 'changed content\n');
    const changed = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));
    await expect(
      registry.install(changed, { projectId: 'prj_0123456789abcdef' }),
    ).rejects.toMatchObject({ code: 'SKILL_VERSION_IMMUTABLE' });

    const originalAgainRoot = await createValidSkill(
      await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-copy-')),
      'immutable-skill',
    );
    temporaryDirectories.push(path.dirname(originalAgainRoot));
    const originalAgain = await analyzeSkillSource(
      originalAgainRoot,
      path.join(dataDirectory, 'tmp'),
    );
    await expect(
      registry.install(originalAgain, {
        projectId: 'prj_0123456789abcdef',
        author: 'Different Author',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_VERSION_METADATA_IMMUTABLE' });
  });

  it('requires a version, advances current SemVer, and detects artifact tampering', async () => {
    const { registry, database, dataDirectory } = await createRegistry();
    const sourceParent = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-source-'));
    temporaryDirectories.push(sourceParent);
    const root = await createValidSkill(sourceParent, 'versioned-skill', { version: null });
    const unversioned = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));
    await expect(
      registry.install(unversioned, { projectId: 'prj_0123456789abcdef' }),
    ).rejects.toMatchObject({ code: 'SKILL_VERSION_REQUIRED' });

    const first = await registry.install(unversioned, {
      projectId: 'prj_0123456789abcdef',
      version: '1.0.0',
    });
    await writeFile(
      path.join(root, 'SKILL.md'),
      (await readFile(path.join(root, 'SKILL.md'), 'utf8')).replace(
        '# Instructions',
        '# Instructions\n\nSecond release.',
      ),
    );
    const secondSource = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));
    const second = await registry.install(secondSource, {
      projectId: 'prj_0123456789abcdef',
      version: '1.1.0',
    });
    expect(second.version).toBe('1.1.0');
    const current = database.connection
      .prepare(
        `SELECT sv.version FROM skills s JOIN skill_versions sv ON sv.id = s.current_version_id
         WHERE s.id = ?`,
      )
      .get(second.skillId);
    expect(current).toEqual({ version: '1.1.0' });

    const metadataPath = path.join(second.artifactPath, 'metadata.json');
    await chmod(metadataPath, 0o600);
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...second.metadata, updatedAt: new Date(Date.now() + 1_000).toISOString() }, null, 2)}\n`,
    );
    await expect(registry.verifyInstalled(second.skillId)).rejects.toMatchObject({
      code: 'SKILL_METADATA_DRIFT',
    });
    await writeFile(metadataPath, `${JSON.stringify(second.metadata, null, 2)}\n`);
    await chmod(metadataPath, 0o400);

    const guide = path.join(second.artifactPath, 'references', 'guide.md');
    await chmod(guide, 0o600);
    await writeFile(guide, 'tampered\n');
    await expect(registry.verifyInstalled(second.skillId)).rejects.toMatchObject({
      code: 'SKILL_INTEGRITY_FAILED',
    });
    expect(first.skillId).toBe(second.skillId);
  });

  it('rejects unknown projects, invalid version overrides, and empty searches', async () => {
    const { registry, dataDirectory } = await createRegistry();
    const sourceParent = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-source-'));
    temporaryDirectories.push(sourceParent);
    const root = await createValidSkill(sourceParent, 'validation-skill');
    const analyzed = await analyzeSkillSource(root, path.join(dataDirectory, 'tmp'));
    await expect(
      registry.install(analyzed, { projectId: 'prj_ffffffffffffffff' }),
    ).rejects.toMatchObject({
      code: 'SKILL_PROJECT_NOT_FOUND',
    });
    await expect(
      registry.install(analyzed, {
        projectId: 'prj_0123456789abcdef',
        version: 'not-semver',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_VERSION_INVALID' });

    const skillId = deterministicId('skill', 'prj_0123456789abcdef:validation-skill');
    const skillRoot = path.join(dataDirectory, 'skills', skillId);
    await mkdir(skillRoot, { recursive: true });
    const lockPath = path.join(skillRoot, '.1.0.0.install.lock');
    await writeFile(lockPath, 'other-installer');
    await expect(
      registry.install(analyzed, { projectId: 'prj_0123456789abcdef' }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_IN_PROGRESS' });
    expect(await readFile(lockPath, 'utf8')).toBe('other-installer');

    expect(() => registry.search('---')).toThrow(RangeError);
    expect(() => registry.search('word '.repeat(21))).toThrow(RangeError);
    expect(() => registry.search('x'.repeat(513))).toThrow(RangeError);
    expect(() => registry.search('valid', 101)).toThrow(RangeError);
    expect(runSkillStructuralTests(analyzed.analysis).passed).toBe(true);
  });
});

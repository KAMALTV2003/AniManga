import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';
import {
  analyzeSkillDirectory,
  validateSkillRelativePath,
  DEFAULT_SKILL_LIMITS,
} from '@nexus-ai/skills';
import { afterEach, describe, expect, it } from 'vitest';

import { createValidSkill } from './helpers.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-analysis-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Skill analysis', () => {
  it('strictly parses, inventories, and deterministically hashes an Agent Skill', async () => {
    const parent = await temporaryDirectory();
    const root = await createValidSkill(parent, 'release-notes', { executableScript: true });

    const first = await analyzeSkillDirectory(root);
    const second = await analyzeSkillDirectory(root);

    expect(first.valid).toBe(true);
    expect(first.standardCompliant).toBe(true);
    expect(first.frontmatter?.name).toBe('release-notes');
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.inventory.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'references/guide.md',
      'scripts/never-run.sh',
    ]);
    expect(first.inventory.find((entry) => entry.kind === 'script')?.executableInSource).toBe(true);
    expect(first.referencedPaths).toEqual(['references/guide.md']);
    expect(first.suggestedVersion).toBe('1.0.0');
  });

  it('reports strict frontmatter, naming, body, and reference defects', async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, 'wrong-directory');
    await mkdir(root);
    await writeFile(
      path.join(root, 'SKILL.md'),
      `---\nname: declared-name\ndescription: Does work\nunknown-field: rejected\n---\n`,
    );

    const analysis = await analyzeSkillDirectory(root);
    expect(analysis.valid).toBe(false);
    expect(analysis.issues.map((issue) => issue.code)).toContain('SKILL_FRONTMATTER_UNKNOWN_FIELD');

    await writeFile(
      path.join(root, 'SKILL.md'),
      `---\nname: wrong-directory\ndescription: Does work when requested.\n---\nRead [missing](references/missing.md) and [unsafe](../outside.md).\n`,
    );
    const references = await analyzeSkillDirectory(root);
    expect(references.valid).toBe(false);
    expect(references.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['SKILL_REFERENCE_UNSAFE', 'SKILL_REFERENCE_MISSING']),
    );
  });

  it('rejects malformed YAML, aliases, invalid versions, and invalid UTF-8', async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, 'strict-skill');
    await mkdir(root);
    await writeFile(
      path.join(root, 'SKILL.md'),
      `---\nname: strict-skill\nname: duplicate\ndescription: Use when strict parsing is needed.\n---\nBody\n`,
    );
    expect((await analyzeSkillDirectory(root)).issues[0]?.code).toBe('SKILL_FRONTMATTER_YAML');

    await writeFile(
      path.join(root, 'SKILL.md'),
      `---\nname: &name strict-skill\ndescription: *name\n---\nBody\n`,
    );
    expect((await analyzeSkillDirectory(root)).issues.map((issue) => issue.code)).toContain(
      'SKILL_FRONTMATTER_ALIAS',
    );

    await writeFile(
      path.join(root, 'SKILL.md'),
      `---\nname: strict-skill\ndescription: Use when strict parsing is needed.\nmetadata:\n  version: v1\n---\nBody\n`,
    );
    expect((await analyzeSkillDirectory(root)).issues.map((issue) => issue.code)).toContain(
      'SKILL_VERSION_INVALID',
    );

    await writeFile(path.join(root, 'SKILL.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(analyzeSkillDirectory(root)).rejects.toMatchObject({
      code: 'SKILL_TEXT_ENCODING',
    });
  });

  it('rejects local symlinks and portable path collisions', async () => {
    const parent = await temporaryDirectory();
    const root = await createValidSkill(parent, 'unsafe-skill');
    const outside = path.join(parent, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(root, 'references', 'linked.md'));
    await expect(analyzeSkillDirectory(root)).rejects.toMatchObject({
      code: 'SKILL_SYMLINK_REJECTED',
    });

    await rm(path.join(root, 'references', 'linked.md'));
    await writeFile(path.join(root, 'Readme.md'), 'one');
    await writeFile(path.join(root, 'README.md'), 'two');
    await expect(analyzeSkillDirectory(root)).rejects.toMatchObject({
      code: 'SKILL_PATH_COLLISION',
    });
  });

  it('validates reserved metadata and enforces configured package limits', async () => {
    const parent = await temporaryDirectory();
    const root = await createValidSkill(parent, 'bounded-skill');
    await writeFile(path.join(root, 'metadata.json'), '{}');
    const invalidMetadata = await analyzeSkillDirectory(root);
    expect(invalidMetadata.valid).toBe(false);
    expect(invalidMetadata.issues.map((issue) => issue.code)).toContain('SKILL_METADATA_SCHEMA');

    await rm(path.join(root, 'metadata.json'));
    await expect(
      analyzeSkillDirectory(root, {
        limits: { ...DEFAULT_SKILL_LIMITS, maxFileBytes: 4 },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_LIMIT' });
  });
});

describe('portable Skill paths', () => {
  it.each([
    '../escape',
    '/absolute',
    'C:\\escape',
    'a\\b',
    'a//b',
    'NUL.txt',
    'trailing.',
    '.git/config',
  ])('rejects unsafe path %s', (candidate) => {
    expect(() => validateSkillRelativePath(candidate, DEFAULT_SKILL_LIMITS)).toThrow(NexusError);
  });

  it('requires NFC Unicode and emits an NFKC case-folded collision key', () => {
    expect(() => validateSkillRelativePath('references/Café.md', DEFAULT_SKILL_LIMITS)).toThrow(
      NexusError,
    );
    const result = validateSkillRelativePath('references/Ａ.md', DEFAULT_SKILL_LIMITS);
    expect(result.path).toBe('references/Ａ.md');
    expect(result.collisionKey).toBe('references/a.md');
  });
});

import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeSkillSource,
  DEFAULT_SKILL_LIMITS,
  extractSkillArchive,
  loadSkillSource,
} from '@nexus-ai/skills';
import { afterEach, describe, expect, it } from 'vitest';

import { writeRawZip, writeZip } from './helpers.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-archive-'));
  temporaryDirectories.push(directory);
  return directory;
}

const manifest = `---
name: zip-skill
description: Process ZIP input safely. Use when testing archive Skills.
metadata:
  version: 1.0.0
---
# Instructions

Read [the reference](references/guide.md).
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bounded ZIP Skill adapter', () => {
  it('analyzes flat and single-directory archives without executing scripts', async () => {
    const root = await temporaryDirectory();
    const flat = path.join(root, 'flat.zip');
    await writeZip(flat, [
      { name: 'SKILL.md', data: manifest },
      { name: 'references/guide.md', data: 'Reference\n' },
      { name: 'scripts/never-run.sh', data: '#!/bin/sh\nexit 87\n', mode: 0o100755 },
    ]);
    const flatResult = await analyzeSkillSource(flat, path.join(root, 'tmp'));
    expect(flatResult.analysis.valid).toBe(true);
    expect(flatResult.source.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      flatResult.analysis.inventory.find((file) => file.kind === 'script')?.executableInSource,
    ).toBe(true);
    const extractedRoot = flatResult.source.root;
    await flatResult.source.cleanup();
    await expect(
      import('node:fs/promises').then(({ access }) => access(extractedRoot)),
    ).rejects.toThrow();

    const nested = path.join(root, 'nested.zip');
    await writeZip(nested, [
      { name: 'zip-skill/SKILL.md', data: manifest },
      { name: 'zip-skill/references/guide.md', data: 'Reference\n' },
    ]);
    const nestedResult = await analyzeSkillSource(nested, path.join(root, 'tmp'));
    expect(nestedResult.analysis.valid).toBe(true);
    expect(path.basename(nestedResult.source.root)).toBe('zip-skill');
    await nestedResult.source.cleanup();
  });

  it.each([
    {
      label: 'traversal',
      entry: { name: '../escape', data: Buffer.from('x') },
      code: 'SKILL_ARCHIVE_MALFORMED',
    },
    {
      label: 'absolute path',
      entry: { name: '/escape', data: Buffer.from('x') },
      code: 'SKILL_ARCHIVE_MALFORMED',
    },
    {
      label: 'backslash path',
      entry: { name: 'a\\b', data: Buffer.from('x') },
      code: 'SKILL_ARCHIVE_MALFORMED',
    },
    {
      label: 'symbolic link',
      entry: { name: 'link', data: Buffer.from('target'), unixMode: 0o120777 },
      code: 'SKILL_SYMLINK_REJECTED',
    },
    {
      label: 'encrypted entry',
      entry: {
        name: 'secret',
        data: Buffer.alloc(13),
        flags: 1,
        declaredCompressedSize: 13,
        declaredUncompressedSize: 1,
      },
      code: 'SKILL_ARCHIVE_ENCRYPTED',
    },
    {
      label: 'unsupported compression',
      entry: { name: 'odd', data: Buffer.alloc(0), compressionMethod: 12 },
      code: 'SKILL_ARCHIVE_UNSUPPORTED',
    },
  ])('rejects $label entries', async ({ entry, code }) => {
    const root = await temporaryDirectory();
    const archive = path.join(root, 'malicious.zip');
    await writeRawZip(archive, [entry]);
    await expect(
      extractSkillArchive(archive, path.join(root, 'extract'), DEFAULT_SKILL_LIMITS),
    ).rejects.toMatchObject({ code });
  });

  it('rejects duplicate, case-colliding, oversized, and high-ratio entries', async () => {
    const duplicateRoot = await temporaryDirectory();
    const duplicate = path.join(duplicateRoot, 'duplicate.zip');
    await writeRawZip(duplicate, [
      { name: 'same.txt', data: Buffer.from('a') },
      { name: 'same.txt', data: Buffer.from('b') },
    ]);
    await expect(
      extractSkillArchive(duplicate, path.join(duplicateRoot, 'extract'), DEFAULT_SKILL_LIMITS),
    ).rejects.toMatchObject({ code: 'SKILL_DUPLICATE_PATH' });

    const collisionRoot = await temporaryDirectory();
    const collision = path.join(collisionRoot, 'collision.zip');
    await writeRawZip(collision, [
      { name: 'Readme.md', data: Buffer.from('a') },
      { name: 'README.md', data: Buffer.from('b') },
    ]);
    await expect(
      extractSkillArchive(collision, path.join(collisionRoot, 'extract'), DEFAULT_SKILL_LIMITS),
    ).rejects.toMatchObject({ code: 'SKILL_PATH_COLLISION' });

    const unicodeRoot = await temporaryDirectory();
    const unicode = path.join(unicodeRoot, 'unicode-collision.zip');
    await writeRawZip(unicode, [
      { name: 'A.md', data: Buffer.from('a'), flags: 0x800 },
      { name: 'Ａ.md', data: Buffer.from('b'), flags: 0x800 },
    ]);
    await expect(
      extractSkillArchive(unicode, path.join(unicodeRoot, 'extract'), DEFAULT_SKILL_LIMITS),
    ).rejects.toMatchObject({ code: 'SKILL_PATH_COLLISION' });

    const oversizedRoot = await temporaryDirectory();
    const oversized = path.join(oversizedRoot, 'oversized.zip');
    await writeRawZip(oversized, [
      {
        name: 'large.bin',
        declaredCompressedSize: 20,
        declaredUncompressedSize: 20,
        data: Buffer.alloc(20),
      },
    ]);
    await expect(
      extractSkillArchive(oversized, path.join(oversizedRoot, 'extract'), {
        ...DEFAULT_SKILL_LIMITS,
        maxFileBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_LIMIT' });

    const ratioRoot = await temporaryDirectory();
    const ratio = path.join(ratioRoot, 'ratio.zip');
    await writeZip(ratio, [{ name: 'zeros.bin', data: Buffer.alloc(128 * 1024), compress: true }]);
    await expect(
      extractSkillArchive(ratio, path.join(ratioRoot, 'extract'), {
        ...DEFAULT_SKILL_LIMITS,
        maxCompressionRatio: 10,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_COMPRESSION_RATIO' });
  });

  it('rejects ambiguous archive layouts and archive symlink sources', async () => {
    const root = await temporaryDirectory();
    const archive = path.join(root, 'ambiguous.zip');
    await writeZip(archive, [
      { name: 'one/SKILL.md', data: manifest.replace('zip-skill', 'one') },
      { name: 'two/SKILL.md', data: manifest.replace('zip-skill', 'two') },
    ]);
    await expect(
      extractSkillArchive(archive, path.join(root, 'extract'), DEFAULT_SKILL_LIMITS),
    ).rejects.toMatchObject({ code: 'SKILL_ARCHIVE_LAYOUT' });

    const linkedArchive = path.join(root, 'linked.zip');
    await symlink(archive, linkedArchive);
    await expect(loadSkillSource(linkedArchive, path.join(root, 'tmp'))).rejects.toMatchObject({
      code: 'SKILL_SYMLINK_REJECTED',
    });
  });
});

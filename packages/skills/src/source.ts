import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { NexusError } from '@nexus-ai/core';

import { analyzeSkillDirectory } from './analyzer.js';
import { extractSkillArchive } from './archive.js';
import { DEFAULT_SKILL_LIMITS, type SkillPackageLimits } from './limits.js';
import type { SkillAnalysis } from './schemas.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface LoadedSkillSource {
  readonly root: string;
  readonly type: 'local-directory' | 'zip-archive' | 'https-archive' | 'git-repository';
  readonly locator: string;
  readonly archiveSha256: string | null;
  readonly enforceDirectoryName: boolean;
  readonly executablePaths: ReadonlySet<string>;
  cleanup(): Promise<void>;
}

export interface AnalyzedSkillSource {
  readonly source: LoadedSkillSource;
  readonly analysis: SkillAnalysis;
}

export async function loadSkillSource(
  sourcePath: string,
  temporaryParent: string,
  limits: Readonly<SkillPackageLimits> = DEFAULT_SKILL_LIMITS,
): Promise<LoadedSkillSource> {
  const absoluteSource = path.resolve(sourcePath);
  const stat = await lstat(absoluteSource).catch((error: unknown) => {
    throw sourceError(
      'SKILL_SOURCE_NOT_FOUND',
      `Skill source does not exist: ${absoluteSource}`,
      error,
    );
  });
  if (stat.isSymbolicLink()) {
    throw sourceError('SKILL_SYMLINK_REJECTED', 'Skill source itself must not be a symbolic link');
  }
  const locator = await realpath(absoluteSource);
  if (stat.isDirectory()) {
    return {
      root: locator,
      type: 'local-directory',
      locator,
      archiveSha256: null,
      enforceDirectoryName: true,
      executablePaths: new Set(),
      async cleanup() {},
    };
  }
  if (!stat.isFile()) {
    throw sourceError('SKILL_SOURCE_INVALID', 'Skill source must be a directory or ZIP file');
  }

  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const canonicalTemporaryParent = await realpath(temporaryParent);
  const workspace = await mkdtemp(path.join(canonicalTemporaryParent, 'skill-import-'));
  try {
    const snapshotPath = path.join(workspace, 'source.zip');
    const archiveSha256 = await snapshotArchive(locator, snapshotPath, limits.maxArchiveBytes);
    const extracted = await extractSkillArchive(
      snapshotPath,
      path.join(workspace, 'extracted'),
      limits,
    );
    let cleaned = false;
    return {
      root: extracted.root,
      type: 'zip-archive',
      locator,
      archiveSha256,
      enforceDirectoryName: extracted.enforceDirectoryName,
      executablePaths: extracted.executablePaths,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(workspace, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await rm(workspace, { force: true, recursive: true });
    throw error;
  }
}

export async function analyzeSkillSource(
  sourcePath: string,
  temporaryParent: string,
  limits: Readonly<SkillPackageLimits> = DEFAULT_SKILL_LIMITS,
): Promise<AnalyzedSkillSource> {
  const source = await loadSkillSource(sourcePath, temporaryParent, limits);
  try {
    const analysis = await analyzeSkillDirectory(source.root, {
      limits,
      enforceDirectoryName: source.enforceDirectoryName,
      executableOverrides: source.executablePaths,
    });
    return { source, analysis };
  } catch (error) {
    await source.cleanup();
    throw error;
  }
}

async function snapshotArchive(
  archivePath: string,
  destination: string,
  maxBytes: number,
): Promise<string> {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await open(archivePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const stat = await sourceHandle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw sourceError('SKILL_ARCHIVE_LIMIT', `Archive exceeds ${String(maxBytes)} bytes`);
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o400,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(archivePath, { fd: sourceHandle.fd, autoClose: false });
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        stream.destroy();
        throw sourceError('SKILL_ARCHIVE_LIMIT', `Archive exceeds ${String(maxBytes)} bytes`);
      }
      hash.update(buffer);
      await writeFully(destinationHandle, buffer);
    }
    const after = await sourceHandle.stat();
    if (
      bytes !== stat.size ||
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size
    ) {
      throw sourceError('SKILL_FILE_CHANGED', 'Archive changed while being read');
    }
    await destinationHandle.sync();
    return hash.digest('hex');
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
  }
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) {
      throw sourceError('SKILL_ARCHIVE_WRITE_FAILED', 'Archive snapshot made no write progress');
    }
    offset += bytesWritten;
  }
}

function sourceError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({ code, component: 'skills', severity: 'high', message, cause });
}

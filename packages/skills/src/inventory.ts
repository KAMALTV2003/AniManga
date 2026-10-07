import { constants as fsConstants, createReadStream } from 'node:fs';
import { lstat, opendir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { NexusError } from '@nexus-ai/core';

import type { SkillPackageLimits } from './limits.js';
import { assertUniqueSkillPath, validateSkillRelativePath } from './paths.js';
import type { SkillInventoryEntry, SkillResourceKind } from './schemas.js';

const FORBIDDEN_DIRECTORY_NAMES = new Set(['.git', '.nexus', '.svn', 'node_modules']);
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface InventoryResult {
  readonly entries: readonly SkillInventoryEntry[];
  readonly contentHash: string;
  readonly totalBytes: number;
}

export async function inventorySkillDirectory(
  root: string,
  limits: SkillPackageLimits,
  executableOverrides: ReadonlySet<string> = new Set(),
): Promise<InventoryResult> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw packageError('SKILL_SOURCE_INVALID', 'Skill source must be a real directory');
  }
  const canonicalRoot = await realpath(root);
  const paths: string[] = [];
  await walk(canonicalRoot, '', paths, limits);
  paths.sort(compareUtf8);

  if (paths.length > limits.maxFiles) {
    throw packageError('SKILL_FILE_LIMIT', `Package exceeds ${String(limits.maxFiles)} files`);
  }

  const exactPaths = new Set<string>();
  const collisionKeys = new Map<string, string>();
  const entries: SkillInventoryEntry[] = [];
  let totalBytes = 0;

  for (const relativePath of paths) {
    const validated = validateSkillRelativePath(relativePath, limits);
    assertUniqueSkillPath(validated, exactPaths, collisionKeys);
    if (validated.path === 'metadata.json') {
      continue;
    }

    const absolutePath = path.join(canonicalRoot, ...validated.path.split('/'));
    const result = await hashRegularFile(absolutePath, validated.path, limits);
    totalBytes += result.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw packageError(
        'SKILL_EXPANSION_LIMIT',
        `Package exceeds ${String(limits.maxTotalBytes)} uncompressed bytes`,
      );
    }
    entries.push({
      path: validated.path,
      kind: classifyResource(validated.path),
      mediaType: mediaTypeFor(validated.path),
      bytes: result.bytes,
      sha256: result.sha256,
      executableInSource: result.executable || executableOverrides.has(validated.path),
    });
  }

  if (!entries.some((entry) => entry.path === 'SKILL.md')) {
    throw packageError('SKILL_MANIFEST_MISSING', 'Package root does not contain SKILL.md');
  }

  return {
    entries,
    contentHash: hashInventory(entries),
    totalBytes,
  };
}

async function walk(
  root: string,
  relativeDirectory: string,
  paths: string[],
  limits: SkillPackageLimits,
): Promise<void> {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split('/').filter(Boolean));
  const directory = await opendir(absoluteDirectory);
  const children = [];
  for await (const child of directory) {
    children.push(child);
  }
  children.sort((left, right) => compareUtf8(left.name, right.name));

  for (const child of children) {
    const relativePath =
      relativeDirectory === '' ? child.name : `${relativeDirectory}/${child.name}`;
    validateSkillRelativePath(relativePath, limits);
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw packageError(
        'SKILL_SYMLINK_REJECTED',
        `Symbolic links are not allowed: ${relativePath}`,
      );
    }
    if (stat.isDirectory()) {
      if (FORBIDDEN_DIRECTORY_NAMES.has(child.name)) {
        throw packageError('SKILL_FORBIDDEN_DIRECTORY', `Forbidden directory: ${relativePath}`);
      }
      await walk(root, relativePath, paths, limits);
    } else if (stat.isFile()) {
      paths.push(relativePath);
      if (paths.length > limits.maxFiles) {
        throw packageError('SKILL_FILE_LIMIT', `Package exceeds ${String(limits.maxFiles)} files`);
      }
    } else {
      throw packageError(
        'SKILL_SPECIAL_FILE_REJECTED',
        `Special files are not allowed: ${relativePath}`,
      );
    }
  }
}

async function hashRegularFile(
  absolutePath: string,
  relativePath: string,
  limits: SkillPackageLimits,
): Promise<{ readonly sha256: string; readonly bytes: number; readonly executable: boolean }> {
  let handle;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw packageError('SKILL_FILE_OPEN_FAILED', `Could not safely open ${relativePath}`, error);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw packageError(
        'SKILL_FILE_CHANGED',
        `Package entry changed while reading: ${relativePath}`,
      );
    }
    const limit = relativePath === 'SKILL.md' ? limits.maxSkillMarkdownBytes : limits.maxFileBytes;
    if (before.size > limit) {
      throw packageError('SKILL_FILE_LIMIT', `${relativePath} exceeds ${String(limit)} bytes`);
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(absolutePath, { fd: handle.fd, autoClose: false });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > limit) {
        stream.destroy();
        throw packageError('SKILL_FILE_LIMIT', `${relativePath} exceeds ${String(limit)} bytes`);
      }
      hash.update(buffer);
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes !== after.size
    ) {
      throw packageError(
        'SKILL_FILE_CHANGED',
        `Package entry changed while reading: ${relativePath}`,
      );
    }
    return {
      sha256: hash.digest('hex'),
      bytes,
      executable: (before.mode & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}

function hashInventory(entries: readonly SkillInventoryEntry[]): string {
  const hash = createHash('sha256');
  hash.update('nexus-skill-payload-v1\0');
  for (const entry of entries) {
    hash.update(String(Buffer.byteLength(entry.path, 'utf8')));
    hash.update(':');
    hash.update(entry.path);
    hash.update('\0');
    hash.update(String(entry.bytes));
    hash.update(':');
    hash.update(entry.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function classifyResource(relativePath: string): SkillResourceKind {
  if (relativePath === 'SKILL.md') return 'instructions';
  const first = relativePath.split('/')[0]?.toLowerCase();
  if (first === 'scripts') return 'script';
  if (first === 'references') return 'reference';
  if (first === 'assets') return 'asset';
  if (first === 'tests') return 'test';
  if (first === 'examples') return 'example';
  return 'resource';
}

function mediaTypeFor(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return (
    {
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.ts': 'text/typescript',
      '.py': 'text/x-python',
      '.sh': 'text/x-shellscript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.csv': 'text/csv',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.zip': 'application/zip',
    }[extension] ?? 'application/octet-stream'
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function packageError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({ code, component: 'skills', severity: 'high', message, cause });
}

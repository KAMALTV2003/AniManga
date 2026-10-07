import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import type { SkillPackageLimits } from './limits.js';
import { assertUniqueSkillPath, validateSkillRelativePath } from './paths.js';

const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;
const ZIP_DIRECTORY_ATTRIBUTE = 0x10;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface ExtractedSkillArchive {
  readonly root: string;
  readonly enforceDirectoryName: boolean;
  readonly executablePaths: ReadonlySet<string>;
}

export async function extractSkillArchive(
  archivePath: string,
  destination: string,
  limits: SkillPackageLimits,
): Promise<ExtractedSkillArchive> {
  const archiveStat = await lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw archiveError(
      'SKILL_ARCHIVE_INVALID',
      'ZIP source must be a regular, non-symbolic-link file',
    );
  }
  if (archiveStat.size > limits.maxArchiveBytes) {
    throw archiveError(
      'SKILL_ARCHIVE_LIMIT',
      `ZIP source exceeds ${String(limits.maxArchiveBytes)} bytes`,
    );
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const canonicalDestination = await realpath(destination);
  const zipFile = await openZip(archivePath);

  const exactPaths = new Set<string>();
  const collisionKeys = new Map<string, string>();
  const extractedFiles: string[] = [];
  const executablePaths = new Set<string>();
  let entryCount = 0;
  let fileCount = 0;
  let declaredTotal = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(
        error instanceof NexusError
          ? error
          : archiveError(
              'SKILL_ARCHIVE_MALFORMED',
              error instanceof Error ? error.message : String(error),
              error,
            ),
      );
    };
    zipFile.once('error', fail);
    zipFile.once('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.on('entry', (entry: Entry) => {
      void processEntry(entry)
        .then(() => {
          if (!settled) zipFile.readEntry();
        })
        .catch(fail);
    });

    async function processEntry(entry: Entry): Promise<void> {
      entryCount += 1;
      if (entryCount > limits.maxFiles * 2) {
        throw archiveError('SKILL_FILE_LIMIT', 'ZIP contains too many entries');
      }
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw archiveError(
          'SKILL_ARCHIVE_ENCRYPTED',
          `Encrypted ZIP entry is not allowed: ${entry.fileName}`,
        );
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw archiveError(
          'SKILL_ARCHIVE_UNSUPPORTED',
          `Unsupported compression method for ${entry.fileName}`,
        );
      }

      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = unixMode & UNIX_FILE_TYPE;
      if (fileType === UNIX_SYMLINK) {
        throw archiveError(
          'SKILL_SYMLINK_REJECTED',
          `ZIP symbolic link is not allowed: ${entry.fileName}`,
        );
      }
      const directoryByName = entry.fileName.endsWith('/');
      const directoryByAttribute = (entry.externalFileAttributes & ZIP_DIRECTORY_ATTRIBUTE) !== 0;
      const isDirectory = directoryByName || directoryByAttribute || fileType === UNIX_DIRECTORY;
      if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE && fileType !== UNIX_DIRECTORY) {
        throw archiveError(
          'SKILL_SPECIAL_FILE_REJECTED',
          `ZIP special entry is not allowed: ${entry.fileName}`,
        );
      }
      if (isDirectory && fileType === UNIX_REGULAR_FILE) {
        throw archiveError(
          'SKILL_ARCHIVE_MALFORMED',
          `Conflicting ZIP entry type: ${entry.fileName}`,
        );
      }

      const rawPath = isDirectory ? entry.fileName.replace(/\/+$/u, '') : entry.fileName;
      const validated = validateSkillRelativePath(rawPath, limits);
      assertUniqueSkillPath(validated, exactPaths, collisionKeys);
      const target = path.resolve(canonicalDestination, ...validated.path.split('/'));
      if (!target.startsWith(`${canonicalDestination}${path.sep}`)) {
        throw archiveError(
          'SKILL_UNSAFE_PATH',
          `ZIP entry escapes extraction root: ${entry.fileName}`,
        );
      }

      if (isDirectory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        return;
      }

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw archiveError('SKILL_FILE_LIMIT', `ZIP exceeds ${String(limits.maxFiles)} files`);
      }
      const fileLimit =
        validated.path.endsWith('/SKILL.md') || validated.path === 'SKILL.md'
          ? limits.maxSkillMarkdownBytes
          : limits.maxFileBytes;
      if (entry.uncompressedSize > fileLimit) {
        throw archiveError(
          'SKILL_FILE_LIMIT',
          `${validated.path} exceeds ${String(fileLimit)} bytes`,
        );
      }
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > limits.maxTotalBytes) {
        throw archiveError(
          'SKILL_EXPANSION_LIMIT',
          'ZIP declared expansion exceeds the package limit',
        );
      }
      if (
        entry.uncompressedSize > 0 &&
        (entry.compressedSize === 0 ||
          entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio)
      ) {
        throw archiveError(
          'SKILL_COMPRESSION_RATIO',
          `Suspicious compression ratio: ${validated.path}`,
        );
      }

      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const stream = await openEntryStream(zipFile, entry);
      const handle = await open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
      let actualBytes = 0;
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          actualBytes += buffer.byteLength;
          if (actualBytes > fileLimit || actualBytes > entry.uncompressedSize) {
            stream.destroy();
            throw archiveError(
              'SKILL_EXPANSION_LIMIT',
              `ZIP entry expanded beyond its limit: ${validated.path}`,
            );
          }
          await writeFully(handle, buffer);
        }
        if (actualBytes !== entry.uncompressedSize) {
          throw archiveError('SKILL_ARCHIVE_MALFORMED', `ZIP size mismatch: ${validated.path}`);
        }
      } finally {
        await handle.close();
      }
      extractedFiles.push(validated.path);
      if ((unixMode & 0o111) !== 0) executablePaths.add(validated.path);
    }

    zipFile.readEntry();
  });

  return locateArchiveRoot(canonicalDestination, extractedFiles, executablePaths);
}

function locateArchiveRoot(
  destination: string,
  files: readonly string[],
  executablePaths: ReadonlySet<string>,
): ExtractedSkillArchive {
  if (files.includes('SKILL.md')) {
    return { root: destination, enforceDirectoryName: false, executablePaths };
  }

  const candidates = files.filter((file) => /^[^/]+\/SKILL\.md$/u.test(file));
  if (candidates.length !== 1) {
    throw archiveError(
      'SKILL_ARCHIVE_LAYOUT',
      'ZIP must contain one SKILL.md at its root or inside one top-level directory',
    );
  }
  const prefix = candidates[0]?.slice(0, -'/SKILL.md'.length);
  if (prefix === undefined || files.some((file) => !file.startsWith(`${prefix}/`))) {
    throw archiveError('SKILL_ARCHIVE_LAYOUT', 'ZIP contains files outside its single skill root');
  }
  const remappedExecutables = new Set<string>();
  for (const file of executablePaths) {
    if (file.startsWith(`${prefix}/`)) remappedExecutables.add(file.slice(prefix.length + 1));
  }
  return {
    root: path.join(destination, prefix),
    enforceDirectoryName: true,
    executablePaths: remappedExecutables,
  };
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    try {
      yauzl.open(
        archivePath,
        {
          autoClose: true,
          decodeStrings: true,
          lazyEntries: true,
          strictFileNames: true,
          validateEntrySizes: true,
        },
        (error, zipFile) => {
          if (error !== null) reject(error);
          else resolve(zipFile);
        },
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function openEntryStream(
  zipFile: ZipFile,
  entry: Entry,
): Promise<NodeJS.ReadableStream & { destroy(): void }> {
  return new Promise((resolve, reject) => {
    try {
      zipFile.openReadStream(entry, (error, stream) => {
        if (error !== null) reject(error);
        else resolve(stream);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) {
      throw archiveError('SKILL_ARCHIVE_WRITE_FAILED', 'Archive extraction made no write progress');
    }
    offset += bytesWritten;
  }
}

function archiveError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({ code, component: 'skills', severity: 'high', message, cause });
}

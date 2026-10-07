import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createId, deterministicId, NexusError } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';
import semver from 'semver';

import { analyzeSkillDirectory } from './analyzer.js';
import {
  NexusSkillMetadataSchema,
  type NexusSkillMetadata,
  type NexusSkillMetadataV2,
  type SkillAnalysis,
  type SkillInventoryEntry,
  type SkillLicense,
  type SkillScores,
} from './schemas.js';
import type { AnalyzedSkillSource } from './source.js';
import { runSkillStructuralTests, type SkillStructuralTestResult } from './structural-tests.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface SkillTrustAssessment {
  readonly license: SkillLicense;
  readonly risk: 'unknown' | 'low' | 'medium' | 'high' | 'critical';
  readonly scores: SkillScores;
  readonly securityScanId: string;
  readonly assessmentId: string;
}

export interface InstallSkillOptions {
  readonly projectId: string;
  readonly version?: string;
  readonly author?: string;
  readonly sourceCommit?: string;
  readonly changelog?: string;
  readonly status?: 'candidate' | 'active';
  readonly trust?: SkillTrustAssessment;
}

export interface InstalledSkill {
  readonly skillId: string;
  readonly versionId: string;
  readonly version: string;
  readonly installed: boolean;
  readonly artifactPath: string;
  readonly metadata: NexusSkillMetadata;
  readonly structuralTests: SkillStructuralTestResult;
}

export interface SkillSearchResult {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly version: string;
  readonly contentHash: string;
  readonly risk: string;
  readonly score: number;
}

interface ExistingVersionRow {
  readonly id: string;
  readonly contentHash: string;
  readonly metadataJson: string;
  readonly instructionsPath: string;
}

interface StoredFileRow {
  readonly relativePath: string;
  readonly resourceKind: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly executableInSource: number;
}

export class SkillRegistry {
  readonly #database: SqliteDatabase;
  readonly #dataDirectory: string;

  constructor(database: SqliteDatabase, dataDirectory: string) {
    this.#database = database;
    this.#dataDirectory = path.resolve(dataDirectory);
  }

  async install(input: AnalyzedSkillSource, options: InstallSkillOptions): Promise<InstalledSkill> {
    const { analysis, source } = input;
    if (!analysis.valid || analysis.frontmatter === null || analysis.contentHash === null) {
      throw registryError(
        'SKILL_VALIDATION_FAILED',
        'Skill package has structural validation errors',
        {
          errors: analysis.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => issue.code),
        },
      );
    }
    const project = this.#database.connection
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(options.projectId) as { readonly id: string } | undefined;
    if (project === undefined) {
      throw registryError(
        'SKILL_PROJECT_NOT_FOUND',
        `Project does not exist: ${options.projectId}`,
      );
    }

    const version = resolveVersion(options.version, analysis.suggestedVersion);
    const name = analysis.frontmatter.name;
    const skillId = deterministicId('skill', `${options.projectId}:${name}`);
    const versionId = deterministicId('skill_version', `${skillId}:${version}`);
    const existing = this.#getVersion(skillId, version);
    if (existing !== undefined) {
      if (existing.contentHash !== analysis.contentHash) {
        throw registryError(
          'SKILL_VERSION_IMMUTABLE',
          `Skill ${name}@${version} is already registered with different content`,
          { existingHash: existing.contentHash, candidateHash: analysis.contentHash },
        );
      }
      const metadata = parseStoredMetadata(existing.metadataJson);
      assertMetadataCompatible(metadata, analysis, options);
      const verification = await this.verifyInstalled(skillId, version);
      return {
        skillId,
        versionId: existing.id,
        version,
        installed: false,
        artifactPath: path.dirname(existing.instructionsPath),
        metadata,
        structuralTests: verification.structuralTests,
      };
    }

    const now = new Date().toISOString();
    const provenanceId = createId('provenance');
    const author = options.author?.trim() || analysis.declaredAuthor;
    const structuralTests = runSkillStructuralTests(analysis);
    const defaultLicense: SkillLicense = {
      declaration: analysis.frontmatter.license ?? null,
      status: analysis.frontmatter.license === undefined ? 'missing' : 'unverified',
      spdxExpression: null,
      detectedIds: [],
      reviewRequired: true,
    };
    const defaultScores: SkillScores = {
      quality: null,
      security: null,
      efficiency: null,
      compatibility: null,
      test: null,
      duplication: null,
      maintenance: null,
      documentation: null,
    };
    const parsedMetadata = NexusSkillMetadataSchema.parse({
      schemaVersion: 2,
      id: skillId,
      name,
      version,
      description: analysis.frontmatter.description,
      author: { name: author, status: author === null ? 'unknown' : 'declared' },
      license: options.trust?.license ?? defaultLicense,
      compatibility: analysis.frontmatter.compatibility ?? null,
      source: {
        type: source.type,
        locator: source.locator,
        commit: options.sourceCommit ?? null,
        archiveSha256: source.archiveSha256,
      },
      contentHash: analysis.contentHash,
      packageBytes: analysis.totalBytes,
      createdAt: now,
      updatedAt: now,
      tags: parseList(analysis.frontmatter.metadata?.['tags']),
      dependencies: parseList(analysis.frontmatter.metadata?.['dependencies']),
      tools: parseTools(analysis.frontmatter['allowed-tools']),
      risk: options.trust?.risk ?? 'unknown',
      scores: options.trust?.scores ?? defaultScores,
      resources: analysis.inventory,
      provenanceId,
      securityScanId: options.trust?.securityScanId ?? null,
      assessmentId: options.trust?.assessmentId ?? null,
    });
    if (parsedMetadata.schemaVersion !== 2) {
      throw registryError('SKILL_METADATA_SCHEMA', 'New registrations must use metadata schema v2');
    }
    const metadata: NexusSkillMetadataV2 = parsedMetadata;

    const managedRoot = await this.#prepareManagedRoot();
    const skillRoot = path.join(managedRoot, skillId);
    await mkdir(skillRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(skillRoot, managedRoot);
    const finalContainer = path.join(skillRoot, version);
    const finalRoot = path.join(finalContainer, name);
    const temporaryRoot = path.join(this.#dataDirectory, 'tmp');
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(path.join(temporaryRoot, 'skill-register-'));
    const stagedContainer = path.join(stage, 'version');
    const stagedPackage = path.join(stagedContainer, name);
    const lockPath = path.join(skillRoot, `.${version}.install.lock`);
    let artifactPublished = false;
    let lockHandle;

    try {
      await mkdir(stagedContainer, { mode: 0o700 });
      await materializePayload(source.root, stagedPackage, analysis.inventory);
      await writeFile(
        path.join(stagedPackage, 'metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o400,
          flush: true,
        },
      );
      lockHandle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      ).catch((error: unknown) => {
        throw registryError(
          'SKILL_INSTALL_IN_PROGRESS',
          `A concurrent or interrupted installation exists for ${name}@${version}`,
          undefined,
          error,
        );
      });
      if (await pathExists(finalContainer)) {
        throw registryError(
          'SKILL_ORPHANED_ARTIFACT',
          `Managed artifact exists without a matching registry version: ${finalContainer}`,
        );
      }
      await rename(stagedContainer, finalContainer);
      artifactPublished = true;

      this.#persistInstallation({
        options,
        metadata,
        versionId,
        finalRoot,
        analysis,
        structuralTests,
      });
      return {
        skillId,
        versionId,
        version,
        installed: true,
        artifactPath: finalRoot,
        metadata,
        structuralTests,
      };
    } catch (error) {
      if (artifactPublished) await rm(finalContainer, { force: true, recursive: true });
      throw error;
    } finally {
      if (lockHandle !== undefined) {
        await lockHandle.close();
        await unlink(lockPath).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      }
      await rm(stage, { force: true, recursive: true });
    }
  }

  search(query: string, limit = 20, projectId?: string): readonly SkillSearchResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Skill search limit must be between 1 and 100');
    }
    if (Buffer.byteLength(query, 'utf8') > 512) {
      throw new RangeError('Skill search query must not exceed 512 UTF-8 bytes');
    }
    const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
    if (tokens.length === 0) {
      throw new RangeError('Skill search query must contain a letter or number');
    }
    if (tokens.length > 20) {
      throw new RangeError('Skill search query must not exceed 20 terms');
    }
    const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ');
    const rows = this.#database.connection
      .prepare(
        `SELECT s.id, s.name, s.description, s.status, sv.version,
                sv.content_sha256 AS contentHash, sv.risk_level AS risk,
                -bm25(skills_fts, 8.0, 1.0) AS score
         FROM skills_fts
         JOIN skills s ON s.rowid = skills_fts.rowid
         JOIN skill_versions sv ON sv.id = s.current_version_id
         WHERE skills_fts MATCH ?
           AND s.project_id IS NOT NULL
           AND s.status = 'active'
           AND (? IS NULL OR s.project_id = ?)
         ORDER BY score DESC, s.name ASC
         LIMIT ?`,
      )
      .all(ftsQuery, projectId ?? null, projectId ?? null, limit) as SkillSearchResult[];
    return rows;
  }

  async verifyInstalled(
    skillId: string,
    version?: string,
  ): Promise<{
    readonly analysis: SkillAnalysis;
    readonly structuralTests: SkillStructuralTestResult;
  }> {
    const row = this.#database.connection
      .prepare(
        `SELECT sv.metadata_json AS metadataJson, sv.instructions_path AS instructionsPath,
                sv.content_sha256 AS contentHash
         FROM skill_versions sv
         JOIN skills s ON s.id = sv.skill_id
         WHERE sv.skill_id = ? AND sv.version = COALESCE(?, (
           SELECT current.version FROM skill_versions current WHERE current.id = s.current_version_id
         ))`,
      )
      .get(skillId, version ?? null) as ExistingVersionRow | undefined;
    if (row === undefined) {
      throw registryError('SKILL_VERSION_NOT_FOUND', `No installed version found for ${skillId}`);
    }
    const metadata = parseStoredMetadata(row.metadataJson);
    const expectedRoot = path.join(
      await this.#prepareManagedRoot(),
      skillId,
      metadata.version,
      metadata.name,
    );
    const artifactRoot = path.dirname(row.instructionsPath);
    if (path.resolve(artifactRoot) !== path.resolve(expectedRoot)) {
      throw registryError(
        'SKILL_ARTIFACT_PATH_INVALID',
        'Stored skill artifact path is outside its managed location',
      );
    }
    await assertRealDirectory(artifactRoot, await this.#prepareManagedRoot());
    const executableOverrides = new Set(
      metadata.resources
        .filter((resource) => resource.executableInSource)
        .map((resource) => resource.path),
    );
    const analysis = await analyzeSkillDirectory(artifactRoot, {
      enforceDirectoryName: false,
      executableOverrides,
    });
    if (
      analysis.existingMetadata === null ||
      JSON.stringify(analysis.existingMetadata) !== JSON.stringify(metadata)
    ) {
      throw registryError(
        'SKILL_METADATA_DRIFT',
        `${skillId}@${metadata.version} metadata differs from its registry record`,
      );
    }
    if (!analysis.valid || analysis.contentHash !== row.contentHash) {
      throw registryError(
        'SKILL_INTEGRITY_FAILED',
        `${skillId}@${metadata.version} failed integrity verification`,
        {
          expectedHash: row.contentHash,
          actualHash: analysis.contentHash,
          issues: analysis.issues.map((issue) => issue.code),
        },
      );
    }
    const storedFiles = this.#database.connection
      .prepare(
        `SELECT relative_path AS relativePath, resource_kind AS resourceKind, media_type AS mediaType,
                byte_size AS byteSize, content_sha256 AS contentHash,
                executable_in_source AS executableInSource
         FROM skill_files WHERE skill_version_id = ? ORDER BY relative_path`,
      )
      .all(deterministicId('skill_version', `${skillId}:${metadata.version}`)) as StoredFileRow[];
    const projected = analysis.inventory.map((entry) => ({
      relativePath: entry.path,
      resourceKind: entry.kind,
      mediaType: entry.mediaType,
      byteSize: entry.bytes,
      contentHash: entry.sha256,
      executableInSource: entry.executableInSource ? 1 : 0,
    }));
    if (JSON.stringify(storedFiles) !== JSON.stringify(projected)) {
      throw registryError(
        'SKILL_INVENTORY_DRIFT',
        'Managed artifact inventory differs from registry records',
      );
    }
    return { analysis, structuralTests: runSkillStructuralTests(analysis) };
  }

  #getVersion(skillId: string, version: string): ExistingVersionRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT id, content_sha256 AS contentHash, metadata_json AS metadataJson,
                instructions_path AS instructionsPath
         FROM skill_versions WHERE skill_id = ? AND version = ?`,
      )
      .get(skillId, version) as ExistingVersionRow | undefined;
  }

  #persistInstallation(input: {
    readonly options: InstallSkillOptions;
    readonly metadata: NexusSkillMetadataV2;
    readonly versionId: string;
    readonly finalRoot: string;
    readonly analysis: SkillAnalysis;
    readonly structuralTests: SkillStructuralTestResult;
  }): void {
    const { metadata, options, versionId, finalRoot, analysis, structuralTests } = input;
    const database = this.#database.connection;
    const transaction = database.transaction(() => {
      const modifications = ['normalized_metadata', 'disabled_executable_bits'];
      database
        .prepare(
          `INSERT INTO provenance_records(
             id, source_type, source_uri, repository, source_commit, author, license_spdx,
             input_object_ids_json, modifications_json, security_scan_id, content_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
        )
        .run(
          metadata.provenanceId,
          provenanceSourceType(metadata.source.type),
          metadata.source.locator,
          metadata.source.type === 'git-repository' ? metadata.source.locator : null,
          metadata.source.commit,
          metadata.author.name,
          metadata.license.spdxExpression,
          JSON.stringify(modifications),
          metadata.securityScanId,
          metadata.contentHash,
          metadata.createdAt,
        );
      database
        .prepare(
          `INSERT INTO skills(id, project_id, name, description, scope, status, current_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'project', ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             description = CASE
               WHEN skills.status = 'active' AND excluded.status = 'candidate'
                 THEN skills.description
               ELSE excluded.description
             END,
             status = CASE
               WHEN skills.status = 'active' AND excluded.status = 'candidate'
                 THEN skills.status
               ELSE excluded.status
             END,
             updated_at = excluded.updated_at`,
        )
        .run(
          metadata.id,
          options.projectId,
          metadata.name,
          metadata.description,
          options.status ?? 'active',
          metadata.createdAt,
          metadata.updatedAt,
        );
      database
        .prepare(
          `INSERT INTO skill_versions(
             id, skill_id, version, instructions_path, metadata_json, compatibility_json,
             required_tools_json, dependencies_json, risk_level, quality_score, security_score,
             compatibility_score, maintenance_score, documentation_score, test_score,
             duplication_score, context_efficiency_score, content_sha256, provenance_id,
             changelog, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          metadata.id,
          metadata.version,
          path.join(finalRoot, 'SKILL.md'),
          JSON.stringify(metadata),
          JSON.stringify(metadata.compatibility === null ? [] : [metadata.compatibility]),
          JSON.stringify(metadata.tools),
          JSON.stringify(metadata.dependencies),
          metadata.risk,
          metadata.scores.quality,
          metadata.scores.security,
          metadata.scores.compatibility,
          metadata.scores.maintenance,
          metadata.scores.documentation,
          metadata.scores.test,
          metadata.scores.duplication,
          metadata.scores.efficiency,
          metadata.contentHash,
          metadata.provenanceId,
          options.changelog ?? '',
          metadata.createdAt,
        );
      const insertFile = database.prepare(
        `INSERT INTO skill_files(
           id, skill_version_id, relative_path, resource_kind, media_type, byte_size,
           content_sha256, executable_in_source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const file of metadata.resources) {
        insertFile.run(
          deterministicId('skill_file', `${versionId}:${file.path}`),
          versionId,
          file.path,
          file.kind,
          file.mediaType,
          file.bytes,
          file.sha256,
          file.executableInSource ? 1 : 0,
          metadata.createdAt,
        );
      }
      database
        .prepare(
          `INSERT INTO skill_validation_runs(
             id, skill_version_id, content_sha256, suite, passed, error_count, warning_count,
             result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createId('validation'),
          versionId,
          metadata.contentHash,
          structuralTests.suite,
          structuralTests.passed ? 1 : 0,
          analysis.issues.filter((issue) => issue.severity === 'error').length,
          analysis.issues.filter((issue) => issue.severity === 'warning').length,
          JSON.stringify(structuralTests),
          metadata.createdAt,
        );
      const current = database
        .prepare(
          `SELECT sv.version FROM skills s
           LEFT JOIN skill_versions sv ON sv.id = s.current_version_id
           WHERE s.id = ?`,
        )
        .get(metadata.id) as { readonly version: string | null } | undefined;
      if (
        (options.status ?? 'active') === 'active' &&
        (current?.version === null ||
          current === undefined ||
          semver.gt(metadata.version, current.version))
      ) {
        database
          .prepare('UPDATE skills SET current_version_id = ?, updated_at = ? WHERE id = ?')
          .run(versionId, metadata.updatedAt, metadata.id);
      }
    });
    try {
      transaction.immediate();
    } catch (error) {
      throw registryError(
        'SKILL_REGISTRY_WRITE_FAILED',
        'Could not persist skill registration',
        undefined,
        error,
      );
    }
  }

  async #prepareManagedRoot(): Promise<string> {
    await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
    const canonicalData = await realpath(this.#dataDirectory);
    const skillsRoot = path.join(canonicalData, 'skills');
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(skillsRoot, canonicalData);
    return skillsRoot;
  }
}

async function materializePayload(
  sourceRoot: string,
  destinationRoot: string,
  inventory: readonly SkillInventoryEntry[],
): Promise<void> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  for (const expected of inventory) {
    const source = path.join(sourceRoot, ...expected.path.split('/'));
    const destination = path.join(destinationRoot, ...expected.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let sourceHandle;
    let destinationHandle;
    try {
      sourceHandle = await open(source, fsConstants.O_RDONLY | O_NOFOLLOW);
      const sourceStat = await sourceHandle.stat();
      const resolvedSource = await realpath(source);
      const pathStat = await lstat(source);
      if (
        !sourceStat.isFile() ||
        sourceStat.size !== expected.bytes ||
        pathStat.isSymbolicLink() ||
        sourceStat.dev !== pathStat.dev ||
        sourceStat.ino !== pathStat.ino ||
        !resolvedSource.startsWith(`${canonicalSourceRoot}${path.sep}`)
      ) {
        throw registryError(
          'SKILL_FILE_CHANGED',
          `Source changed before installation: ${expected.path}`,
        );
      }
      destinationHandle = await open(
        destination,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o400,
      );
      const hash = createHash('sha256');
      let bytes = 0;
      const stream = createReadStream(source, { fd: sourceHandle.fd, autoClose: false });
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > expected.bytes) {
          stream.destroy();
          throw registryError(
            'SKILL_FILE_CHANGED',
            `Source grew during installation: ${expected.path}`,
          );
        }
        hash.update(buffer);
        await writeFully(destinationHandle, buffer);
      }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
        throw registryError(
          'SKILL_FILE_CHANGED',
          `Source changed during installation: ${expected.path}`,
        );
      }
      await destinationHandle.sync();
    } finally {
      await destinationHandle?.close();
      await sourceHandle?.close();
    }
  }
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) {
      throw registryError(
        'SKILL_ARTIFACT_WRITE_FAILED',
        'Artifact materialization made no write progress',
      );
    }
    offset += bytesWritten;
  }
}

function provenanceSourceType(
  sourceType: NexusSkillMetadataV2['source']['type'],
): 'local' | 'archive' | 'url' | 'repository' {
  switch (sourceType) {
    case 'local-directory':
      return 'local';
    case 'zip-archive':
      return 'archive';
    case 'https-archive':
      return 'url';
    case 'git-repository':
      return 'repository';
  }
}

function resolveVersion(override: string | undefined, suggested: string | null): string {
  if (override !== undefined && semver.valid(override) !== override) {
    throw registryError('SKILL_VERSION_INVALID', 'Version must be canonical semantic versioning');
  }
  if (override !== undefined && suggested !== null && override !== suggested) {
    throw registryError(
      'SKILL_VERSION_CONFLICT',
      'Requested version differs from the package declaration',
    );
  }
  const version = override ?? suggested;
  if (version === null) {
    throw registryError(
      'SKILL_VERSION_REQUIRED',
      'Installation requires --version or canonical metadata.version',
    );
  }
  return version;
}

function parseList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function parseTools(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(/\s+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function parseStoredMetadata(value: string): NexusSkillMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw registryError(
      'SKILL_REGISTRY_CORRUPT',
      'Stored skill metadata is invalid JSON',
      undefined,
      error,
    );
  }
  const result = NexusSkillMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw registryError(
      'SKILL_REGISTRY_CORRUPT',
      'Stored skill metadata violates the canonical schema',
    );
  }
  return result.data;
}

function assertMetadataCompatible(
  existing: NexusSkillMetadata,
  analysis: SkillAnalysis,
  options: InstallSkillOptions,
): void {
  const candidateAuthor = options.author?.trim() || analysis.declaredAuthor;
  const trustConflict =
    options.trust !== undefined &&
    (existing.schemaVersion !== 2 ||
      existing.risk !== options.trust.risk ||
      JSON.stringify(existing.license) !== JSON.stringify(options.trust.license) ||
      JSON.stringify(existing.scores) !== JSON.stringify(options.trust.scores) ||
      existing.securityScanId !== options.trust.securityScanId ||
      existing.assessmentId !== options.trust.assessmentId);
  if (
    trustConflict ||
    existing.name !== analysis.frontmatter?.name ||
    existing.description !== analysis.frontmatter.description ||
    existing.author.name !== candidateAuthor ||
    existing.license.declaration !==
      (options.trust?.license.declaration ?? analysis.frontmatter.license ?? null) ||
    existing.compatibility !== (analysis.frontmatter.compatibility ?? null) ||
    existing.source.commit !== (options.sourceCommit ?? null) ||
    JSON.stringify(existing.tags) !==
      JSON.stringify(parseList(analysis.frontmatter.metadata?.['tags'])) ||
    JSON.stringify(existing.dependencies) !==
      JSON.stringify(parseList(analysis.frontmatter.metadata?.['dependencies'])) ||
    JSON.stringify(existing.tools) !==
      JSON.stringify(parseTools(analysis.frontmatter['allowed-tools']))
  ) {
    throw registryError(
      'SKILL_VERSION_METADATA_IMMUTABLE',
      `Skill ${existing.name}@${existing.version} is already registered with different metadata`,
    );
  }
}

async function assertRealDirectory(candidate: string, boundary: string): Promise<void> {
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw registryError(
      'SKILL_STORAGE_UNSAFE',
      `Managed storage is not a real directory: ${candidate}`,
    );
  }
  const resolved = await realpath(candidate);
  const resolvedBoundary = await realpath(boundary);
  if (resolved !== resolvedBoundary && !resolved.startsWith(`${resolvedBoundary}${path.sep}`)) {
    throw registryError('SKILL_STORAGE_UNSAFE', 'Managed storage escapes its configured boundary');
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function registryError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): NexusError {
  return new NexusError({
    code,
    component: 'skills.registry',
    severity: 'high',
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

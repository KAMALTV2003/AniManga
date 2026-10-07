import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { asNexusError, createId, deterministicId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';
import {
  DEFAULT_SKILL_LIMITS,
  SkillRegistry,
  analyzeSkillSource,
  type SkillPackageLimits,
  type SkillScores,
} from '@nexus-ai/skills';

import { assessHarvest } from './assessment.js';
import { proposeDuplicates } from './duplicates.js';
import { acquireGitSkill } from './git-source.js';
import { acquireHttpsSkill } from './http-source.js';
import { reviewSkillLicense } from './license.js';
import { quarantineSkill } from './quarantine.js';
import { scanSkill } from './scanner.js';
import {
  DEFAULT_HARVEST_LIMITS,
  type AcquiredSkillSource,
  type DuplicateProposal,
  type HarvestAssessment,
  type HarvestLimits,
  type HarvestReport,
  type HarvestRequest,
  type HarvestSourceType,
  type LicenseReview,
  type StaticScanResult,
  validateHarvestLimits,
} from './types.js';

export interface HarvestServiceOptions {
  readonly database: SqliteDatabase;
  readonly dataDirectory: string;
  readonly temporaryDirectory?: string;
  readonly harvestLimits?: Readonly<HarvestLimits>;
  readonly skillLimits?: Readonly<SkillPackageLimits>;
}

export class HarvestService {
  readonly #database: SqliteDatabase;
  readonly #dataDirectory: string;
  readonly #temporaryDirectory: string;
  readonly #harvestLimits: Readonly<HarvestLimits>;
  readonly #skillLimits: Readonly<SkillPackageLimits>;
  readonly #registry: SkillRegistry;

  constructor(options: HarvestServiceOptions) {
    this.#database = options.database;
    this.#dataDirectory = path.resolve(options.dataDirectory);
    this.#temporaryDirectory = path.resolve(
      options.temporaryDirectory ?? path.join(this.#dataDirectory, 'tmp'),
    );
    this.#harvestLimits = options.harvestLimits ?? DEFAULT_HARVEST_LIMITS;
    validateHarvestLimits(this.#harvestLimits);
    this.#skillLimits = options.skillLimits ?? DEFAULT_SKILL_LIMITS;
    this.#registry = new SkillRegistry(this.#database, this.#dataDirectory);
  }

  async harvest(request: HarvestRequest): Promise<HarvestReport> {
    validateRequest(request);
    assertProject(this.#database, request.projectId);
    await mkdir(this.#temporaryDirectory, { recursive: true, mode: 0o700 });
    const sourceType = await resolveSourceType(request);
    const harvestId = createId('harvest');
    const startedAt = new Date().toISOString();
    const inputFingerprint = hashJson({
      projectId: request.projectId,
      sourceType,
      source: request.source,
      ref: request.ref ?? null,
      skillPath: request.skillPath ?? null,
      version: request.version ?? null,
      author: request.author ?? null,
      register: request.register,
      inspectOnly: request.inspectOnly,
      allowedHosts: [...(request.allowedHosts ?? [])].sort(),
    });
    this.#database.connection
      .prepare(
        `INSERT INTO harvest_runs(
           id, project_id, source_type, source_uri, requested_ref, selected_skill_path,
           resolved_commit, input_fingerprint, source_snapshot_sha256, status,
           content_sha256, security_scan_id, skill_version_id, result_json,
           started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'started', NULL, NULL, NULL, '{}', ?, NULL)`,
      )
      .run(
        harvestId,
        request.projectId,
        sourceType,
        request.source,
        request.ref ?? null,
        request.skillPath ?? null,
        inputFingerprint,
        startedAt,
      );

    let acquired: AcquiredSkillSource | undefined;
    try {
      acquired = await this.#acquire(request, sourceType);
      const { analysis, source } = acquired.analyzed;
      if (!analysis.valid || analysis.contentHash === null || analysis.frontmatter === null) {
        throw asNexusError(new Error('Source is not a structurally valid Skill package'), {
          code: 'HARVEST_SKILL_INVALID',
          component: 'harvest.pipeline',
          severity: 'high',
          details: {
            issueCodes: analysis.issues
              .filter((issue) => issue.severity === 'error')
              .map((issue) => issue.code),
          },
        });
      }
      const sourceSnapshotSha256 = hashJson({
        sourceType: acquired.sourceType,
        locator: source.locator,
        archiveSha256: source.archiveSha256,
        resolvedCommit: acquired.resolvedCommit,
        selectedSkillPath: acquired.selectedSkillPath,
        contentHash: analysis.contentHash,
        inventory: analysis.inventory,
      });
      this.#database.connection
        .prepare(
          `UPDATE harvest_runs
           SET status = 'analyzed', selected_skill_path = ?, resolved_commit = ?,
               source_snapshot_sha256 = ?, content_sha256 = ?
           WHERE id = ?`,
        )
        .run(
          acquired.selectedSkillPath,
          acquired.resolvedCommit,
          sourceSnapshotSha256,
          analysis.contentHash,
          harvestId,
        );

      const scan = await scanSkill(source.root, analysis, this.#harvestLimits);
      const scanId = deterministicId(
        'security_scan',
        hashJson({ projectId: request.projectId, contentHash: analysis.contentHash, scan }),
      );
      const license = await reviewSkillLicense(source.root, analysis, this.#harvestLimits);
      const duplicates = proposeDuplicates(this.#database, request.projectId, analysis);
      const assessment = assessHarvest(
        analysis,
        scan,
        license,
        scanId,
        duplicates.filter((candidate) => candidate.exact).length,
      );
      persistTrustEvidence(this.#database, {
        harvestId,
        projectId: request.projectId,
        contentHash: analysis.contentHash,
        scanId,
        scan,
        license,
        assessment,
        duplicates,
        createdAt: new Date().toISOString(),
      });

      let registration: HarvestReport['registration'] = null;
      let quarantinePath: string | null = null;
      let status: HarvestReport['status'] = 'inspected';
      if (!request.inspectOnly && request.register) {
        if (assessment.disposition === 'quarantine') {
          quarantinePath = await quarantineSkill(
            acquired.analyzed,
            this.#dataDirectory,
            harvestId,
            assessment.id,
          );
          status = 'quarantined';
        } else {
          registration = await this.#registry.install(acquired.analyzed, {
            projectId: request.projectId,
            ...(request.version === undefined ? {} : { version: request.version }),
            ...(request.author === undefined ? {} : { author: request.author }),
            status: 'candidate',
            ...(acquired.resolvedCommit === null ? {} : { sourceCommit: acquired.resolvedCommit }),
            trust: {
              risk: assessment.risk,
              scores: metadataScores(assessment, duplicates),
              license: license.canonical,
              securityScanId: scanId,
              assessmentId: assessment.id,
            },
          });
          status = 'registered';
        }
      }

      const report: HarvestReport = {
        harvestId,
        status,
        sourceType: acquired.sourceType,
        source: source.locator,
        resolvedCommit: acquired.resolvedCommit,
        selectedSkillPath: acquired.selectedSkillPath,
        sourceSnapshotSha256,
        skillName: analysis.frontmatter.name,
        contentHash: analysis.contentHash,
        scanId,
        scan,
        assessmentId: assessment.id,
        risk: assessment.risk,
        license,
        findings: scan.findings,
        duplicates,
        assessment,
        quarantinePath,
        registration,
        importedCodeExecuted: false,
      };
      if (registration !== null) {
        linkRegistration(this.#database, assessment.id, registration.versionId);
      }
      finishHarvest(
        this.#database,
        harvestId,
        status === 'inspected' ? 'analyzed' : status,
        scanId,
        registration?.versionId ?? null,
        report,
      );
      return report;
    } catch (error) {
      const nexusError = asNexusError(error, {
        code: 'HARVEST_FAILED',
        component: 'harvest.pipeline',
        severity: 'high',
      });
      this.#database.connection
        .prepare(
          `UPDATE harvest_runs
           SET status = 'failed', result_json = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify({ error: nexusError.toJSON() }), new Date().toISOString(), harvestId);
      throw nexusError;
    } finally {
      await acquired?.analyzed.source.cleanup();
    }
  }

  async #acquire(
    request: HarvestRequest,
    sourceType: HarvestSourceType,
  ): Promise<AcquiredSkillSource> {
    if (sourceType === 'https-archive') {
      const analyzed = await acquireHttpsSkill(request.source, this.#temporaryDirectory, {
        ...(request.allowedHosts === undefined ? {} : { allowedHosts: request.allowedHosts }),
        harvestLimits: this.#harvestLimits,
        skillLimits: this.#skillLimits,
      });
      return { analyzed, sourceType, resolvedCommit: null, selectedSkillPath: null };
    }
    if (sourceType === 'git-repository') {
      const result = await acquireGitSkill(request.source, this.#temporaryDirectory, {
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        ...(request.skillPath === undefined ? {} : { skillPath: request.skillPath }),
        ...(request.allowedHosts === undefined ? {} : { allowedHosts: request.allowedHosts }),
        harvestLimits: this.#harvestLimits,
        skillLimits: this.#skillLimits,
      });
      return {
        analyzed: result.analyzed,
        sourceType,
        resolvedCommit: result.commit,
        selectedSkillPath: result.skillPath,
      };
    }
    const analyzed = await analyzeSkillSource(
      request.source,
      this.#temporaryDirectory,
      this.#skillLimits,
    );
    if (analyzed.source.type !== sourceType) {
      await analyzed.source.cleanup();
      throw asNexusError(new Error('Local source type does not match the requested type'), {
        code: 'HARVEST_SOURCE_TYPE_MISMATCH',
        component: 'harvest.pipeline',
        severity: 'high',
      });
    }
    return { analyzed, sourceType, resolvedCommit: null, selectedSkillPath: null };
  }
}

function persistTrustEvidence(
  database: SqliteDatabase,
  input: {
    readonly harvestId: string;
    readonly projectId: string;
    readonly contentHash: string;
    readonly scanId: string;
    readonly scan: StaticScanResult;
    readonly license: LicenseReview;
    readonly assessment: HarvestAssessment;
    readonly duplicates: readonly DuplicateProposal[];
    readonly createdAt: string;
  },
): void {
  const connection = database.connection;
  connection
    .transaction(() => {
      connection
        .prepare(
          `INSERT INTO security_scans(
           id, project_id, target_type, target_sha256, scanner_version, status,
           risk_level, finding_count, findings_json, summary_json, started_at, completed_at
         ) VALUES (?, ?, 'skill_candidate', ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, target_type, target_sha256, scanner_version) DO UPDATE SET
           status = excluded.status,
           risk_level = excluded.risk_level,
           finding_count = excluded.finding_count,
           findings_json = excluded.findings_json,
           summary_json = excluded.summary_json,
           completed_at = excluded.completed_at`,
        )
        .run(
          input.scanId,
          input.projectId,
          input.contentHash,
          input.scan.scannerVersion,
          input.scan.risk,
          input.scan.findings.length,
          JSON.stringify(input.scan.findings),
          JSON.stringify({
            scannedFiles: input.scan.scannedFiles,
            scannedBytes: input.scan.scannedBytes,
            skippedBinaryFiles: input.scan.skippedBinaryFiles,
          }),
          input.createdAt,
          input.createdAt,
        );
      const insertFinding = connection.prepare(
        `INSERT INTO security_findings(
           id, project_id, scan_id, target_type, target_id, rule_id, severity, status,
           title, description, evidence_json, remediation, fingerprint, created_at, updated_at
         ) VALUES (?, ?, ?, 'skill_candidate', ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scan_id, fingerprint) DO UPDATE SET
           severity = excluded.severity,
           title = excluded.title,
           description = excluded.description,
           evidence_json = excluded.evidence_json,
           remediation = excluded.remediation,
           updated_at = excluded.updated_at`,
      );
      for (const finding of input.scan.findings) {
        insertFinding.run(
          deterministicId('security_finding', `${input.scanId}:${finding.fingerprint}`),
          input.projectId,
          input.scanId,
          input.contentHash,
          finding.ruleId,
          finding.severity === 'info' ? 'safe' : finding.severity,
          finding.title,
          finding.description,
          JSON.stringify({
            path: finding.path,
            line: finding.line,
            evidenceSha256: finding.evidenceSha256,
          }),
          finding.remediation,
          finding.fingerprint,
          input.createdAt,
          input.createdAt,
        );
      }
      connection
        .prepare(
          `INSERT INTO skill_license_reviews(
           id, harvest_id, declaration, spdx_expression, detected_ids_json,
           evidence_files_json, status, review_required, evidence_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deterministicId('license_review', input.harvestId),
          input.harvestId,
          input.license.declaration,
          input.license.spdxExpression,
          JSON.stringify(input.license.detectedIds),
          JSON.stringify(input.license.evidenceFiles),
          input.license.status,
          input.license.reviewRequired ? 1 : 0,
          JSON.stringify(input.license.evidence),
          input.createdAt,
        );
      connection
        .prepare(
          `INSERT INTO skill_assessments(
           id, skill_version_id, security_scan_id, content_sha256, policy_version,
           disposition, risk_level, confidence, scores_json, evidence_json, created_at
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          input.assessment.id,
          input.scanId,
          input.contentHash,
          input.assessment.policyVersion,
          input.assessment.disposition,
          input.assessment.risk,
          input.assessment.confidence,
          JSON.stringify(input.assessment.scores),
          JSON.stringify({
            blockingReasons: input.assessment.blockingReasons,
            license: input.assessment.license,
          }),
          input.createdAt,
        );
      connection
        .prepare('INSERT INTO harvest_assessment_links(harvest_id, assessment_id) VALUES (?, ?)')
        .run(input.harvestId, input.assessment.id);
      for (const duplicate of input.duplicates) {
        connection
          .prepare(
            `INSERT INTO skill_duplicate_candidates(
             id, candidate_content_sha256, existing_skill_id, existing_skill_version_id,
             method, similarity, exact, status, evidence_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          )
          .run(
            duplicate.id,
            input.contentHash,
            duplicate.targetSkillId,
            duplicate.targetVersionId,
            duplicate.method,
            duplicate.confidence,
            duplicate.exact ? 1 : 0,
            JSON.stringify({
              label: duplicate.exact ? 'exact' : 'near-duplicate-proposal',
              method: duplicate.method,
            }),
            input.createdAt,
          );
        connection
          .prepare(
            `INSERT OR IGNORE INTO harvest_duplicate_links(harvest_id, duplicate_candidate_id)
           VALUES (?, ?)`,
          )
          .run(input.harvestId, duplicate.id);
      }
      connection
        .prepare('UPDATE harvest_runs SET security_scan_id = ? WHERE id = ?')
        .run(input.scanId, input.harvestId);
    })
    .immediate();
}

function metadataScores(
  assessment: HarvestAssessment,
  duplicates: readonly DuplicateProposal[],
): SkillScores {
  const highestDuplicate = duplicates.reduce(
    (maximum, duplicate) => Math.max(maximum, duplicate.confidence),
    0,
  );
  return {
    quality: normalized(assessment.scores.quality),
    security: normalized(assessment.scores.security),
    efficiency: normalized(assessment.scores.contextEfficiency),
    compatibility: null,
    test: normalized(assessment.scores.tests),
    duplication: Number((1 - highestDuplicate).toFixed(6)),
    maintenance: normalized(assessment.scores.maintenance),
    documentation: normalized(assessment.scores.documentation),
  };
}

function normalized(score: { readonly value: number } | null): number | null {
  return score === null ? null : Number((score.value / 100).toFixed(6));
}

function finishHarvest(
  database: SqliteDatabase,
  harvestId: string,
  status: 'analyzed' | 'quarantined' | 'registered',
  scanId: string,
  skillVersionId: string | null,
  report: HarvestReport,
): void {
  database.connection
    .prepare(
      `UPDATE harvest_runs
       SET status = ?, security_scan_id = ?, skill_version_id = ?, result_json = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      scanId,
      skillVersionId,
      JSON.stringify(report),
      new Date().toISOString(),
      harvestId,
    );
}

function linkRegistration(
  database: SqliteDatabase,
  assessmentId: string,
  skillVersionId: string,
): void {
  database.connection
    .prepare('UPDATE skill_assessments SET skill_version_id = ? WHERE id = ?')
    .run(skillVersionId, assessmentId);
}

async function resolveSourceType(request: HarvestRequest): Promise<HarvestSourceType> {
  if (request.type !== undefined && request.type !== 'auto') return request.type;
  if (/^https:\/\//iu.test(request.source)) {
    return request.ref !== undefined ||
      request.skillPath !== undefined ||
      /\.git\/?$/iu.test(request.source)
      ? 'git-repository'
      : 'https-archive';
  }
  const stat = await lstat(request.source);
  return stat.isDirectory() ? 'local-directory' : 'zip-archive';
}

function validateRequest(request: HarvestRequest): void {
  if (request.source.trim().length === 0) throw new TypeError('Harvest source cannot be empty');
  if (Buffer.byteLength(request.source, 'utf8') > 8_192) {
    throw new RangeError('Harvest source cannot exceed 8192 UTF-8 bytes');
  }
  if (request.projectId.trim().length === 0 || request.projectId.length > 256) {
    throw new TypeError('Project ID must contain between 1 and 256 characters');
  }
  if (typeof request.inspectOnly !== 'boolean' || typeof request.register !== 'boolean') {
    throw new TypeError('Harvest register and inspectOnly flags must be booleans');
  }
  if (
    request.type !== undefined &&
    !['auto', 'local-directory', 'zip-archive', 'https-archive', 'git-repository'].includes(
      request.type,
    )
  ) {
    throw new TypeError('Harvest source type is invalid');
  }
  if (request.allowedHosts !== undefined && request.allowedHosts.length > 100) {
    throw new RangeError('Harvest host allowlist cannot exceed 100 entries');
  }
  if (request.inspectOnly && request.register) {
    throw new TypeError('inspectOnly and register cannot both be true');
  }
  if (
    (request.ref !== undefined || request.skillPath !== undefined) &&
    request.type === 'https-archive'
  ) {
    throw new TypeError('Git ref and Skill path are only valid for Git sources');
  }
}

function assertProject(database: SqliteDatabase, projectId: string): void {
  const project = database.connection
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(projectId) as { readonly id: string } | undefined;
  if (project === undefined) {
    throw asNexusError(new Error('Harvest project does not exist'), {
      code: 'HARVEST_PROJECT_NOT_FOUND',
      component: 'harvest.pipeline',
      severity: 'high',
    });
  }
}

function hashJson(value: Parameters<typeof stableStringify>[0]): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

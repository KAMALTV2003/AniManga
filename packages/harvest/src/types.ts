import type { JSONValue } from '@nexus-ai/core';
import type { AnalyzedSkillSource, InstalledSkill, SkillLicense } from '@nexus-ai/skills';

export type HarvestSourceType =
  'local-directory' | 'zip-archive' | 'https-archive' | 'git-repository';

export interface HarvestSourceRequest {
  readonly source: string;
  readonly type?: HarvestSourceType | 'auto';
  readonly ref?: string;
  readonly skillPath?: string;
  readonly allowedHosts?: readonly string[];
  readonly projectId: string;
  readonly register: boolean;
  readonly inspectOnly: boolean;
  readonly version?: string;
  readonly author?: string;
}

export type HarvestRequest = HarvestSourceRequest;

export interface HarvestLimits {
  readonly maxDownloadBytes: number;
  readonly maxGitRepositoryBytes: number;
  readonly networkTimeoutMs: number;
  readonly processTimeoutMs: number;
  readonly maxProcessOutputBytes: number;
  readonly maxLicenseFileBytes: number;
  readonly maxScannedTextBytes: number;
}

export const DEFAULT_HARVEST_LIMITS: Readonly<HarvestLimits> = Object.freeze({
  maxDownloadBytes: 30 * 1024 * 1024,
  maxGitRepositoryBytes: 100 * 1024 * 1024,
  networkTimeoutMs: 30_000,
  processTimeoutMs: 60_000,
  maxProcessOutputBytes: 10 * 1024 * 1024,
  maxLicenseFileBytes: 1024 * 1024,
  maxScannedTextBytes: 30 * 1024 * 1024,
});

export function validateHarvestLimits(limits: Readonly<HarvestLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

export interface AcquiredSkillSource {
  readonly analyzed: AnalyzedSkillSource;
  readonly sourceType: HarvestSourceType;
  readonly resolvedCommit: string | null;
  readonly selectedSkillPath: string | null;
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface StaticFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly line: number | null;
  readonly evidenceSha256: string;
  readonly remediation: string;
  readonly fingerprint: string;
}

export interface StaticScanResult {
  readonly scannerVersion: 'nexus.static-skill@1';
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly findings: readonly StaticFinding[];
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly skippedBinaryFiles: number;
}

export interface LicenseReview {
  readonly declaration: string | null;
  readonly spdxExpression: string | null;
  readonly detectedIds: readonly string[];
  readonly evidenceFiles: readonly string[];
  readonly status:
    'missing' | 'spdx-syntax-valid' | 'detected' | 'consistent' | 'conflict' | 'needs-review';
  readonly reviewRequired: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly canonical: SkillLicense;
}

export interface DuplicateProposal {
  readonly id: string;
  readonly target: string;
  readonly targetSkillId: string;
  readonly targetVersionId: string;
  readonly method: 'exact-content-sha256' | 'near-metadata-character-trigram-jaccard-v1';
  readonly confidence: number;
  readonly exact: boolean;
}

export interface AssessmentEvidence {
  readonly type: string;
  readonly description: string;
  readonly value: JSONValue;
}

export interface ScoreDimension {
  readonly dimension:
    'quality' | 'security' | 'documentation' | 'tests' | 'maintenance' | 'contextEfficiency';
  readonly value: number;
  readonly confidence: number;
  readonly evidence: readonly AssessmentEvidence[];
}

export interface HarvestAssessment {
  readonly id: string;
  readonly policyVersion: 'nexus.harvest-policy@1';
  readonly disposition: 'candidate' | 'quarantine';
  readonly risk: StaticScanResult['risk'];
  readonly confidence: number;
  readonly scores: {
    readonly quality: ScoreDimension | null;
    readonly security: ScoreDimension | null;
    readonly documentation: ScoreDimension | null;
    readonly tests: ScoreDimension | null;
    readonly maintenance: ScoreDimension | null;
    readonly contextEfficiency: ScoreDimension | null;
  };
  readonly blockingReasons: readonly string[];
  readonly license: SkillLicense;
  readonly scanId: string;
}

export interface HarvestReport {
  readonly harvestId: string;
  readonly status: 'inspected' | 'quarantined' | 'registered';
  readonly sourceType: HarvestSourceType;
  readonly source: string;
  readonly resolvedCommit: string | null;
  readonly selectedSkillPath: string | null;
  readonly sourceSnapshotSha256: string;
  readonly skillName: string;
  readonly contentHash: string;
  readonly scanId: string;
  readonly scan: StaticScanResult;
  readonly assessmentId: string;
  readonly risk: StaticScanResult['risk'];
  readonly license: LicenseReview;
  readonly findings: readonly StaticFinding[];
  readonly duplicates: readonly DuplicateProposal[];
  readonly assessment: HarvestAssessment;
  readonly quarantinePath: string | null;
  readonly registration: InstalledSkill | null;
  readonly importedCodeExecuted: false;
}

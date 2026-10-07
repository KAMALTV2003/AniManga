import semver from 'semver';
import { z } from 'zod';

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const boundedText = (max: number) => z.string().min(1).max(max);
const nullableScore = z.number().min(0).max(1).nullable();
const canonicalVersion = z
  .string()
  .refine((value) => semver.valid(value) === value, 'Must be canonical SemVer');

export const AgentSkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
    description: z.string().min(1).max(1_024),
    license: z.string().min(1).max(512).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string().min(1).max(128), z.string().max(2_048)).optional(),
    'allowed-tools': z.string().min(1).max(2_048).optional(),
  })
  .strict();

export type AgentSkillFrontmatter = z.infer<typeof AgentSkillFrontmatterSchema>;

export const SkillResourceKindSchema = z.enum([
  'instructions',
  'script',
  'reference',
  'asset',
  'test',
  'example',
  'resource',
]);

export const SkillInventoryEntrySchema = z
  .object({
    path: boundedText(240),
    kind: SkillResourceKindSchema,
    mediaType: boundedText(128),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_PATTERN),
    executableInSource: z.boolean(),
  })
  .strict();

export const SkillScoreV1Schema = z
  .object({
    quality: nullableScore,
    security: nullableScore,
    efficiency: nullableScore,
    compatibility: nullableScore,
    test: nullableScore,
    duplication: nullableScore,
  })
  .strict();

export const SkillScoreSchema = SkillScoreV1Schema.extend({
  maintenance: nullableScore,
  documentation: nullableScore,
}).strict();

export const SkillSourceV1Schema = z
  .object({
    type: z.enum(['local-directory', 'zip-archive']),
    locator: boundedText(4_096),
    commit: z.string().max(256).nullable(),
    archiveSha256: z.string().regex(SHA256_PATTERN).nullable(),
  })
  .strict();

export const SkillSourceSchema = SkillSourceV1Schema.extend({
  type: z.enum(['local-directory', 'zip-archive', 'https-archive', 'git-repository']),
}).strict();

export const SkillAuthorSchema = z
  .object({
    name: z.string().min(1).max(256).nullable(),
    status: z.enum(['declared', 'unknown']),
  })
  .strict();

export const SkillLicenseV1Schema = z
  .object({
    declaration: z.string().min(1).max(512).nullable(),
    status: z.enum(['unverified', 'missing']),
  })
  .strict();

export const SkillLicenseSchema = z
  .object({
    declaration: z.string().min(1).max(512).nullable(),
    status: z.enum([
      'unverified',
      'missing',
      'spdx-syntax-valid',
      'detected',
      'consistent',
      'conflict',
      'needs-review',
    ]),
    spdxExpression: z.string().min(1).max(512).nullable(),
    detectedIds: z.array(z.string().min(1).max(128)).max(20),
    reviewRequired: z.boolean(),
  })
  .strict();

const metadataCommon = {
  id: z.string().regex(/^skill_[a-f0-9]{32}$/u),
  name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
  version: canonicalVersion,
  description: z.string().min(1).max(1_024),
  author: SkillAuthorSchema,
  compatibility: z.string().max(500).nullable(),
  contentHash: z.string().regex(SHA256_PATTERN),
  packageBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  tags: z.array(z.string().min(1).max(64)).max(100),
  dependencies: z.array(z.string().min(1).max(256)).max(100),
  tools: z.array(z.string().min(1).max(256)).max(100),
  risk: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
  resources: z.array(SkillInventoryEntrySchema).max(1_000),
  provenanceId: z.string().regex(/^provenance_[0-9a-f-]{36}$/u),
} as const;

export const NexusSkillMetadataV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...metadataCommon,
    license: SkillLicenseV1Schema,
    source: SkillSourceV1Schema,
    scores: SkillScoreV1Schema,
  })
  .strict();

export const NexusSkillMetadataV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...metadataCommon,
    license: SkillLicenseSchema,
    source: SkillSourceSchema,
    scores: SkillScoreSchema,
    securityScanId: z
      .string()
      .regex(/^security_scan_[a-f0-9]{32}$/u)
      .nullable(),
    assessmentId: z
      .string()
      .regex(/^assessment_[a-f0-9]{32}$/u)
      .nullable(),
  })
  .strict();

export const NexusSkillMetadataSchema = z.discriminatedUnion('schemaVersion', [
  NexusSkillMetadataV1Schema,
  NexusSkillMetadataV2Schema,
]);

export type NexusSkillMetadataV1 = z.infer<typeof NexusSkillMetadataV1Schema>;
export type NexusSkillMetadataV2 = z.infer<typeof NexusSkillMetadataV2Schema>;
export type NexusSkillMetadata = z.infer<typeof NexusSkillMetadataSchema>;
export type SkillInventoryEntry = z.infer<typeof SkillInventoryEntrySchema>;
export type SkillResourceKind = z.infer<typeof SkillResourceKindSchema>;
export type SkillScores = z.infer<typeof SkillScoreSchema>;
export type SkillLicense = z.infer<typeof SkillLicenseSchema>;

export interface SkillIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly path: string | null;
}

export interface SkillAnalysis {
  readonly valid: boolean;
  readonly standardCompliant: boolean;
  readonly frontmatter: AgentSkillFrontmatter | null;
  readonly body: string | null;
  readonly inventory: readonly SkillInventoryEntry[];
  readonly contentHash: string | null;
  readonly totalBytes: number;
  readonly referencedPaths: readonly string[];
  readonly issues: readonly SkillIssue[];
  readonly suggestedVersion: string | null;
  readonly declaredAuthor: string | null;
  readonly existingMetadata: NexusSkillMetadata | null;
}

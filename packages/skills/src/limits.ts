export interface SkillPackageLimits {
  readonly maxArchiveBytes: number;
  readonly maxFiles: number;
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
  readonly maxFileBytes: number;
  readonly maxSkillMarkdownBytes: number;
  readonly maxTotalBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxFrontmatterBytes: number;
  readonly maxFrontmatterLines: number;
  readonly maxMetadataEntries: number;
}

export const DEFAULT_SKILL_LIMITS: Readonly<SkillPackageLimits> = Object.freeze({
  maxArchiveBytes: 30 * 1024 * 1024,
  maxFiles: 1_000,
  maxPathBytes: 240,
  maxPathDepth: 16,
  maxFileBytes: 10 * 1024 * 1024,
  maxSkillMarkdownBytes: 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxFrontmatterBytes: 32 * 1024,
  maxFrontmatterLines: 200,
  maxMetadataEntries: 100,
});

import { createHash } from 'node:crypto';

import { deterministicId, NexusError, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';
import type { SkillAnalysis } from '@nexus-ai/skills';

import type { DuplicateProposal } from './types.js';

interface CandidateRow {
  readonly id: string;
  readonly skill_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly content_sha256: string;
}

export function proposeDuplicates(
  database: SqliteDatabase,
  projectId: string,
  analysis: SkillAnalysis,
  threshold = 0.72,
): readonly DuplicateProposal[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('Duplicate similarity threshold must be between 0 and 1');
  }
  const rows = database.connection
    .prepare(
      `
      SELECT
        sv.id,
        sv.skill_id,
        sv.version,
        s.name,
        s.description,
        sv.content_sha256
      FROM skill_versions AS sv
      JOIN skills AS s ON s.id = sv.skill_id
      WHERE s.project_id = ?
      ORDER BY s.name COLLATE BINARY, sv.version COLLATE BINARY
      LIMIT 10001
    `,
    )
    .all(projectId) as CandidateRow[];
  if (rows.length > 10_000) {
    throw new NexusError({
      code: 'HARVEST_DUPLICATE_INDEX_LIMIT',
      component: 'harvest.duplicates',
      severity: 'high',
      message: 'Duplicate comparison exceeds 10000 registered Skill versions',
    });
  }
  if (analysis.contentHash === null) {
    throw new TypeError('Duplicate analysis requires a valid Skill content hash');
  }
  const sourceContentHash = analysis.contentHash;
  const sourceFeatures = featureSet(
    [
      analysis.frontmatter?.name ?? '',
      analysis.frontmatter?.description ?? '',
      analysis.frontmatter?.metadata?.['tags'] ?? '',
    ].join(' '),
  );
  const proposals: DuplicateProposal[] = [];
  for (const row of rows) {
    const target = `${row.skill_id}@${row.version}`;
    if (row.content_sha256 === sourceContentHash) {
      proposals.push(
        proposal(sourceContentHash, row.skill_id, row.id, target, 'exact-content-sha256', 1, true),
      );
      continue;
    }
    const similarity = jaccard(sourceFeatures, featureSet([row.name, row.description].join(' ')));
    if (similarity >= threshold) {
      proposals.push(
        proposal(
          sourceContentHash,
          row.skill_id,
          row.id,
          target,
          'near-metadata-character-trigram-jaccard-v1',
          Number(similarity.toFixed(6)),
          false,
        ),
      );
    }
  }
  return proposals
    .sort(
      (left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.confidence - left.confidence ||
        left.target.localeCompare(right.target),
    )
    .slice(0, 100);
}

function proposal(
  sourceContentSha256: string,
  targetSkillId: string,
  targetVersionId: string,
  target: string,
  method: DuplicateProposal['method'],
  confidence: number,
  exact: boolean,
): DuplicateProposal {
  const canonical = {
    sourceContentSha256,
    targetSkillId,
    targetVersionId,
    target,
    method,
    confidence,
    exact,
  };
  const digest = createHash('sha256').update(stableStringify(canonical)).digest('hex');
  return {
    id: deterministicId('duplicate', digest),
    targetSkillId,
    targetVersionId,
    target,
    method,
    confidence,
    exact,
  };
}

function featureSet(input: string): ReadonlySet<string> {
  const normalized = input
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  const padded = `  ${normalized}  `;
  const result = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

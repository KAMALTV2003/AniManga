import { createHash } from 'node:crypto';

import { deterministicId, stableStringify, type JSONValue } from '@nexus-ai/core';
import type { SkillAnalysis } from '@nexus-ai/skills';

import type {
  AssessmentEvidence,
  HarvestAssessment,
  LicenseReview,
  ScoreDimension,
  StaticScanResult,
} from './types.js';

export function assessHarvest(
  analysis: SkillAnalysis,
  scan: StaticScanResult,
  license: LicenseReview,
  scanId: string,
  exactDuplicateCount = 0,
): HarvestAssessment {
  const security = securityScore(scan);
  const quality = qualityScore(analysis);
  const documentation = documentationScore(analysis);
  const tests = testScore(analysis);
  const contextEfficiency = contextScore(analysis);
  const scores = {
    quality,
    security,
    documentation,
    tests,
    maintenance: null,
    contextEfficiency,
  } satisfies HarvestAssessment['scores'];

  const blockingReasons: string[] = [];
  if (scan.risk === 'critical' || scan.risk === 'high') {
    blockingReasons.push(`static-security-risk:${scan.risk}`);
  }
  if (license.reviewRequired) blockingReasons.push(`license:${license.status}`);
  if (exactDuplicateCount > 0) blockingReasons.push('duplicate:exact-content');
  const disposition: HarvestAssessment['disposition'] =
    blockingReasons.length > 0 ? 'quarantine' : 'candidate';
  const scoreValues = Object.values(scores).filter(
    (value): value is ScoreDimension => value !== null,
  );
  const confidence = Math.round(
    scoreValues.reduce((total, score) => total + score.confidence, 0) / scoreValues.length,
  );
  const canonical = {
    policyVersion: 'nexus.harvest-policy@1',
    disposition,
    risk: scan.risk,
    confidence,
    scores,
    blockingReasons,
    license: license.canonical,
    scanId,
  } as const;
  const digest = createHash('sha256').update(stableStringify(canonical)).digest('hex');
  return {
    id: deterministicId('assessment', digest),
    ...canonical,
  };
}

function securityScore(scan: StaticScanResult): ScoreDimension {
  const base = { low: 96, medium: 70, high: 30, critical: 0 }[scan.risk];
  const deductions = scan.findings.reduce(
    (total, finding) =>
      total + { info: 0, low: 1, medium: 3, high: 8, critical: 20 }[finding.severity],
    0,
  );
  return dimension(Math.max(0, base - deductions), 85, 'security', [
    evidence('scanner', 'Static scanner and rule-set version', scan.scannerVersion),
    evidence('finding-count', 'Normalized static finding count', scan.findings.length),
    evidence('risk', 'Highest normalized static risk', scan.risk),
    evidence('coverage', 'Text files scanned', scan.scannedFiles),
  ]);
}

function qualityScore(analysis: SkillAnalysis): ScoreDimension {
  const body = analysis.body ?? '';
  const descriptionLength = analysis.frontmatter?.description.trim().length ?? 0;
  const hasAllowedTools = (analysis.frontmatter?.['allowed-tools']?.trim().length ?? 0) > 0;
  const resourceKinds = new Set(analysis.inventory.map((resource) => resource.kind));
  const score = Math.min(
    100,
    45 +
      (descriptionLength >= 40 ? 15 : descriptionLength >= 20 ? 8 : 0) +
      (body.trim().length >= 200 ? 20 : body.trim().length >= 80 ? 10 : 0) +
      (resourceKinds.has('reference') ? 10 : 0) +
      (hasAllowedTools ? 10 : 0),
  );
  return dimension(score, 68, 'quality', [
    evidence('description-length', 'Declared description character count', descriptionLength),
    evidence('instruction-length', 'Instruction character count', body.length),
    evidence('resource-kinds', 'Distinct resource kinds', [...resourceKinds].sort()),
    evidence('tool-declaration', 'Whether allowed tools are explicitly declared', hasAllowedTools),
  ]);
}

function documentationScore(analysis: SkillAnalysis): ScoreDimension {
  const body = analysis.body ?? '';
  const headings = [...body.matchAll(/^#{1,6}\s+\S/gmu)].length;
  const examples = /(?:^|\n)#{1,6}\s+.*examples?/iu.test(body);
  const constraints = /(?:^|\n)#{1,6}\s+.*(?:constraints?|limitations?|safety)/iu.test(body);
  const references = analysis.inventory.filter((resource) => resource.kind === 'reference').length;
  const score = Math.min(
    100,
    30 +
      Math.min(headings * 8, 32) +
      (examples ? 15 : 0) +
      (constraints ? 13 : 0) +
      Math.min(references * 5, 10),
  );
  return dimension(score, 74, 'documentation', [
    evidence('headings', 'Markdown heading count', headings),
    evidence('examples-section', 'Examples section detected', examples),
    evidence('constraints-section', 'Constraints or safety section detected', constraints),
    evidence('reference-files', 'Reference resource count', references),
  ]);
}

function testScore(analysis: SkillAnalysis): ScoreDimension {
  const testArtifacts = analysis.inventory.filter(
    (resource) =>
      /(?:^|\/)(?:tests?|specs?|evals?)(?:\/|$)/iu.test(resource.path) ||
      /(?:\.test|\.spec)\.[A-Za-z0-9]+$/u.test(resource.path),
  );
  const fixtureArtifacts = analysis.inventory.filter((resource) =>
    /(?:^|\/)(?:fixtures?|goldens?)(?:\/|$)/iu.test(resource.path),
  );
  const score = Math.min(70, testArtifacts.length * 25 + fixtureArtifacts.length * 10);
  return dimension(score, 45, 'tests', [
    evidence(
      'test-artifacts',
      'Static test artifact count; tests were not executed',
      testArtifacts.length,
    ),
    evidence('fixture-artifacts', 'Static fixture artifact count', fixtureArtifacts.length),
    evidence('execution', 'Imported tests executed during harvest', false),
  ]);
}

function contextScore(analysis: SkillAnalysis): ScoreDimension {
  const instructionBytes = Buffer.byteLength(analysis.body ?? '', 'utf8');
  const estimatedTokens = Math.ceil(instructionBytes / 4);
  const supplementaryFiles = analysis.inventory.length - 1;
  const score = Math.max(
    0,
    Math.min(100, 100 - Math.floor(estimatedTokens / 80) - Math.max(0, supplementaryFiles - 8) * 2),
  );
  return dimension(score, 70, 'contextEfficiency', [
    evidence('instruction-bytes', 'UTF-8 instruction bytes', instructionBytes),
    evidence(
      'estimated-tokens',
      'Deterministic bytes-divided-by-four estimate, not tokenizer output',
      estimatedTokens,
    ),
    evidence('supplementary-files', 'Files beyond SKILL.md', supplementaryFiles),
  ]);
}

function dimension(
  value: number,
  confidence: number,
  dimensionName: ScoreDimension['dimension'],
  evidenceItems: readonly AssessmentEvidence[],
): ScoreDimension {
  return { dimension: dimensionName, value, confidence, evidence: evidenceItems };
}

function evidence(type: string, description: string, value: JSONValue): AssessmentEvidence {
  return { type, description, value };
}

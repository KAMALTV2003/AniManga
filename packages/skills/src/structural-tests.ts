import type { SkillAnalysis, SkillIssue } from './schemas.js';

export interface SkillStructuralTestCase {
  readonly id: string;
  readonly description: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
  readonly issueCodes: readonly string[];
}

export interface SkillStructuralTestResult {
  readonly suite: 'nexus.skill.structure@1';
  readonly contentHash: string | null;
  readonly passed: boolean;
  readonly behavioralExecution: 'not-performed';
  readonly importedCodeExecuted: false;
  readonly cases: readonly SkillStructuralTestCase[];
}

export function runSkillStructuralTests(analysis: SkillAnalysis): SkillStructuralTestResult {
  const cases = [
    testCase(
      'frontmatter',
      'Agent Skills frontmatter parses against the strict schema',
      'valid strict frontmatter',
      analysis.frontmatter === null ? 'frontmatter unavailable' : 'valid strict frontmatter',
      issuesFor(analysis.issues, ['SKILL_FRONTMATTER']),
    ),
    testCase(
      'directory-and-name',
      'Declared name and package directory agree when required',
      'matching canonical name',
      hasIssue(analysis.issues, ['SKILL_DIRECTORY_NAME'])
        ? 'name mismatch'
        : 'matching canonical name',
      issuesFor(analysis.issues, ['SKILL_DIRECTORY_NAME']),
    ),
    testCase(
      'payload-inventory',
      'Every payload file is bounded and deterministically hashed',
      'complete deterministic inventory',
      analysis.contentHash === null ? 'inventory unavailable' : 'complete deterministic inventory',
      issuesFor(analysis.issues, ['SKILL_FILE', 'SKILL_EXPANSION', 'SKILL_PATH', 'SKILL_SYMLINK']),
    ),
    testCase(
      'resource-references',
      'Local links in SKILL.md stay in-package and resolve',
      'all local references resolve',
      hasIssue(analysis.issues, ['SKILL_REFERENCE'])
        ? 'one or more references are unsafe or missing'
        : 'all local references resolve',
      issuesFor(analysis.issues, ['SKILL_REFERENCE']),
    ),
    testCase(
      'canonical-metadata',
      'Existing NEXUS metadata, when present, matches the payload',
      'absent or payload-consistent metadata',
      hasIssue(analysis.issues, ['SKILL_METADATA'])
        ? 'metadata is invalid or inconsistent'
        : 'absent or payload-consistent metadata',
      issuesFor(analysis.issues, ['SKILL_METADATA']),
    ),
    testCase(
      'instructions',
      'The package contains non-empty operational instructions',
      'non-empty instructions',
      hasIssue(analysis.issues, ['SKILL_BODY_EMPTY'])
        ? 'instructions are empty'
        : 'non-empty instructions',
      issuesFor(analysis.issues, ['SKILL_BODY_EMPTY']),
    ),
  ] as const;

  return {
    suite: 'nexus.skill.structure@1',
    contentHash: analysis.contentHash,
    passed: cases.every((item) => item.passed) && analysis.valid,
    behavioralExecution: 'not-performed',
    importedCodeExecuted: false,
    cases,
  };
}

function testCase(
  id: string,
  description: string,
  expected: string,
  actual: string,
  issues: readonly SkillIssue[],
): SkillStructuralTestCase {
  return {
    id,
    description,
    expected,
    actual,
    passed: issues.every((issue) => issue.severity !== 'error'),
    issueCodes: issues.map((issue) => issue.code),
  };
}

function issuesFor(
  issues: readonly SkillIssue[],
  prefixes: readonly string[],
): readonly SkillIssue[] {
  return issues.filter((issue) => prefixes.some((prefix) => issue.code.startsWith(prefix)));
}

function hasIssue(issues: readonly SkillIssue[], prefixes: readonly string[]): boolean {
  return issuesFor(issues, prefixes).some((issue) => issue.severity === 'error');
}

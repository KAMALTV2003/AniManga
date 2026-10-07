import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';
import semver from 'semver';
import { parseDocument } from 'yaml';

import type { SkillPackageLimits } from './limits.js';
import {
  AgentSkillFrontmatterSchema,
  type AgentSkillFrontmatter,
  type SkillIssue,
} from './schemas.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface ParsedSkillMarkdown {
  readonly frontmatter: AgentSkillFrontmatter | null;
  readonly body: string | null;
  readonly issues: readonly SkillIssue[];
  readonly referencedPaths: readonly string[];
  readonly suggestedVersion: string | null;
  readonly declaredAuthor: string | null;
}

export async function parseSkillMarkdown(
  root: string,
  limits: SkillPackageLimits,
  enforceDirectoryName: boolean,
): Promise<ParsedSkillMarkdown> {
  const manifestPath = path.join(root, 'SKILL.md');
  const text = await readBoundedUtf8(manifestPath, limits.maxSkillMarkdownBytes, 'SKILL.md');
  const issues: SkillIssue[] = [];
  if (text.charCodeAt(0) === 0xfeff) {
    return failed('SKILL_FRONTMATTER_POSITION', 'SKILL.md must not begin with a byte-order mark');
  }

  const lines = text.split(/\r?\n/u);
  if (lines[0] !== '---') {
    return failed(
      'SKILL_FRONTMATTER_MISSING',
      'SKILL.md must begin with a YAML frontmatter delimiter',
    );
  }

  let closingLine = -1;
  let frontmatterBytes = 0;
  for (let index = 1; index < lines.length; index += 1) {
    frontmatterBytes += Buffer.byteLength(lines[index] ?? '', 'utf8') + 1;
    if (frontmatterBytes > limits.maxFrontmatterBytes || index > limits.maxFrontmatterLines) {
      return failed('SKILL_FRONTMATTER_LIMIT', 'SKILL.md frontmatter exceeds its parsing limit');
    }
    if (lines[index] === '---') {
      closingLine = index;
      break;
    }
  }
  if (closingLine < 0) {
    return failed('SKILL_FRONTMATTER_UNCLOSED', 'SKILL.md has no closing frontmatter delimiter');
  }

  const yamlSource = lines.slice(1, closingLine).join('\n');
  const document = parseDocument(yamlSource, {
    customTags: [],
    prettyErrors: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return failed(
      'SKILL_FRONTMATTER_YAML',
      `Invalid YAML frontmatter: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return failed(
      'SKILL_FRONTMATTER_ALIAS',
      `YAML aliases are not allowed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = AgentSkillFrontmatterSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code:
          issue.code === 'unrecognized_keys'
            ? 'SKILL_FRONTMATTER_UNKNOWN_FIELD'
            : 'SKILL_FRONTMATTER_SCHEMA',
        severity: 'error',
        message: issue.message,
        path: issue.path.length === 0 ? 'SKILL.md' : `SKILL.md:${issue.path.join('.')}`,
      });
    }
    return emptyResult(issues);
  }

  const frontmatter = parsed.data;
  if (Object.keys(frontmatter.metadata ?? {}).length > limits.maxMetadataEntries) {
    issues.push({
      code: 'SKILL_METADATA_LIMIT',
      severity: 'error',
      message: `metadata exceeds ${String(limits.maxMetadataEntries)} entries`,
      path: 'SKILL.md:metadata',
    });
  }
  if (/<\/?[a-z][^>]*>/iu.test(frontmatter.description)) {
    issues.push({
      code: 'SKILL_DESCRIPTION_MARKUP',
      severity: 'error',
      message: 'description must be plain text without markup tags',
      path: 'SKILL.md:description',
    });
  }

  if (enforceDirectoryName && path.basename(root) !== frontmatter.name) {
    issues.push({
      code: 'SKILL_DIRECTORY_NAME_MISMATCH',
      severity: 'error',
      message: `Skill directory ${path.basename(root)} must equal declared name ${frontmatter.name}`,
      path: 'SKILL.md:name',
    });
  }

  const body = lines.slice(closingLine + 1).join('\n');
  if (body.trim().length === 0) {
    issues.push({
      code: 'SKILL_BODY_EMPTY',
      severity: 'error',
      message: 'SKILL.md must contain operational instructions after frontmatter',
      path: 'SKILL.md',
    });
  }
  const bodyLines = body.split(/\r?\n/u).length;
  if (bodyLines > 500) {
    issues.push({
      code: 'SKILL_PROGRESSIVE_DISCLOSURE',
      severity: 'warning',
      message: `SKILL.md has ${String(bodyLines)} body lines; move detailed material to references/`,
      path: 'SKILL.md',
    });
  }
  if (
    !/\b(?:use\s+when|when|for\s+(?:tasks|requests|workflows))\b/iu.test(frontmatter.description)
  ) {
    issues.push({
      code: 'SKILL_DESCRIPTION_TRIGGER_WEAK',
      severity: 'warning',
      message: 'description should state when the skill should be selected',
      path: 'SKILL.md:description',
    });
  }

  const declaredVersion = frontmatter.metadata?.['version'] ?? null;
  const suggestedVersion =
    declaredVersion !== null && semver.valid(declaredVersion) === declaredVersion
      ? declaredVersion
      : null;
  if (declaredVersion !== null && suggestedVersion === null) {
    issues.push({
      code: 'SKILL_VERSION_INVALID',
      severity: 'error',
      message: 'metadata.version must be canonical semantic versioning',
      path: 'SKILL.md:metadata.version',
    });
  }

  return {
    frontmatter,
    body,
    issues,
    referencedPaths: extractRelativeReferences(body, issues),
    suggestedVersion,
    declaredAuthor: frontmatter.metadata?.['author']?.trim() || null,
  };

  function failed(code: string, message: string): ParsedSkillMarkdown {
    return emptyResult([{ code, severity: 'error', message, path: 'SKILL.md' }]);
  }
}

function extractRelativeReferences(body: string, issues: SkillIssue[]): readonly string[] {
  const references = new Set<string>();
  const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of body.matchAll(markdownLink)) {
    let target = (match[1] ?? '').trim();
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/u, 1)[0] ?? target;
    if (
      target === '' ||
      target.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
      target.startsWith('//')
    ) {
      continue;
    }
    target = target.split(/[?#]/u, 1)[0] ?? target;
    try {
      target = decodeURIComponent(target);
    } catch {
      issues.push({
        code: 'SKILL_REFERENCE_ENCODING',
        severity: 'error',
        message: `Reference has invalid percent encoding: ${target}`,
        path: 'SKILL.md',
      });
      continue;
    }
    if (
      path.posix.isAbsolute(target) ||
      path.win32.isAbsolute(target) ||
      target.includes('\\') ||
      target.split('/').some((component) => component === '..')
    ) {
      issues.push({
        code: 'SKILL_REFERENCE_UNSAFE',
        severity: 'error',
        message: `Reference must stay within the skill package: ${target}`,
        path: 'SKILL.md',
      });
      continue;
    }
    const normalized = path.posix.normalize(target).replace(/^\.\//u, '');
    if (normalized !== '.' && normalized !== '') references.add(normalized);
  }
  return [...references].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

async function readBoundedUtf8(filePath: string, maxBytes: number, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new NexusError({
        code: 'SKILL_FILE_LIMIT',
        component: 'skills',
        severity: 'high',
        message: `${label} is not a regular file within the ${String(maxBytes)} byte limit`,
      });
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) {
      throw new NexusError({
        code: 'SKILL_FILE_CHANGED',
        component: 'skills',
        severity: 'high',
        message: `${label} changed while being read`,
      });
    }
    const text = buffer.toString('utf8');
    if (Buffer.from(text, 'utf8').compare(buffer) !== 0) {
      throw new NexusError({
        code: 'SKILL_TEXT_ENCODING',
        component: 'skills',
        severity: 'high',
        message: `${label} must be valid UTF-8`,
      });
    }
    return text;
  } finally {
    await handle?.close();
  }
}

function emptyResult(issues: readonly SkillIssue[]): ParsedSkillMarkdown {
  return {
    frontmatter: null,
    body: null,
    issues,
    referencedPaths: [],
    suggestedVersion: null,
    declaredAuthor: null,
  };
}

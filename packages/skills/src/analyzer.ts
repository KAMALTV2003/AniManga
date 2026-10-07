import { constants as fsConstants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';

import { parseSkillMarkdown } from './frontmatter.js';
import { inventorySkillDirectory } from './inventory.js';
import { DEFAULT_SKILL_LIMITS, type SkillPackageLimits } from './limits.js';
import {
  NexusSkillMetadataSchema,
  type NexusSkillMetadata,
  type SkillAnalysis,
  type SkillInventoryEntry,
  type SkillIssue,
} from './schemas.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

export interface AnalyzeSkillOptions {
  readonly limits?: Readonly<SkillPackageLimits>;
  readonly enforceDirectoryName?: boolean;
  readonly executableOverrides?: ReadonlySet<string>;
}

export async function analyzeSkillDirectory(
  root: string,
  options: AnalyzeSkillOptions = {},
): Promise<SkillAnalysis> {
  const limits = options.limits ?? DEFAULT_SKILL_LIMITS;
  const inventory = await inventorySkillDirectory(root, limits, options.executableOverrides);
  const parsed = await parseSkillMarkdown(root, limits, options.enforceDirectoryName ?? true);
  const issues = [...parsed.issues];
  const paths = new Set(inventory.entries.map((entry) => entry.path));

  for (const reference of parsed.referencedPaths) {
    if (!paths.has(reference)) {
      issues.push({
        code: 'SKILL_REFERENCE_MISSING',
        severity: 'error',
        message: `Referenced package resource does not exist: ${reference}`,
        path: 'SKILL.md',
      });
    }
  }

  const standardCompliant = !issues.some((issue) => issue.severity === 'error');
  const existingMetadata = await loadExistingMetadata(root, limits, issues);
  let effectiveInventory = inventory.entries;
  if (existingMetadata !== null) {
    const metadataMatches = verifyExistingMetadata(
      existingMetadata,
      inventory,
      parsed.frontmatter?.name ?? null,
      issues,
    );
    if (metadataMatches) {
      const executableByPath = new Map(
        existingMetadata.resources.map((resource) => [resource.path, resource.executableInSource]),
      );
      effectiveInventory = inventory.entries.map((resource) => ({
        ...resource,
        executableInSource: executableByPath.get(resource.path) ?? false,
      }));
    }
    if (parsed.suggestedVersion !== null && existingMetadata.version !== parsed.suggestedVersion) {
      issues.push({
        code: 'SKILL_METADATA_VERSION_MISMATCH',
        severity: 'error',
        message: 'metadata.json version does not match SKILL.md metadata.version',
        path: 'metadata.json:version',
      });
    }
  }

  const valid = !issues.some((issue) => issue.severity === 'error');
  return {
    valid,
    standardCompliant,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    inventory: effectiveInventory,
    contentHash: inventory.contentHash,
    totalBytes: inventory.totalBytes,
    referencedPaths: parsed.referencedPaths,
    issues,
    suggestedVersion: existingMetadata?.version ?? parsed.suggestedVersion,
    declaredAuthor: existingMetadata?.author.name ?? parsed.declaredAuthor,
    existingMetadata,
  };
}

async function loadExistingMetadata(
  root: string,
  limits: SkillPackageLimits,
  issues: SkillIssue[],
): Promise<NexusSkillMetadata | null> {
  const metadataPath = path.join(root, 'metadata.json');
  try {
    await access(metadataPath, fsConstants.F_OK);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  let text: string;
  let handle;
  try {
    handle = await open(metadataPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > Math.min(limits.maxFileBytes, 2 * 1024 * 1024)) {
      throw new NexusError({
        code: 'SKILL_METADATA_LIMIT',
        component: 'skills',
        severity: 'high',
        message: 'metadata.json is not a bounded regular file',
      });
    }
    text = await handle.readFile('utf8');
  } finally {
    await handle?.close();
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    issues.push({
      code: 'SKILL_METADATA_JSON',
      severity: 'error',
      message: `metadata.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path: 'metadata.json',
    });
    return null;
  }
  const parsed = NexusSkillMetadataSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: 'SKILL_METADATA_SCHEMA',
        severity: 'error',
        message: issue.message,
        path: `metadata.json${issue.path.length === 0 ? '' : `:${issue.path.join('.')}`}`,
      });
    }
    return null;
  }
  return parsed.data;
}

function verifyExistingMetadata(
  metadata: NexusSkillMetadata,
  inventory: Awaited<ReturnType<typeof inventorySkillDirectory>>,
  declaredName: string | null,
  issues: SkillIssue[],
): boolean {
  const issueCountBefore = issues.length;
  if (declaredName !== null && metadata.name !== declaredName) {
    issues.push({
      code: 'SKILL_METADATA_NAME_MISMATCH',
      severity: 'error',
      message: 'metadata.json name does not match SKILL.md',
      path: 'metadata.json:name',
    });
  }
  if (metadata.contentHash !== inventory.contentHash) {
    issues.push({
      code: 'SKILL_METADATA_HASH_MISMATCH',
      severity: 'error',
      message: 'metadata.json contentHash does not match package payload',
      path: 'metadata.json:contentHash',
    });
  }
  if (metadata.packageBytes !== inventory.totalBytes) {
    issues.push({
      code: 'SKILL_METADATA_SIZE_MISMATCH',
      severity: 'error',
      message: 'metadata.json packageBytes does not match package payload',
      path: 'metadata.json:packageBytes',
    });
  }
  const withoutExecutableFlag = (
    resource: SkillInventoryEntry,
  ): Omit<SkillInventoryEntry, 'executableInSource'> => {
    const { executableInSource, ...contentIdentity } = resource;
    void executableInSource;
    return contentIdentity;
  };
  const metadataResources = metadata.resources.map(withoutExecutableFlag);
  const inventoriedResources = inventory.entries.map(withoutExecutableFlag);
  if (JSON.stringify(metadataResources) !== JSON.stringify(inventoriedResources)) {
    issues.push({
      code: 'SKILL_METADATA_INVENTORY_MISMATCH',
      severity: 'error',
      message: 'metadata.json resources do not match deterministic inventory',
      path: 'metadata.json:resources',
    });
  }
  return issues.length === issueCountBefore;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

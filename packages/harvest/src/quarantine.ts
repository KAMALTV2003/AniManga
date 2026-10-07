import { constants as fsConstants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { NexusError } from '@nexus-ai/core';
import type { AnalyzedSkillSource } from '@nexus-ai/skills';

export async function quarantineSkill(
  input: AnalyzedSkillSource,
  dataDirectory: string,
  harvestId: string,
  assessmentId: string,
): Promise<string> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(dataDirectory);
  const quarantineRoot = path.join(dataRoot, 'quarantine');
  const temporaryRoot = path.join(dataRoot, 'tmp');
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(temporaryRoot, 'quarantine-'));
  const skillName = input.analysis.frontmatter?.name;
  if (skillName === undefined) {
    throw quarantineError(
      'HARVEST_SKILL_INVALID',
      'Cannot quarantine a Skill without a valid name',
    );
  }
  const stagedContainer = path.join(stage, 'candidate');
  const stagedPayload = path.join(stagedContainer, skillName);
  const finalContainer = path.join(quarantineRoot, harvestId);
  const finalPayload = path.join(finalContainer, skillName);
  try {
    await mkdir(stagedPayload, { recursive: true, mode: 0o700 });
    const canonicalSource = await realpath(input.source.root);
    for (const expected of input.analysis.inventory) {
      const source = path.join(input.source.root, ...expected.path.split('/'));
      const canonicalFile = await realpath(source);
      if (!isInside(canonicalSource, canonicalFile)) {
        throw quarantineError('HARVEST_QUARANTINE_BOUNDARY', 'Source escaped its analyzed root');
      }
      let sourceHandle;
      try {
        sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const stat = await sourceHandle.stat();
        if (!stat.isFile() || stat.size !== expected.bytes) {
          throw quarantineError('HARVEST_SOURCE_CHANGED', `Source changed: ${expected.path}`);
        }
        const content = await sourceHandle.readFile();
        if (createHash('sha256').update(content).digest('hex') !== expected.sha256) {
          throw quarantineError('HARVEST_SOURCE_CHANGED', `Source changed: ${expected.path}`);
        }
        const destination = path.join(stagedPayload, ...expected.path.split('/'));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { flag: 'wx', mode: 0o400, flush: true });
      } finally {
        await sourceHandle?.close();
      }
    }
    await writeFile(
      path.join(stagedContainer, 'quarantine.json'),
      `${JSON.stringify(
        {
          harvestId,
          assessmentId,
          contentHash: input.analysis.contentHash,
          executableBitsRemoved: true,
          importedCodeExecuted: false,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o400, encoding: 'utf8', flush: true },
    );
    await rename(stagedContainer, finalContainer).catch((error: unknown) => {
      throw quarantineError(
        'HARVEST_QUARANTINE_PUBLISH_FAILED',
        'Could not atomically publish quarantine artifact',
        error,
      );
    });
    return finalPayload;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function quarantineError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({
    code,
    component: 'harvest.quarantine',
    severity: 'high',
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

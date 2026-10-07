import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';
import {
  DEFAULT_SKILL_LIMITS,
  analyzeSkillSource,
  type AnalyzedSkillSource,
  type SkillPackageLimits,
} from '@nexus-ai/skills';

import { downloadArchive, validatePublicHttpsUrl } from './network.js';
import { DEFAULT_HARVEST_LIMITS, validateHarvestLimits, type HarvestLimits } from './types.js';

export async function acquireHttpsSkill(
  sourceUrl: string,
  temporaryParent: string,
  options: {
    readonly allowedHosts?: readonly string[];
    readonly harvestLimits?: Readonly<HarvestLimits>;
    readonly skillLimits?: Readonly<SkillPackageLimits>;
  } = {},
): Promise<AnalyzedSkillSource> {
  const harvestLimits = options.harvestLimits ?? DEFAULT_HARVEST_LIMITS;
  validateHarvestLimits(harvestLimits);
  const skillLimits = options.skillLimits ?? DEFAULT_SKILL_LIMITS;
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(await realpath(temporaryParent), 'https-harvest-'));
  try {
    const remote = await validatePublicHttpsUrl(
      sourceUrl,
      options.allowedHosts,
      harvestLimits.networkTimeoutMs,
    );
    const downloaded = await downloadArchive(
      remote,
      path.join(workspace, 'source.zip'),
      harvestLimits,
    );
    const inner = await analyzeSkillSource(
      downloaded.path,
      path.join(workspace, 'import'),
      skillLimits,
    );
    if (inner.source.archiveSha256 !== downloaded.sha256) {
      await inner.source.cleanup();
      throw new NexusError({
        code: 'HARVEST_ARCHIVE_HASH_DRIFT',
        component: 'harvest.http',
        severity: 'critical',
        message: 'Downloaded archive hash changed before Skill analysis',
      });
    }
    let cleaned = false;
    return {
      analysis: inner.analysis,
      source: {
        ...inner.source,
        type: 'https-archive',
        locator: remote.url.href,
        archiveSha256: downloaded.sha256,
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await inner.source.cleanup();
          await rm(workspace, { recursive: true, force: true });
        },
      },
    };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

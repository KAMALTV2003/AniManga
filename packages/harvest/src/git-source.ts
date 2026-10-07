import { lstat, mkdir, mkdtemp, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NexusError } from '@nexus-ai/core';
import {
  DEFAULT_SKILL_LIMITS,
  analyzeSkillDirectory,
  assertUniqueSkillPath,
  validateSkillRelativePath,
  type AnalyzedSkillSource,
  type SkillPackageLimits,
} from '@nexus-ai/skills';

import { gitCurlResolve, validatePublicHttpsUrl } from './network.js';
import { runCommand } from './process.js';
import { DEFAULT_HARVEST_LIMITS, validateHarvestLimits, type HarvestLimits } from './types.js';

interface GitTreeEntry {
  readonly mode: string;
  readonly type: 'blob' | 'commit';
  readonly oid: string;
  readonly bytes: number | null;
  readonly path: string;
}

export interface GitAcquisitionResult {
  readonly analyzed: AnalyzedSkillSource;
  readonly commit: string;
  readonly skillPath: string;
}

export async function acquireGitSkill(
  sourceUrl: string,
  temporaryParent: string,
  options: {
    readonly ref?: string;
    readonly skillPath?: string;
    readonly allowedHosts?: readonly string[];
    readonly harvestLimits?: Readonly<HarvestLimits>;
    readonly skillLimits?: Readonly<SkillPackageLimits>;
  } = {},
): Promise<GitAcquisitionResult> {
  const harvestLimits = options.harvestLimits ?? DEFAULT_HARVEST_LIMITS;
  validateHarvestLimits(harvestLimits);
  const skillLimits = options.skillLimits ?? DEFAULT_SKILL_LIMITS;
  validateGitRef(options.ref);
  const requestedSkillPath = normalizeRequestedSkillPath(options.skillPath);
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(await realpath(temporaryParent), 'git-harvest-'));
  const repository = path.join(workspace, 'repository.git');
  try {
    const remote = await validatePublicHttpsUrl(
      sourceUrl,
      options.allowedHosts,
      harvestLimits.networkTimeoutMs,
    );
    const home = path.join(workspace, 'home');
    const template = path.join(workspace, 'empty-template');
    await mkdir(home, { mode: 0o700 });
    await mkdir(template, { mode: 0o700 });
    const environment = gitEnvironment(home);
    const cloneArguments = [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'fetch.fsckObjects=true',
      '-c',
      'transfer.fsckObjects=true',
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.proxy=',
      '-c',
      `http.curloptResolve=${gitCurlResolve(remote)}`,
      'clone',
      '--bare',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      `--template=${template}`,
      ...(options.ref === undefined ? [] : ['--branch', options.ref]),
      '--',
      remote.url.href,
      repository,
    ];
    await runCommand('git', cloneArguments, {
      cwd: workspace,
      env: environment,
      timeoutMs: harvestLimits.processTimeoutMs,
      maxOutputBytes: harvestLimits.maxProcessOutputBytes,
      monitoredDirectory: repository,
      maxWorkspaceBytes: harvestLimits.maxGitRepositoryBytes,
    });
    if ((await directoryBytes(repository)) > harvestLimits.maxGitRepositoryBytes) {
      throw gitError(
        'HARVEST_GIT_SIZE_LIMIT',
        `Git repository exceeds ${String(harvestLimits.maxGitRepositoryBytes)} bytes`,
      );
    }

    await git(
      repository,
      ['fsck', '--strict', '--no-dangling'],
      workspace,
      environment,
      harvestLimits,
    );
    const commitOutput = await git(
      repository,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      workspace,
      environment,
      harvestLimits,
    );
    const commit = commitOutput.stdout.toString('utf8').trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
      throw gitError('HARVEST_GIT_COMMIT_INVALID', 'Git returned an invalid commit identifier');
    }

    const treeOutput = await git(
      repository,
      ['ls-tree', '-lrz', '--full-tree', '-r', 'HEAD'],
      workspace,
      environment,
      harvestLimits,
    );
    const tree = parseTree(treeOutput.stdout);
    const selectedRoot = selectSkillRoot(tree, requestedSkillPath);
    const selected = tree.filter((entry) =>
      selectedRoot === '' ? true : entry.path.startsWith(`${selectedRoot}/`),
    );
    if (selected.length > skillLimits.maxFiles) {
      throw gitError('SKILL_FILE_LIMIT', `Git Skill exceeds ${String(skillLimits.maxFiles)} files`);
    }

    const outputRoot = path.join(
      workspace,
      'materialized',
      selectedRoot === '' ? 'repository-root' : path.posix.basename(selectedRoot),
    );
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const exactPaths = new Set<string>();
    const collisionKeys = new Map<string, string>();
    const executablePaths = new Set<string>();
    let totalBytes = 0;

    for (const entry of selected) {
      const relative = selectedRoot === '' ? entry.path : entry.path.slice(selectedRoot.length + 1);
      const validated = validateSkillRelativePath(relative, skillLimits);
      assertUniqueSkillPath(validated, exactPaths, collisionKeys);
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw gitError(
          entry.mode === '120000' ? 'SKILL_SYMLINK_REJECTED' : 'SKILL_SPECIAL_FILE_REJECTED',
          `Unsupported Git tree entry: ${entry.path}`,
        );
      }
      const bytes = entry.bytes;
      if (bytes === null) {
        throw gitError('HARVEST_GIT_TREE_INVALID', `Git blob size is missing: ${entry.path}`);
      }
      const fileLimit =
        validated.path === 'SKILL.md'
          ? skillLimits.maxSkillMarkdownBytes
          : skillLimits.maxFileBytes;
      if (bytes > fileLimit) {
        throw gitError('SKILL_FILE_LIMIT', `${validated.path} exceeds ${String(fileLimit)} bytes`);
      }
      totalBytes += bytes;
      if (totalBytes > skillLimits.maxTotalBytes) {
        throw gitError('SKILL_EXPANSION_LIMIT', 'Git Skill exceeds its total byte limit');
      }
      const blob = await git(repository, ['cat-file', 'blob', entry.oid], workspace, environment, {
        ...harvestLimits,
        maxProcessOutputBytes: Math.min(harvestLimits.maxProcessOutputBytes, fileLimit + 8_192),
      });
      if (blob.stdout.byteLength !== bytes) {
        throw gitError('HARVEST_GIT_BLOB_SIZE', `Git blob size changed: ${entry.path}`);
      }
      const destination = path.join(outputRoot, ...validated.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, blob.stdout, { flag: 'wx', mode: 0o600, flush: true });
      if (entry.mode === '100755') executablePaths.add(validated.path);
    }

    const analysis = await analyzeSkillDirectory(outputRoot, {
      limits: skillLimits,
      enforceDirectoryName: selectedRoot !== '',
      executableOverrides: executablePaths,
    });
    let cleaned = false;
    const analyzed: AnalyzedSkillSource = {
      analysis,
      source: {
        root: outputRoot,
        type: 'git-repository',
        locator: remote.url.href,
        archiveSha256: null,
        enforceDirectoryName: selectedRoot !== '',
        executablePaths,
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await rm(workspace, { recursive: true, force: true });
        },
      },
    };
    return { analyzed, commit, skillPath: selectedRoot === '' ? '.' : selectedRoot };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

function selectSkillRoot(tree: readonly GitTreeEntry[], requested?: string): string {
  const candidates = tree
    .filter(
      (entry) =>
        entry.type === 'blob' && (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md')),
    )
    .map((entry) => path.posix.dirname(entry.path))
    .map((directory) => (directory === '.' ? '' : directory));
  if (requested !== undefined) {
    if (!candidates.includes(requested)) {
      throw gitError('HARVEST_SKILL_NOT_FOUND', 'Requested Git path does not contain SKILL.md');
    }
    return requested;
  }
  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    throw gitError('HARVEST_SKILL_NOT_FOUND', 'Git repository contains no SKILL.md');
  }
  if (unique.length > 1) {
    throw gitError(
      'HARVEST_SKILL_SELECTION_REQUIRED',
      'Git repository contains multiple Skills; select one with --skill-path',
    );
  }
  return unique[0] ?? '';
}

function parseTree(output: Buffer): readonly GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch (error) {
    throw gitError('HARVEST_GIT_PATH_ENCODING', 'Git tree path must be valid UTF-8', error);
  }
  for (const record of decoded.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw gitError('HARVEST_GIT_TREE_INVALID', 'Malformed Git tree record');
    const header = record.slice(0, tab);
    const entryPath = record.slice(tab + 1);
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+(\d+|-)$/u.exec(header);
    if (match === null) throw gitError('HARVEST_GIT_TREE_INVALID', 'Malformed Git tree metadata');
    entries.push({
      mode: match[1] ?? '',
      type: (match[2] ?? 'blob') as 'blob' | 'commit',
      oid: match[3] ?? '',
      bytes: match[4] === '-' ? null : Number(match[4]),
      path: entryPath,
    });
  }
  return entries;
}

async function git(
  repository: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  limits: HarvestLimits,
) {
  return await runCommand('git', [`--git-dir=${repository}`, ...args], {
    cwd,
    env,
    timeoutMs: limits.processTimeoutMs,
    maxOutputBytes: limits.maxProcessOutputBytes,
  });
}

function gitEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: 'false',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function normalizeRequestedSkillPath(requested: string | undefined): string | undefined {
  if (requested === undefined) return undefined;
  if (Buffer.byteLength(requested, 'utf8') > 240) {
    throw gitError('HARVEST_SKILL_PATH_INVALID', 'Requested Git Skill path is too long');
  }
  const normalized = requested === '.' ? '' : requested.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (normalized === '') return '';
  if (
    normalized.includes('\\') ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((component) => component === '..' || component === '')
  ) {
    throw gitError('HARVEST_SKILL_PATH_INVALID', 'Requested Git Skill path is unsafe');
  }
  return normalized;
}

function validateGitRef(ref: string | undefined): void {
  if (ref === undefined) return;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref.endsWith('.') ||
    ref.endsWith('/') ||
    ref.split('/').some((part) => part.endsWith('.lock'))
  ) {
    throw gitError('HARVEST_GIT_REF_INVALID', 'Git ref is not a safe branch or tag name');
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) {
      const file = await lstat(target);
      total += file.size;
    }
  }
  return total;
}

function gitError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({
    code,
    component: 'harvest.git',
    severity: 'high',
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

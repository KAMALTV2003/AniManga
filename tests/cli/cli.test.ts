import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const cli = resolve('apps/cli/dist/main.js');

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.global-config') },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('nexus CLI', () => {
  it('initializes and validates a real project database end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-cli-'));
    roots.push(root);

    const initialized = run(root, 'init', '.');
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      status: 'initialized',
      schemaVersion: 6,
    });

    const doctor = run(root, 'doctor');
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ status: 'healthy' });

    const status = run(root, 'status');
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: 'healthy',
      counts: { projects: 1, skills: 0, events: 0 },
    });

    const validation = run(root, 'validate');
    expect(validation.status).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true, schemaVersion: 6 });

    const migration = run(root, 'migrate');
    expect(migration.status).toBe(0);
    expect(JSON.parse(migration.stdout)).toMatchObject({
      migrated: false,
      fromVersion: 6,
      toVersion: 6,
      health: 'healthy',
    });
  });

  it('analyzes, tests, installs, searches, and verifies an inert Skill end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-cli-skill-'));
    roots.push(root);
    expect(run(root, 'init', '.').status).toBe(0);

    const skillRoot = join(root, 'release-notes');
    mkdirSync(join(skillRoot, 'scripts'), { recursive: true });
    mkdirSync(join(skillRoot, 'references'), { recursive: true });
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `---\nname: release-notes\ndescription: Create release notes. Use when publishing a release.\nmetadata:\n  version: 1.0.0\n  tags: release, documentation\n  api_key: not-a-real-secret\n---\n# Instructions\n\nRead [the guide](references/guide.md).\n`,
    );
    writeFileSync(join(skillRoot, 'references', 'guide.md'), 'Be concise.\n');
    const marker = join(root, 'IMPORTED_CODE_EXECUTED');
    const script = join(skillRoot, 'scripts', 'never-run.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(script, 0o700);

    const analysis = run(root, 'skill', 'analyze', skillRoot);
    expect(analysis.status).toBe(0);
    expect(JSON.parse(analysis.stdout)).toMatchObject({
      valid: true,
      importedCodeExecuted: false,
      frontmatter: {
        name: 'release-notes',
        metadata: { api_key: '[REDACTED]' },
      },
    });
    const tested = run(root, 'skill', 'test', skillRoot);
    expect(tested.status).toBe(0);
    expect(JSON.parse(tested.stdout)).toMatchObject({ passed: true, importedCodeExecuted: false });
    const harvested = run(root, 'skill', 'harvest', skillRoot, '--inspect-only');
    expect(harvested.status).toBe(0);
    expect(JSON.parse(harvested.stdout)).toMatchObject({
      status: 'inspected',
      assessment: { disposition: 'quarantine' },
      registration: null,
      quarantinePath: null,
      importedCodeExecuted: false,
    });
    expect(harvested.stdout).not.toContain('touch ');

    const installation = run(root, 'skill', 'install', skillRoot, '--trusted-local-authoring');
    expect(installation.status).toBe(0);
    const installed = JSON.parse(installation.stdout) as { skillId: string; installed: boolean };
    expect(installed.installed).toBe(true);
    const search = run(root, 'skill', 'search', 'release');
    expect(search.status).toBe(0);
    expect(JSON.parse(search.stdout)).toEqual([
      expect.objectContaining({ id: installed.skillId, name: 'release-notes', version: '1.0.0' }),
    ]);
    const graphSync = run(root, 'capability', 'sync');
    expect(graphSync.status).toBe(0);
    expect(JSON.parse(graphSync.stdout)).toMatchObject({ indexedSkills: 1, dependencyEdges: 0 });
    const capabilitySearch = run(root, 'capability', 'search', 'publishing a release');
    expect(capabilitySearch.status).toBe(0);
    expect(JSON.parse(capabilitySearch.stdout)).toMatchObject({
      results: [expect.objectContaining({ name: 'release-notes' })],
    });
    const composition = run(
      root,
      'capability',
      'compose',
      'prepare publishing output',
      '--require',
      'release',
    );
    expect(composition.status).toBe(0);
    expect(JSON.parse(composition.stdout)).toMatchObject({
      status: 'complete',
      selected: [expect.objectContaining({ name: 'release-notes' })],
      uncoveredCapabilities: [],
    });

    const verification = run(root, 'skill', 'verify', installed.skillId);
    expect(verification.status).toBe(0);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      structuralTests: { passed: true, importedCodeExecuted: false },
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to overwrite an initialized project and emits a structured error', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-cli-'));
    roots.push(root);
    expect(run(root, 'init', '.').status).toBe(0);

    const second = run(root, 'init', '.');
    expect(second.status).toBe(1);
    expect(JSON.parse(second.stderr)).toMatchObject({
      error: { code: 'INIT_ALREADY_CONFIGURED', component: 'cli.init' },
    });
  });
});

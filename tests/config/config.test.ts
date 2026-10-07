import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultConfig, loadNexusConfig, serializeConfig } from '@nexus-ai/config';
import type { NexusError } from '@nexus-ai/core';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-config-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('configuration loader', () => {
  it('loads YAML, .env, and explicit environment overrides with strict validation', () => {
    const root = project();
    const config = createDefaultConfig(root, 'test-project');
    writeFileSync(join(root, 'nexus.config.yaml'), serializeConfig(config));
    writeFileSync(join(root, '.env'), 'NEXUS_LOG_LEVEL=debug\n');
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: join(root, 'global'),
      NEXUS_DATABASE_PATH: '.nexus/custom.db',
    };

    const loaded = loadNexusConfig({ startDir: root, env });

    expect(loaded.config.logging.level).toBe('debug');
    expect(loaded.config.database.path).toBe(join(root, '.nexus/custom.db'));
    expect(loaded.config.project.name).toBe('test-project');
  });

  it('rejects unknown keys instead of silently ignoring configuration mistakes', () => {
    const root = project();
    const config = createDefaultConfig(root);
    writeFileSync(join(root, 'nexus.config.json'), JSON.stringify({ ...config, unexpected: true }));

    expect(() =>
      loadNexusConfig({ startDir: root, env: { XDG_CONFIG_HOME: join(root, 'global') } }),
    ).toThrowError(expect.objectContaining<NexusError>({ code: 'CONFIG_VALIDATION_FAILED' }));
  });

  it('blocks database and log paths that escape through traversal', () => {
    const root = project();
    const config = createDefaultConfig(root);
    writeFileSync(
      join(root, 'nexus.config.json'),
      JSON.stringify({ ...config, database: { ...config.database, path: '../outside.db' } }),
    );

    expect(() =>
      loadNexusConfig({ startDir: root, env: { XDG_CONFIG_HOME: join(root, 'global') } }),
    ).toThrowError(expect.objectContaining<NexusError>({ code: 'CONFIG_PATH_ESCAPE' }));
  });

  it('blocks project-local paths whose existing symlink ancestor escapes', () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, 'state'));
    const config = createDefaultConfig(root);
    writeFileSync(
      join(root, 'nexus.config.json'),
      JSON.stringify({ ...config, database: { ...config.database, path: 'state/nexus.db' } }),
    );

    expect(() =>
      loadNexusConfig({ startDir: root, env: { XDG_CONFIG_HOME: join(root, 'global') } }),
    ).toThrowError(expect.objectContaining<NexusError>({ code: 'CONFIG_PATH_ESCAPE' }));
  });

  it('blocks symlinked project configuration', () => {
    const root = project();
    const target = join(root, 'actual.yaml');
    writeFileSync(target, serializeConfig(createDefaultConfig(root)));
    symlinkSync(target, join(root, 'nexus.config.yaml'));

    expect(() =>
      loadNexusConfig({ startDir: root, env: { XDG_CONFIG_HOME: join(root, 'global') } }),
    ).toThrowError(expect.objectContaining<NexusError>({ code: 'CONFIG_SYMLINK_BLOCKED' }));
  });

  it('merges optional global defaults below project configuration', () => {
    const root = project();
    const global = join(root, 'global', 'nexus');
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, 'config.yaml'), 'logging:\n  level: warn\n');
    writeFileSync(join(root, 'nexus.config.yaml'), serializeConfig(createDefaultConfig(root)));

    const loaded = loadNexusConfig({
      startDir: root,
      env: { XDG_CONFIG_HOME: join(root, 'global') },
    });
    expect(loaded.config.logging.level).toBe('info');
    expect(loaded.sources).toHaveLength(2);
  });
});

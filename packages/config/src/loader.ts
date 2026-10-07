import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { NexusError, deterministicId } from '@nexus-ai/core';
import { config as loadDotEnv } from 'dotenv';
import { parseDocument } from 'yaml';

import { NexusConfigSchema, type LoadedNexusConfig, type NexusConfig } from './schema.js';

const PROJECT_CONFIG_NAMES = [
  'nexus.config.yaml',
  'nexus.config.yml',
  'nexus.config.json',
] as const;
const GLOBAL_CONFIG_NAMES = ['config.yaml', 'config.yml', 'config.json'] as const;
const BLOCKED_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CONFIG_BYTES = 1_048_576;

export interface LoadConfigOptions {
  readonly startDir?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadEnvFile?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      throw new NexusError({
        code: 'CONFIG_UNSAFE_KEY',
        message: `Unsafe configuration key rejected: ${key}`,
        component: 'config.loader',
        severity: 'critical',
      });
    }
    output[key] =
      isRecord(value) && isRecord(output[key]) ? mergeObjects(output[key], value) : value;
  }
  return output;
}

function findUp(startDir: string): string | undefined {
  let current = resolve(startDir);
  let previous: string | undefined;
  while (current !== previous) {
    for (const fileName of PROJECT_CONFIG_NAMES) {
      const candidate = join(current, fileName);
      try {
        const stat = lstatSync(candidate);
        if (stat.isDirectory()) continue;
        return candidate;
      } catch {
        // The candidate does not exist or is inaccessible; continue searching.
      }
    }
    previous = current;
    current = dirname(current);
  }
  return undefined;
}

function findGlobalConfig(env: NodeJS.ProcessEnv): string | undefined {
  const xdgHome = env['XDG_CONFIG_HOME'];
  const configDirectory = xdgHome ? join(xdgHome, 'nexus') : join(homedir(), '.config', 'nexus');
  for (const name of GLOBAL_CONFIG_NAMES) {
    const candidate = join(configDirectory, name);
    try {
      if (lstatSync(candidate).isFile()) return candidate;
    } catch {
      // Optional global configuration is absent.
    }
  }
  return undefined;
}

function readConfigFile(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new NexusError({
      code: 'CONFIG_SYMLINK_BLOCKED',
      message: `Configuration symlinks are blocked: ${path}`,
      component: 'config.loader',
      severity: 'high',
      details: { path },
    });
  }
  const canonicalPath = realpathSync(path);
  const canonicalStat = lstatSync(canonicalPath);
  if (!canonicalStat.isFile()) {
    throw new NexusError({
      code: 'CONFIG_NOT_FILE',
      message: `Configuration path is not a regular file: ${path}`,
      component: 'config.loader',
      severity: 'high',
    });
  }
  if (canonicalStat.size > MAX_CONFIG_BYTES) {
    throw new NexusError({
      code: 'CONFIG_TOO_LARGE',
      message: `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
      component: 'config.loader',
      severity: 'high',
      details: { path, size: canonicalStat.size },
    });
  }

  const source = readFileSync(canonicalPath, 'utf8');
  let parsed: unknown;
  try {
    if (extname(path).toLowerCase() === '.json') {
      parsed = JSON.parse(source) as unknown;
    } else {
      const document = parseDocument(source, { prettyErrors: true });
      const firstError = document.errors[0];
      if (firstError) throw new Error(firstError.message);
      parsed = document.toJS({ maxAliasCount: 25 }) as unknown;
    }
  } catch (error) {
    throw new NexusError({
      code: 'CONFIG_PARSE_FAILED',
      message: `Unable to parse configuration: ${path}`,
      component: 'config.loader',
      severity: 'high',
      details: { path, reason: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new NexusError({
      code: 'CONFIG_ROOT_INVALID',
      message: 'Configuration root must be an object',
      component: 'config.loader',
      severity: 'high',
      details: { path },
    });
  }
  return parsed;
}

function environmentOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const environment = env['NEXUS_ENVIRONMENT'];
  const dataDir = env['NEXUS_DATA_DIR'];
  const databasePath = env['NEXUS_DATABASE_PATH'];
  const logLevel = env['NEXUS_LOG_LEVEL'];
  const logFormat = env['NEXUS_LOG_FORMAT'];
  const logDestination = env['NEXUS_LOG_DESTINATION'];
  if (environment) overrides['environment'] = environment;
  if (dataDir) overrides['runtime'] = { dataDir };
  if (databasePath) overrides['database'] = { path: databasePath };
  if (logLevel || logFormat || logDestination) {
    overrides['logging'] = {
      ...(logLevel ? { level: logLevel } : {}),
      ...(logFormat ? { format: logFormat } : {}),
      ...(logDestination ? { destination: logDestination } : {}),
    };
  }
  return overrides;
}

function applyEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  const processEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  loadDotEnv({ path, override: false, quiet: true, processEnv });
  for (const [key, value] of Object.entries(processEnv)) {
    if (env[key] === undefined) env[key] = value;
  }
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return (
    difference === '' ||
    (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function nearestExistingAncestor(target: string): string {
  let current = target;
  let previous: string | undefined;
  while (!existsSync(current) && current !== previous) {
    previous = current;
    current = dirname(current);
  }
  return current;
}

function resolveProjectPath(value: string, projectRoot: string, field: string): string {
  const target = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
  const canonicalRoot = realpathSync(projectRoot);
  const canonicalAncestor = realpathSync(nearestExistingAncestor(target));
  if (!isWithin(canonicalRoot, target) || !isWithin(canonicalRoot, canonicalAncestor)) {
    throw new NexusError({
      code: 'CONFIG_PATH_ESCAPE',
      message: `${field} must remain inside the project root`,
      component: 'config.loader',
      severity: 'high',
      details: { field, projectRoot },
    });
  }
  return target;
}

function resolveConfigPaths(config: NexusConfig, projectRoot: string): NexusConfig {
  return {
    ...config,
    runtime: {
      ...config.runtime,
      dataDir: resolveProjectPath(config.runtime.dataDir, projectRoot, 'runtime.dataDir'),
    },
    database: {
      ...config.database,
      path: resolveProjectPath(config.database.path, projectRoot, 'database.path'),
    },
    logging: {
      ...config.logging,
      destination:
        config.logging.destination === 'stdout'
          ? 'stdout'
          : resolveProjectPath(config.logging.destination, projectRoot, 'logging.destination'),
    },
  };
}

export function createDefaultConfig(
  projectRoot: string,
  projectName = basename(projectRoot),
): NexusConfig {
  return NexusConfigSchema.parse({
    version: 1,
    environment: 'development',
    project: {
      id: deterministicId('prj', `${realpathSync(projectRoot)}:${Date.now()}:${randomUUID()}`),
      name: projectName,
    },
  });
}

export function loadNexusConfig(options: LoadConfigOptions = {}): LoadedNexusConfig {
  const startDir = resolve(options.startDir ?? process.cwd());
  const env = options.env ?? process.env;
  const configuredPath = options.configPath ?? env['NEXUS_CONFIG'];
  const configPath = configuredPath ? resolve(startDir, configuredPath) : findUp(startDir);

  if (!configPath) {
    throw new NexusError({
      code: 'CONFIG_NOT_FOUND',
      message: `No NEXUS configuration found from ${startDir}`,
      component: 'config.loader',
      severity: 'high',
      details: { searched: PROJECT_CONFIG_NAMES },
    });
  }

  const projectRoot = dirname(realpathSync(configPath));
  if (options.loadEnvFile ?? true) applyEnvFile(join(projectRoot, '.env'), env);

  const sources: string[] = [];
  let merged: Record<string, unknown> = {};
  const globalPath = findGlobalConfig(env);
  if (globalPath) {
    merged = mergeObjects(merged, readConfigFile(globalPath));
    sources.push(realpathSync(globalPath));
  }

  merged = mergeObjects(merged, readConfigFile(configPath));
  merged = mergeObjects(merged, environmentOverrides(env));
  sources.push(realpathSync(configPath));

  const result = NexusConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new NexusError({
      code: 'CONFIG_VALIDATION_FAILED',
      message: 'NEXUS configuration is invalid',
      component: 'config.loader',
      severity: 'high',
      details: {
        path: configPath,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  return {
    config: resolveConfigPaths(result.data, projectRoot),
    projectRoot,
    configPath: realpathSync(configPath),
    sources,
  };
}

export function projectConfigNames(): readonly string[] {
  return PROJECT_CONFIG_NAMES;
}

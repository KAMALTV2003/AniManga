import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadNexusConfig, type LoadedNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase } from '@nexus-ai/database';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly checkedAt: string;
  readonly checks: readonly DoctorCheck[];
}

function nodeCheck(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major >= 22
    ? {
        id: 'runtime.node',
        status: 'pass',
        message: `Node.js ${process.versions.node} is supported`,
      }
    : {
        id: 'runtime.node',
        status: 'fail',
        message: `Node.js 22 or newer is required; found ${process.versions.node}`,
      };
}

function permissionCheck(loaded: LoadedNexusConfig): DoctorCheck {
  if (!existsSync(loaded.config.runtime.dataDir)) {
    return {
      id: 'filesystem.data_dir',
      status: 'fail',
      message: 'NEXUS data directory does not exist',
    };
  }
  if (process.platform === 'win32') {
    return { id: 'filesystem.data_dir', status: 'pass', message: 'NEXUS data directory exists' };
  }
  const mode = statSync(loaded.config.runtime.dataDir).mode & 0o777;
  return (mode & 0o077) === 0
    ? {
        id: 'filesystem.permissions',
        status: 'pass',
        message: 'Data directory permissions are restricted',
        details: { mode: mode.toString(8) },
      }
    : {
        id: 'filesystem.permissions',
        status: 'warn',
        message: 'Data directory is accessible by group or other users',
        details: { mode: mode.toString(8), expected: '700' },
      };
}

function gitignoreCheck(loaded: LoadedNexusConfig): DoctorCheck {
  const path = join(loaded.projectRoot, '.gitignore');
  if (!existsSync(path)) {
    return {
      id: 'filesystem.gitignore',
      status: 'warn',
      message: '.gitignore is missing; local state could be committed',
    };
  }
  const ignored = readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .some((line) => line.trim() === '.nexus/');
  return ignored
    ? { id: 'filesystem.gitignore', status: 'pass', message: '.nexus/ is ignored by Git' }
    : { id: 'filesystem.gitignore', status: 'fail', message: '.nexus/ is not ignored by Git' };
}

async function databaseCheck(loaded: LoadedNexusConfig): Promise<DoctorCheck> {
  if (!existsSync(loaded.config.database.path)) {
    return { id: 'database.integrity', status: 'fail', message: 'NEXUS database does not exist' };
  }
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    const health = await database.health();
    return health.status === 'healthy'
      ? {
          id: 'database.integrity',
          status: 'pass',
          message: 'Database integrity and migration checks passed',
          ...(health.details ? { details: health.details } : {}),
        }
      : {
          id: 'database.integrity',
          status: 'fail',
          message: 'Database health check failed',
          ...(health.details ? { details: health.details } : {}),
        };
  } catch (error) {
    return {
      id: 'database.integrity',
      status: 'fail',
      message: 'Unable to validate the database',
      details: { reason: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    await database.stop();
  }
}

export async function runDoctor(startDir: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck()];
  let loaded: LoadedNexusConfig;
  try {
    loaded = loadNexusConfig({ startDir });
    checks.push({
      id: 'config.valid',
      status: 'pass',
      message: 'Configuration parsed and validated',
      details: { path: loaded.configPath, sources: loaded.sources },
    });
  } catch (error) {
    checks.push({
      id: 'config.valid',
      status: 'fail',
      message: 'Configuration validation failed',
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
    return { status: 'unhealthy', checkedAt: new Date().toISOString(), checks };
  }

  checks.push(permissionCheck(loaded), gitignoreCheck(loaded));
  checks.push(await databaseCheck(loaded));
  const status = checks.some((check) => check.status === 'fail')
    ? 'unhealthy'
    : checks.some((check) => check.status === 'warn')
      ? 'degraded'
      : 'healthy';
  return { status, checkedAt: new Date().toISOString(), checks };
}

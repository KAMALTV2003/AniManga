import { spawn } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

import { NexusError, redactText } from '@nexus-ai/core';

export interface CommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly monitoredDirectory?: string;
  readonly maxWorkspaceBytes?: number;
}

export interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

type TerminationReason = 'timeout' | 'output' | 'workspace' | 'workspace-read';

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  validateOptions(options);
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let checkingWorkspace = false;
    let terminationReason: TerminationReason | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminateFor = (reason: TerminationReason): void => {
      if (settled || terminationReason !== null) return;
      terminationReason = reason;
      terminate(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminate(child.pid, 'SIGKILL'), 250);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => terminateFor('timeout'), options.timeoutMs);
    timer.unref();
    const monitoredDirectory = options.monitoredDirectory;
    const maxWorkspaceBytes = options.maxWorkspaceBytes ?? 0;
    const workspaceTimer =
      monitoredDirectory === undefined
        ? undefined
        : setInterval(() => {
            if (checkingWorkspace || terminationReason !== null) return;
            checkingWorkspace = true;
            void directoryBytes(monitoredDirectory)
              .then((bytes) => {
                if (bytes > maxWorkspaceBytes) terminateFor('workspace');
              })
              .catch((error: unknown) => {
                if (!isMissing(error)) terminateFor('workspace-read');
              })
              .finally(() => {
                checkingWorkspace = false;
              });
          }, 25);
    workspaceTimer?.unref();

    const clearResources = (): void => {
      clearTimeout(timer);
      if (workspaceTimer !== undefined) clearInterval(workspaceTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (terminationReason !== null) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        terminateFor('output');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearResources();
      reject(processError('HARVEST_PROCESS_START_FAILED', `Could not start ${command}`, error));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (terminationReason !== null) terminate(child.pid, 'SIGKILL');
      settled = true;
      clearResources();
      const stderrText = redactText(Buffer.concat(stderr).toString('utf8')).slice(0, 8_192);
      if (terminationReason === 'output') {
        reject(
          processError('HARVEST_PROCESS_OUTPUT_LIMIT', `${command} exceeded its output limit`),
        );
      } else if (terminationReason === 'workspace') {
        reject(
          processError(
            'HARVEST_PROCESS_WORKSPACE_LIMIT',
            `${command} exceeded its workspace limit`,
          ),
        );
      } else if (terminationReason === 'workspace-read') {
        reject(
          processError(
            'HARVEST_PROCESS_WORKSPACE_READ_FAILED',
            `${command} workspace monitoring failed`,
          ),
        );
      } else if (terminationReason === 'timeout') {
        reject(processError('HARVEST_PROCESS_TIMEOUT', `${command} exceeded its time limit`));
      } else if (signal !== null) {
        reject(processError('HARVEST_PROCESS_SIGNAL', `${command} exited on signal ${signal}`));
      } else if (code !== 0) {
        reject(
          processError(
            'HARVEST_PROCESS_FAILED',
            `${command} exited with code ${String(code)}${stderrText === '' ? '' : `: ${stderrText}`}`,
          ),
        );
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr: stderrText });
      }
    });
  });
}

function validateOptions(options: CommandOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError('Process timeout must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new RangeError('Process output limit must be a positive safe integer');
  }
  if ((options.monitoredDirectory === undefined) !== (options.maxWorkspaceBytes === undefined)) {
    throw new TypeError('Process workspace path and byte limit must be configured together');
  }
  if (
    options.maxWorkspaceBytes !== undefined &&
    (!Number.isSafeInteger(options.maxWorkspaceBytes) || options.maxWorkspaceBytes < 1)
  ) {
    throw new RangeError('Process workspace limit must be a positive safe integer');
  }
}

function terminate(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32')
      process.kill(pid, signal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL');
    else process.kill(-pid, signal);
  } catch {
    // The process may have exited between limit detection and termination.
  }
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await lstat(target)).size;
  }
  return total;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function processError(code: string, message: string, cause?: unknown): NexusError {
  return new NexusError({
    code,
    component: 'harvest.process',
    severity: 'high',
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

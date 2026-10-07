import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const requested = Number.parseInt(process.argv[2] ?? '20', 10);
if (!Number.isInteger(requested) || requested < 5 || requested > 500) {
  throw new RangeError('Iterations must be an integer from 5 through 500');
}

const cli = resolve('apps/cli/dist/main.js');
const commands = ['status', 'validate', 'doctor'];

function invoke(command) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [cli, command, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  JSON.parse(result.stdout);
  return durationMs;
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

for (const command of commands) {
  for (let index = 0; index < 2; index += 1) invoke(command);
}

const results = {};
for (const command of commands) {
  const durations = Array.from({ length: requested }, () => invoke(command)).sort((a, b) => a - b);
  results[command] = {
    iterations: requested,
    minMs: Number(durations[0].toFixed(2)),
    medianMs: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    maxMs: Number(durations.at(-1).toFixed(2)),
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: 'nexus-phase-1-cli-cold-process',
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      results,
    },
    null,
    2,
  )}\n`,
);

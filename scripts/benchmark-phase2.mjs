import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('apps/cli/dist/main.js');
const iterations = Number(process.argv[2] ?? 10);
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 1_000) {
  throw new RangeError('Iteration count must be an integer between 5 and 1000');
}

const project = mkdtempSync(join(tmpdir(), 'nexus-phase2-benchmark-'));
const environment = { ...process.env, XDG_CONFIG_HOME: join(project, '.global-config') };

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: project,
    encoding: 'utf8',
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(' ')}\n${result.stderr}`);
  }
  return result.stdout;
}

function measure(args) {
  const started = process.hrtime.bigint();
  run(args);
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return {
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
}

try {
  run(['init', '.']);
  const skill = join(project, 'benchmark-skill');
  mkdirSync(join(skill, 'references'), { recursive: true });
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\nname: benchmark-skill\ndescription: Benchmark inert Skill operations. Use when measuring Phase 2.\nmetadata:\n  version: 1.0.0\n---\n# Instructions\n\nRead [the reference](references/guide.md).\n`,
  );
  writeFileSync(join(skill, 'references', 'guide.md'), 'A deterministic benchmark fixture.\n');
  const script = join(skill, 'scripts', 'never-run.sh');
  writeFileSync(script, '#!/bin/sh\nexit 91\n');
  chmodSync(script, 0o700);
  const fixturePaths = [join(skill, 'SKILL.md'), join(skill, 'references', 'guide.md'), script];
  const fixtureBytes = fixturePaths.reduce((total, file) => total + statSync(file).size, 0);

  const installed = JSON.parse(run(['skill', 'install', skill, '--trusted-local-authoring']));
  const cases = {
    analyze: ['skill', 'analyze', skill],
    search: ['skill', 'search', 'benchmark'],
    verify: ['skill', 'verify', installed.skillId],
  };
  const warmups = 2;
  const results = {};
  for (const [name, args] of Object.entries(cases)) {
    for (let index = 0; index < warmups; index += 1) measure(args);
    const samples = [];
    for (let index = 0; index < iterations; index += 1) samples.push(measure(args));
    results[name] = summarize(samples);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: 'nexus-phase2-cli-fresh-process',
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        iterations,
        warmups,
        fixtureFiles: fixturePaths.length,
        fixtureBytes,
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

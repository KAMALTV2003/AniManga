import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['apps', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const forbidden = [/\bTODO\b/u, /\bFIXME\b/u, /implement\s+later/iu];
const findings = [];

async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) {
      await visit(target);
      continue;
    }
    if (!sourceExtensions.has(extname(entry.name))) continue;
    const lines = (await readFile(target, 'utf8')).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (forbidden.some((pattern) => pattern.test(line))) {
        findings.push(`${target}:${index + 1}: ${line.trim()}`);
      }
    }
  }
}

for (const root of roots) await visit(root);

if (findings.length > 0) {
  process.stderr.write(`Source placeholders are not allowed:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('No source placeholders found.\n');
}

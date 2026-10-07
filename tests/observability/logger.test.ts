import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@nexus-ai/observability';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('structured logger', () => {
  it('redacts secrets from bindings and messages before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-log-'));
    roots.push(root);
    const path = join(root, 'nexus.log');
    const logger = createLogger({ level: 'info', format: 'pretty', destination: path });

    logger.info(
      { authorization: 'Bearer raw', nested: { password: 'raw' }, safe: 'visible' },
      'request token=raw',
    );
    logger.flush();
    const output = readFileSync(path, 'utf8');

    expect(output).toContain('[REDACTED]');
    expect(output).toContain('visible');
    expect(output).not.toContain('Bearer raw');
    expect(output).not.toContain('token=raw');
  });
});

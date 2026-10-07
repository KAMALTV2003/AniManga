import path from 'node:path';

import { NexusError } from '@nexus-ai/core';

import type { SkillPackageLimits } from './limits.js';

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const RESERVED_CONTROL_DIRECTORY = /^(?:\.git|\.hg|\.svn)$/iu;
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export interface ValidatedSkillPath {
  readonly path: string;
  readonly collisionKey: string;
}

export function validateSkillRelativePath(
  candidate: string,
  limits: SkillPackageLimits,
): ValidatedSkillPath {
  if (
    candidate.length === 0 ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    candidate.includes('\\') ||
    containsControlCharacter(candidate)
  ) {
    throw invalidPath(candidate, 'Paths must be non-empty, relative POSIX paths without controls');
  }

  const components = candidate.split('/');
  if (
    components.length > limits.maxPathDepth ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) {
    throw invalidPath(
      candidate,
      `Path depth exceeds ${String(limits.maxPathDepth)} or contains dot segments`,
    );
  }
  if (Buffer.byteLength(candidate, 'utf8') > limits.maxPathBytes) {
    throw invalidPath(candidate, `Path exceeds ${String(limits.maxPathBytes)} UTF-8 bytes`);
  }

  for (const component of components) {
    if (
      component.includes(':') ||
      component.endsWith('.') ||
      component.endsWith(' ') ||
      WINDOWS_DEVICE.test(component) ||
      RESERVED_CONTROL_DIRECTORY.test(component)
    ) {
      throw invalidPath(
        candidate,
        'Path is not portable or uses a reserved version-control directory',
      );
    }
  }

  const normalized = candidate.normalize('NFC');
  if (normalized !== candidate) {
    throw invalidPath(candidate, 'Path must use canonical NFC Unicode normalization');
  }
  const collisionKey = normalized.normalize('NFKC').toLowerCase();
  return { path: normalized, collisionKey };
}

export function assertUniqueSkillPath(
  value: ValidatedSkillPath,
  exactPaths: Set<string>,
  collisionKeys: Map<string, string>,
): void {
  if (exactPaths.has(value.path)) {
    throw new NexusError({
      code: 'SKILL_DUPLICATE_PATH',
      component: 'skills',
      severity: 'high',
      message: `Duplicate package path: ${value.path}`,
    });
  }
  const collision = collisionKeys.get(value.collisionKey);
  if (collision !== undefined) {
    throw new NexusError({
      code: 'SKILL_PATH_COLLISION',
      component: 'skills',
      severity: 'high',
      message: `Portable path collision between ${collision} and ${value.path}`,
    });
  }
  exactPaths.add(value.path);
  collisionKeys.set(value.collisionKey, value.path);
}

function invalidPath(candidate: string, reason: string): NexusError {
  return new NexusError({
    code: 'SKILL_UNSAFE_PATH',
    component: 'skills',
    severity: 'high',
    message: `Unsafe package path ${JSON.stringify(candidate)}: ${reason}`,
  });
}

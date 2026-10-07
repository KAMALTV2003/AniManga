import { createHash, randomUUID } from 'node:crypto';

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;

export function createId(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(`Invalid ID prefix: ${prefix}`);
  }
  return `${prefix}_${randomUUID()}`;
}

export function deterministicId(prefix: string, value: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(`Invalid ID prefix: ${prefix}`);
  }
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

import { createHash } from 'node:crypto';

import { NexusError, redactText, stableStringify } from '@nexus-ai/core';

const SIMPLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function agentError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): NexusError {
  return new NexusError({
    code,
    message,
    component: 'agents',
    severity: 'high',
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function requireText(
  value: string,
  name: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  const normalized = value.normalize('NFKC').trim();
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if ((!allowEmpty && bytes === 0) || bytes > maximumBytes) {
    throw new RangeError(
      `${name} must ${allowEmpty ? 'not exceed' : 'contain between 1 and'} ${maximumBytes} UTF-8 bytes`,
    );
  }
  return normalized;
}

export function requireKey(value: string, name: string, maximumBytes = 128): string {
  const normalized = requireText(value, name, maximumBytes);
  if (!SIMPLE_KEY.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new RangeError(`${name} contains unsupported characters`);
  }
  return normalized;
}

export function requireSemver(value: string): string {
  const normalized = requireText(value, 'version', 64);
  if (!SEMVER.test(normalized)) throw new RangeError('version must be canonical SemVer');
  return normalized;
}

export function requireInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function requireUnit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

export function normalizeKeys(
  values: readonly string[],
  name: string,
  maximumItems: number,
): readonly string[] {
  const raw: unknown = values;
  if (!Array.isArray(raw) || raw.length > maximumItems) {
    throw new RangeError(`${name} must contain at most ${maximumItems} items`);
  }
  if (raw.some((value: unknown) => typeof value !== 'string')) {
    throw new TypeError(`${name} must contain only strings`);
  }
  const strings = raw as readonly string[];
  return [...new Set(strings.map((value) => requireKey(value, `${name} item`)))].sort();
}

export function normalizeTexts(
  values: readonly string[],
  name: string,
  maximumItems: number,
  maximumItemBytes = 256,
): readonly string[] {
  const raw: unknown = values;
  if (!Array.isArray(raw) || raw.length > maximumItems) {
    throw new RangeError(`${name} must contain at most ${maximumItems} items`);
  }
  if (raw.some((value: unknown) => typeof value !== 'string')) {
    throw new TypeError(`${name} must contain only strings`);
  }
  const strings = raw as readonly string[];
  return [
    ...new Set(strings.map((value) => requireText(value, `${name} item`, maximumItemBytes))),
  ].sort();
}

export function requireAuditText(value: string, name: string, maximumBytes: number): string {
  const normalized = requireText(value, name, maximumBytes);
  if (redactText(normalized) !== normalized) {
    throw agentError(
      'AGENT_AUDIT_TEXT_SENSITIVE',
      `${name} appears to contain sensitive credential material`,
    );
  }
  return normalized;
}

export function canonicalRecord(
  value: Readonly<Record<string, unknown>>,
  name: string,
  maximumBytes: number,
): Readonly<Record<string, unknown>> {
  const encoded = stableStringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new RangeError(`${name} must not exceed ${maximumBytes} UTF-8 bytes`);
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function rounded(value: number): number {
  return Number(value.toFixed(6));
}

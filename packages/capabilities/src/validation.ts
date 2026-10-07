import { createHash } from 'node:crypto';

import { NexusError, stableStringify } from '@nexus-ai/core';

import {
  CAPABILITY_EDGE_TYPES,
  CAPABILITY_NODE_TYPES,
  type CapabilityEdgeType,
  type CapabilityNodeType,
  type CapabilityRisk,
} from './types.js';

const RISKS = ['unknown', 'safe', 'low', 'medium', 'high', 'critical', 'blocked'] as const;
const SIMPLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export function capabilityError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): NexusError {
  return new NexusError({
    code,
    message,
    component: 'capabilities',
    severity: 'high',
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function requireBoundedText(
  value: string,
  name: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  const normalized = value.normalize('NFKC').trim();
  if (
    (!allowEmpty && normalized.length === 0) ||
    Buffer.byteLength(normalized, 'utf8') > maximumBytes
  ) {
    throw new RangeError(
      `${name} must ${allowEmpty ? 'not exceed' : 'contain between 1 and'} ${maximumBytes} UTF-8 bytes`,
    );
  }
  return normalized;
}

export function requireSimpleKey(value: string, name: string, maximumBytes = 128): string {
  const normalized = requireBoundedText(value, name, maximumBytes);
  if (!SIMPLE_KEY.test(normalized)) {
    throw new RangeError(`${name} contains unsupported characters`);
  }
  return normalized;
}

export function normalizeTerms(
  values: readonly string[] | undefined,
  name: string,
  maximumItems = 64,
): readonly string[] {
  if (values === undefined) return [];
  if (values.length > maximumItems)
    throw new RangeError(`${name} must not exceed ${maximumItems} items`);
  return [
    ...new Set(
      values.map((value) =>
        requireBoundedText(value, `${name} item`, 128).toLocaleLowerCase('en-US'),
      ),
    ),
  ].sort();
}

export function requireNodeType(value: CapabilityNodeType): CapabilityNodeType {
  if (!CAPABILITY_NODE_TYPES.includes(value))
    throw new RangeError('Unsupported capability node type');
  return value;
}

export function requireEdgeType(value: CapabilityEdgeType): CapabilityEdgeType {
  if (!CAPABILITY_EDGE_TYPES.includes(value))
    throw new RangeError('Unsupported capability edge type');
  return value;
}

export function requireRisk(value: CapabilityRisk): CapabilityRisk {
  if (!RISKS.includes(value)) throw new RangeError('Unsupported capability risk');
  return value;
}

export function requirePositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function requireNonNegativeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

export function requireFiniteUnit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

export function requirePlainMetadata(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const metadata = value ?? {};
  const encoded = stableStringify(metadata);
  if (Buffer.byteLength(encoded, 'utf8') > 16_384) {
    throw new RangeError('Capability metadata must not exceed 16384 UTF-8 bytes');
  }
  return JSON.parse(encoded) as Readonly<Record<string, unknown>>;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJsonRecord(value: string, context: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
      throw new Error('not object');
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw capabilityError(
      'CAPABILITY_INDEX_CORRUPT',
      `Stored ${context} is invalid`,
      undefined,
      error,
    );
  }
}

export function parseJsonStrings(value: string, context: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('not string array');
    }
    return parsed as readonly string[];
  } catch (error) {
    throw capabilityError(
      'CAPABILITY_INDEX_CORRUPT',
      `Stored ${context} is invalid`,
      undefined,
      error,
    );
  }
}

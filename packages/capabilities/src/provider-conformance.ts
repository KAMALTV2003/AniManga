import { performance } from 'node:perf_hooks';

import { stableStringify } from '@nexus-ai/core';

import { validateVector } from './embeddings.js';
import type { EmbeddingProvider } from './types.js';
import {
  requireFiniteUnit,
  requirePositiveInteger,
  requireSimpleKey,
  sha256,
} from './validation.js';

export interface EmbeddingConformanceOptions {
  readonly maximumBatchLatencyMs?: number;
  readonly determinismTolerance?: number;
}

export interface EmbeddingConformanceReport {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly probeHash: string;
  readonly checks: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  }[];
}

const PROBES = [
  'Review source changes for security vulnerabilities.',
  'Prepare concise release notes from a verified change set.',
  'تحقق من سلامة واجهة البرمجة وحدود الصلاحيات.',
] as const;

export async function runEmbeddingProviderConformance(
  provider: EmbeddingProvider,
  options: EmbeddingConformanceOptions = {},
): Promise<EmbeddingConformanceReport> {
  const providerName = requireSimpleKey(provider.provider, 'embedding provider');
  const model = requireSimpleKey(provider.model, 'embedding model');
  const dimensions = requirePositiveInteger(provider.dimensions, 'embedding dimensions', 8_192);
  const maximumBatchLatencyMs = requirePositiveInteger(
    options.maximumBatchLatencyMs ?? 30_000,
    'maximumBatchLatencyMs',
    300_000,
  );
  const tolerance = requireFiniteUnit(options.determinismTolerance ?? 1e-9, 'determinismTolerance');
  const started = performance.now();
  const batch = await provider.embed(PROBES);
  const batchDuration = performance.now() - started;
  const validated = batch.map((vector) => validateVector(vector, dimensions));
  const repeated = await provider.embed([PROBES[0]]);
  const repeatedVector = repeated[0] === undefined ? null : validateVector(repeated[0], dimensions);
  const checks: EmbeddingConformanceReport['checks'][number][] = [
    {
      id: 'batch-cardinality',
      passed: batch.length === PROBES.length,
      details: { expected: PROBES.length, actual: batch.length },
    },
    {
      id: 'vector-validation',
      passed: batch.length === PROBES.length && validated.length === PROBES.length,
      details: { dimensions },
    },
    {
      id: 'repeat-cardinality',
      passed: repeated.length === 1,
      details: { expected: 1, actual: repeated.length },
    },
    {
      id: 'determinism',
      passed:
        validated[0] !== undefined &&
        repeatedVector !== null &&
        maximumAbsoluteDelta(validated[0].values, repeatedVector.values) <= tolerance,
      details: {
        tolerance,
        maximumAbsoluteDelta:
          validated[0] === undefined || repeatedVector === null
            ? null
            : maximumAbsoluteDelta(validated[0].values, repeatedVector.values),
      },
    },
    {
      id: 'batch-latency',
      passed: batchDuration <= maximumBatchLatencyMs,
      details: { maximumBatchLatencyMs, actualMs: Number(batchDuration.toFixed(3)) },
    },
  ];
  return {
    provider: providerName,
    model,
    dimensions,
    passed: checks.every((check) => check.passed),
    durationMs: Number((performance.now() - started).toFixed(3)),
    probeHash: sha256(stableStringify(PROBES)),
    checks,
  };
}

function maximumAbsoluteDelta(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

import { performance } from 'node:perf_hooks';

import { createId, deterministicId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import { CapabilityGraph } from './graph.js';
import { RETRIEVAL_STRATEGY_VERSION, CapabilityRetriever } from './retrieval.js';
import {
  CAPABILITY_NODE_TYPES,
  type CapabilityNodeType,
  type CapabilityRisk,
  type EmbeddingProvider,
  type RetrievalWeights,
} from './types.js';
import {
  capabilityError,
  normalizeTerms,
  requireBoundedText,
  requireFiniteUnit,
  requirePositiveInteger,
  requireSimpleKey,
  sha256,
} from './validation.js';

const CAPABILITY_RISKS: readonly CapabilityRisk[] = [
  'unknown',
  'safe',
  'low',
  'medium',
  'high',
  'critical',
  'blocked',
];

const SUITE_KEYS = ['name', 'version', 'description', 'cases'] as const;
const CASE_KEYS = [
  'id',
  'query',
  'expectedNames',
  'forbiddenNames',
  'preferredTags',
  'requiredTags',
  'anchorNames',
  'nodeTypes',
  'allowedRisks',
] as const;

export interface RetrievalEvaluationCase {
  readonly id: string;
  readonly query: string;
  readonly expectedNames: readonly string[];
  readonly forbiddenNames?: readonly string[];
  readonly preferredTags?: readonly string[];
  readonly requiredTags?: readonly string[];
  readonly anchorNames?: readonly string[];
  readonly nodeTypes?: readonly CapabilityNodeType[];
  readonly allowedRisks?: readonly CapabilityRisk[];
}

export interface RetrievalEvaluationSuite {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly cases: readonly RetrievalEvaluationCase[];
}

export interface RetrievalEvaluationGate {
  readonly topK?: number;
  readonly minimumRecallAtK?: number;
  readonly minimumMrrAtK?: number;
  readonly maximumRecallRegression?: number;
  readonly maximumMrrRegression?: number;
  readonly requireStrictImprovement?: boolean;
  readonly forbidAnyForbiddenHit?: boolean;
}

export interface RetrievalEvaluationStrategy {
  readonly weights?: Partial<RetrievalWeights>;
  readonly embeddingProvider?: EmbeddingProvider;
}

export interface RetrievalEvaluationMetrics {
  readonly recallAtK: number;
  readonly meanReciprocalRankAtK: number;
  readonly forbiddenHitRate: number;
  readonly medianLatencyMs: number;
  readonly p95LatencyMs: number;
}

export interface RetrievalEvaluationResult {
  readonly runId: string;
  readonly suiteName: string;
  readonly suiteVersion: string;
  readonly corpusHash: string;
  readonly status: 'passed' | 'failed';
  readonly baseline: RetrievalEvaluationMetrics;
  readonly candidate: RetrievalEvaluationMetrics;
  readonly delta: {
    readonly recallAtK: number;
    readonly meanReciprocalRankAtK: number;
    readonly forbiddenHitRate: number;
  };
  readonly gateChecks: readonly {
    readonly id: string;
    readonly passed: boolean;
    readonly actual: number | boolean;
    readonly expected: number | boolean;
  }[];
  readonly caseCount: number;
  readonly topK: number;
}

interface NormalizedCase {
  readonly id: string;
  readonly query: string;
  readonly expectedNames: readonly string[];
  readonly forbiddenNames: readonly string[];
  readonly preferredTags: readonly string[];
  readonly requiredTags: readonly string[];
  readonly anchorNames: readonly string[];
  readonly nodeTypes: readonly CapabilityNodeType[];
  readonly allowedRisks: readonly CapabilityRisk[];
}

interface CaseMeasurement {
  readonly caseId: string;
  readonly queryHash: string;
  readonly expected: readonly string[];
  readonly forbidden: readonly string[];
  readonly baselineRetrievalRunId: string;
  readonly candidateRetrievalRunId: string;
  readonly baselineResults: readonly string[];
  readonly candidateResults: readonly string[];
  readonly baselineReciprocalRank: number;
  readonly candidateReciprocalRank: number;
  readonly baselineRecall: number;
  readonly candidateRecall: number;
  readonly candidateForbiddenHits: number;
  readonly baselineForbiddenHits: number;
  readonly baselineLatencyMs: number;
  readonly candidateLatencyMs: number;
}

export class RetrievalEvaluator {
  readonly #database: SqliteDatabase;
  readonly #retriever: CapabilityRetriever;
  readonly #graph: CapabilityGraph;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#retriever = new CapabilityRetriever(database);
    this.#graph = new CapabilityGraph(database);
  }

  async evaluate(
    projectId: string,
    suite: RetrievalEvaluationSuite,
    candidateStrategy: RetrievalEvaluationStrategy = {},
    gate: RetrievalEvaluationGate = {},
  ): Promise<RetrievalEvaluationResult> {
    const normalizedProjectId = requireSimpleKey(projectId, 'projectId', 160);
    const normalizedSuite = normalizeSuite(suite);
    const normalizedGate = normalizeGate(gate);
    const active = this.#graph.listActive(normalizedProjectId, 10_000);
    const anchors = new Map(
      active.map(({ node, document }) => [document.name.toLocaleLowerCase('en-US'), node.id]),
    );
    const startedAt = new Date().toISOString();
    const measurements: CaseMeasurement[] = [];

    for (const testCase of normalizedSuite.cases) {
      const anchorNodeIds = testCase.anchorNames.map((name) => {
        const nodeId = anchors.get(name);
        if (nodeId === undefined) {
          throw capabilityError(
            'RETRIEVAL_EVALUATION_ANCHOR_MISSING',
            `Evaluation anchor is not active: ${name}`,
            { caseId: testCase.id },
          );
        }
        return nodeId;
      });
      const baselineStarted = performance.now();
      const baseline = await this.#retriever.retrieve({
        projectId: normalizedProjectId,
        query: testCase.query,
        limit: normalizedGate.topK,
        weights: { lexical: 1, semantic: 0, metadata: 0, graph: 0 },
        ...(testCase.nodeTypes.length === 0 ? {} : { nodeTypes: testCase.nodeTypes }),
        ...(testCase.allowedRisks.length === 0 ? {} : { allowedRisks: testCase.allowedRisks }),
      });
      const baselineLatencyMs = performance.now() - baselineStarted;
      const candidateStarted = performance.now();
      const candidate = await this.#retriever.retrieve({
        projectId: normalizedProjectId,
        query: testCase.query,
        limit: normalizedGate.topK,
        ...(testCase.preferredTags.length === 0 ? {} : { preferredTags: testCase.preferredTags }),
        ...(testCase.requiredTags.length === 0 ? {} : { requiredTags: testCase.requiredTags }),
        ...(anchorNodeIds.length === 0 ? {} : { anchorNodeIds }),
        ...(testCase.nodeTypes.length === 0 ? {} : { nodeTypes: testCase.nodeTypes }),
        ...(testCase.allowedRisks.length === 0 ? {} : { allowedRisks: testCase.allowedRisks }),
        ...(candidateStrategy.weights === undefined ? {} : { weights: candidateStrategy.weights }),
        ...(candidateStrategy.embeddingProvider === undefined
          ? {}
          : { embeddingProvider: candidateStrategy.embeddingProvider }),
      });
      const candidateLatencyMs = performance.now() - candidateStarted;
      const baselineNames = baseline.results.map((result) =>
        result.name.toLocaleLowerCase('en-US'),
      );
      const candidateNames = candidate.results.map((result) =>
        result.name.toLocaleLowerCase('en-US'),
      );
      measurements.push({
        caseId: testCase.id,
        queryHash: sha256(testCase.query),
        expected: testCase.expectedNames,
        forbidden: testCase.forbiddenNames,
        baselineRetrievalRunId: baseline.runId,
        candidateRetrievalRunId: candidate.runId,
        baselineResults: baselineNames,
        candidateResults: candidateNames,
        baselineReciprocalRank: reciprocalRank(baselineNames, testCase.expectedNames),
        candidateReciprocalRank: reciprocalRank(candidateNames, testCase.expectedNames),
        baselineRecall: recall(baselineNames, testCase.expectedNames),
        candidateRecall: recall(candidateNames, testCase.expectedNames),
        candidateForbiddenHits: forbiddenHits(candidateNames, testCase.forbiddenNames),
        baselineForbiddenHits: forbiddenHits(baselineNames, testCase.forbiddenNames),
        baselineLatencyMs,
        candidateLatencyMs,
      });
    }

    const baseline = metrics(measurements, 'baseline');
    const candidate = metrics(measurements, 'candidate');
    const delta = {
      recallAtK: rounded(candidate.recallAtK - baseline.recallAtK),
      meanReciprocalRankAtK: rounded(
        candidate.meanReciprocalRankAtK - baseline.meanReciprocalRankAtK,
      ),
      forbiddenHitRate: rounded(candidate.forbiddenHitRate - baseline.forbiddenHitRate),
    };
    const improved = delta.recallAtK > 0 || delta.meanReciprocalRankAtK > 0;
    const checks: RetrievalEvaluationResult['gateChecks'] = [
      {
        id: 'minimum-recall',
        passed: candidate.recallAtK >= normalizedGate.minimumRecallAtK,
        actual: candidate.recallAtK,
        expected: normalizedGate.minimumRecallAtK,
      },
      {
        id: 'minimum-mrr',
        passed: candidate.meanReciprocalRankAtK >= normalizedGate.minimumMrrAtK,
        actual: candidate.meanReciprocalRankAtK,
        expected: normalizedGate.minimumMrrAtK,
      },
      {
        id: 'maximum-recall-regression',
        passed: delta.recallAtK >= -normalizedGate.maximumRecallRegression,
        actual: delta.recallAtK,
        expected: -normalizedGate.maximumRecallRegression,
      },
      {
        id: 'maximum-mrr-regression',
        passed: delta.meanReciprocalRankAtK >= -normalizedGate.maximumMrrRegression,
        actual: delta.meanReciprocalRankAtK,
        expected: -normalizedGate.maximumMrrRegression,
      },
      {
        id: 'strict-improvement',
        passed: !normalizedGate.requireStrictImprovement || improved,
        actual: improved,
        expected: normalizedGate.requireStrictImprovement,
      },
      {
        id: 'forbidden-results',
        passed: !normalizedGate.forbidAnyForbiddenHit || candidate.forbiddenHitRate === 0,
        actual: candidate.forbiddenHitRate,
        expected: 0,
      },
    ];
    const status = checks.every((check) => check.passed) ? 'passed' : 'failed';
    const corpusHash = sha256(stableStringify(normalizedSuite));
    const runId = createId('retrieval_evaluation');
    const completedAt = new Date().toISOString();
    const database = this.#database.connection;
    database
      .transaction(() => {
        database
          .prepare(
            `INSERT INTO retrieval_evaluation_runs(
               id, project_id, suite_name, suite_version, corpus_sha256,
               baseline_strategy, candidate_strategy, status, case_count,
               baseline_metrics_json, candidate_metrics_json, delta_json, gate_json,
               environment_json, started_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            normalizedProjectId,
            normalizedSuite.name,
            normalizedSuite.version,
            corpusHash,
            'fts5-lexical-only-v1',
            `${RETRIEVAL_STRATEGY_VERSION}${candidateStrategy.embeddingProvider === undefined ? '' : '+embedding'}`,
            status,
            normalizedSuite.cases.length,
            stableStringify(baseline),
            stableStringify(candidate),
            stableStringify(delta),
            stableStringify({ config: normalizedGate, checks }),
            stableStringify({
              node: process.version,
              platform: process.platform,
              architecture: process.arch,
              embeddingProvider: candidateStrategy.embeddingProvider?.provider ?? null,
              embeddingModel: candidateStrategy.embeddingProvider?.model ?? null,
            }),
            startedAt,
            completedAt,
          );
        const insertCase = database.prepare(
          `INSERT INTO retrieval_evaluation_case_results(
             id, run_id, case_id, query_sha256, expected_json, forbidden_json,
             baseline_retrieval_run_id, candidate_retrieval_run_id,
             baseline_results_json, candidate_results_json, baseline_reciprocal_rank,
             candidate_reciprocal_rank, candidate_forbidden_hits, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const measurement of measurements) {
          insertCase.run(
            deterministicId('retrieval_evaluation_case', `${runId}:${measurement.caseId}`),
            runId,
            measurement.caseId,
            measurement.queryHash,
            stableStringify(measurement.expected),
            stableStringify(measurement.forbidden),
            measurement.baselineRetrievalRunId,
            measurement.candidateRetrievalRunId,
            stableStringify(measurement.baselineResults),
            stableStringify(measurement.candidateResults),
            measurement.baselineReciprocalRank,
            measurement.candidateReciprocalRank,
            measurement.candidateForbiddenHits,
            completedAt,
          );
        }
      })
      .immediate();
    return {
      runId,
      suiteName: normalizedSuite.name,
      suiteVersion: normalizedSuite.version,
      corpusHash,
      status,
      baseline,
      candidate,
      delta,
      gateChecks: checks,
      caseCount: normalizedSuite.cases.length,
      topK: normalizedGate.topK,
    };
  }
}

export function parseRetrievalEvaluationSuite(value: unknown): RetrievalEvaluationSuite {
  if (!isRecord(value)) throw new TypeError('Evaluation suite must be a JSON object');
  assertOnlyKeys(value, SUITE_KEYS, 'evaluation suite');
  const cases = value['cases'];
  if (!Array.isArray(cases)) throw new TypeError('Evaluation suite cases must be an array');
  return {
    name: requireString(value['name'], 'suite name'),
    version: requireString(value['version'], 'suite version'),
    description: requireString(value['description'], 'suite description'),
    cases: cases.map((item, index) => {
      if (!isRecord(item)) throw new TypeError(`Evaluation case ${index} must be an object`);
      assertOnlyKeys(item, CASE_KEYS, `evaluation case ${index}`);
      return {
        id: requireString(item['id'], `case ${index} id`),
        query: requireString(item['query'], `case ${index} query`),
        expectedNames: requireStringArray(item['expectedNames'], `case ${index} expectedNames`),
        ...(item['forbiddenNames'] === undefined
          ? {}
          : {
              forbiddenNames: requireStringArray(
                item['forbiddenNames'],
                `case ${index} forbiddenNames`,
              ),
            }),
        ...(item['preferredTags'] === undefined
          ? {}
          : {
              preferredTags: requireStringArray(
                item['preferredTags'],
                `case ${index} preferredTags`,
              ),
            }),
        ...(item['requiredTags'] === undefined
          ? {}
          : {
              requiredTags: requireStringArray(item['requiredTags'], `case ${index} requiredTags`),
            }),
        ...(item['anchorNames'] === undefined
          ? {}
          : {
              anchorNames: requireStringArray(item['anchorNames'], `case ${index} anchorNames`),
            }),
        ...(item['nodeTypes'] === undefined
          ? {}
          : {
              nodeTypes: requireEnumArray(
                item['nodeTypes'],
                `case ${index} nodeTypes`,
                CAPABILITY_NODE_TYPES,
              ),
            }),
        ...(item['allowedRisks'] === undefined
          ? {}
          : {
              allowedRisks: requireEnumArray(
                item['allowedRisks'],
                `case ${index} allowedRisks`,
                CAPABILITY_RISKS,
              ),
            }),
      };
    }),
  };
}

function normalizeSuite(input: RetrievalEvaluationSuite): {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly cases: readonly NormalizedCase[];
} {
  const suite = parseRetrievalEvaluationSuite(input);
  const name = requireSimpleKey(suite.name, 'suite name');
  const version = requireSimpleKey(suite.version, 'suite version', 64);
  const description = requireBoundedText(suite.description, 'suite description', 2_048);
  if (suite.cases.length < 1 || suite.cases.length > 1_000) {
    throw new RangeError('Evaluation suite must contain between 1 and 1000 cases');
  }
  const ids = new Set<string>();
  const cases = suite.cases.map((testCase) => {
    const id = requireSimpleKey(testCase.id, 'case id');
    if (ids.has(id)) throw new RangeError(`Duplicate evaluation case id: ${id}`);
    ids.add(id);
    const expectedNames = normalizeTerms(testCase.expectedNames, 'expectedNames', 20);
    if (expectedNames.length === 0) throw new RangeError(`Case ${id} has no expected names`);
    const forbiddenNames = normalizeTerms(testCase.forbiddenNames, 'forbiddenNames', 20);
    if (expectedNames.some((expected) => forbiddenNames.includes(expected))) {
      throw new RangeError(`Case ${id} names the same capability as expected and forbidden`);
    }
    return {
      id,
      query: requireBoundedText(testCase.query, 'case query', 512),
      expectedNames,
      forbiddenNames,
      preferredTags: normalizeTerms(testCase.preferredTags, 'preferredTags', 32),
      requiredTags: normalizeTerms(testCase.requiredTags, 'requiredTags', 32),
      anchorNames: normalizeTerms(testCase.anchorNames, 'anchorNames', 32),
      nodeTypes: testCase.nodeTypes ?? [],
      allowedRisks: testCase.allowedRisks ?? [],
    };
  });
  return { name, version, description, cases };
}

function normalizeGate(gate: RetrievalEvaluationGate): Required<RetrievalEvaluationGate> {
  const topK = requirePositiveInteger(gate.topK ?? 5, 'topK', 20);
  return {
    topK,
    minimumRecallAtK: requireFiniteUnit(gate.minimumRecallAtK ?? 0.8, 'minimumRecallAtK'),
    minimumMrrAtK: requireFiniteUnit(gate.minimumMrrAtK ?? 0.7, 'minimumMrrAtK'),
    maximumRecallRegression: requireFiniteUnit(
      gate.maximumRecallRegression ?? 0,
      'maximumRecallRegression',
    ),
    maximumMrrRegression: requireFiniteUnit(gate.maximumMrrRegression ?? 0, 'maximumMrrRegression'),
    requireStrictImprovement: gate.requireStrictImprovement ?? true,
    forbidAnyForbiddenHit: gate.forbidAnyForbiddenHit ?? true,
  };
}

function reciprocalRank(results: readonly string[], expected: readonly string[]): number {
  const rank = results.findIndex((name) => expected.includes(name));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

function recall(results: readonly string[], expected: readonly string[]): number {
  return expected.filter((name) => results.includes(name)).length / expected.length;
}

function forbiddenHits(results: readonly string[], forbidden: readonly string[]): number {
  return results.filter((name) => forbidden.includes(name)).length;
}

function metrics(
  measurements: readonly CaseMeasurement[],
  prefix: 'baseline' | 'candidate',
): RetrievalEvaluationMetrics {
  const count = measurements.length;
  const recalls = measurements.map((item) => item[`${prefix}Recall`]);
  const reciprocalRanks = measurements.map((item) => item[`${prefix}ReciprocalRank`]);
  const forbidden = measurements.map((item) => item[`${prefix}ForbiddenHits`]);
  const latencies = measurements.map((item) => item[`${prefix}LatencyMs`]).sort((a, b) => a - b);
  return {
    recallAtK: rounded(recalls.reduce((sum, value) => sum + value, 0) / count),
    meanReciprocalRankAtK: rounded(reciprocalRanks.reduce((sum, value) => sum + value, 0) / count),
    forbiddenHitRate: rounded(forbidden.filter((value) => value > 0).length / count),
    medianLatencyMs: rounded(percentile(latencies, 0.5)),
    p95LatencyMs: rounded(percentile(latencies, 0.95)),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value as readonly string[];
}

function requireEnumArray<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): readonly T[] {
  const strings = requireStringArray(value, name);
  const invalid = strings.find((item) => !allowed.includes(item as T));
  if (invalid !== undefined) throw new RangeError(`${name} contains unsupported value: ${invalid}`);
  return strings as readonly T[];
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RangeError(`${name} contains unknown keys: ${unknown.sort().join(', ')}`);
  }
}

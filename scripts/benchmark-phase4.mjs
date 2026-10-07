import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  CapabilityComposer,
  CapabilityGraph,
  RetrievalEvaluator,
  parseRetrievalEvaluationSuite,
} from '../packages/capabilities/dist/index.js';
import { ProjectRepository, SqliteDatabase } from '../packages/database/dist/index.js';

const requested = Number(process.argv[2] ?? 20);
if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
  throw new RangeError('Iterations must be an integer between 1 and 200');
}
const raw = JSON.parse(
  await readFile(
    new URL('../tests/fixtures/phase4-retrieval-corpus-v2.json', import.meta.url),
    'utf8',
  ),
);
const suite = parseRetrievalEvaluationSuite({
  name: raw.name,
  version: raw.version,
  description: raw.description,
  cases: raw.cases,
});
const database = new SqliteDatabase({ path: ':memory:' });
await database.start();
try {
  const projectId = 'prj_phase4_benchmark';
  new ProjectRepository(database).upsert({
    id: projectId,
    name: 'Phase 4 Benchmark',
    rootPath: '/benchmark/phase4',
  });
  const graph = new CapabilityGraph(database);
  const byName = new Map();
  for (const capability of raw.capabilities) {
    const registered = graph.register({
      projectId,
      nodeType: 'skill',
      objectId: `benchmark_${capability.name}`,
      objectVersionId: `benchmark_${capability.name}_v1`,
      name: capability.name,
      description: capability.description,
      tags: capability.tags,
      capabilities: capability.behaviors,
      contextBytes: capability.contextBytes,
      risk: 'low',
    });
    byName.set(capability.name, registered.node.id);
  }
  for (const capability of raw.capabilities) {
    const sourceNodeId = byName.get(capability.name);
    for (const dependency of capability.dependsOn ?? []) {
      const targetNodeId = byName.get(dependency);
      if (sourceNodeId === undefined || targetNodeId === undefined) {
        throw new Error(`Corpus dependency is unresolved: ${capability.name} -> ${dependency}`);
      }
      graph.connect({ projectId, sourceNodeId, targetNodeId, edgeType: 'depends_on' });
    }
  }

  const evaluator = new RetrievalEvaluator(database);
  const composer = new CapabilityComposer(database);
  const warmups = 2;
  for (let iteration = 0; iteration < warmups; iteration += 1) {
    await evaluator.evaluate(projectId, suite);
    await evaluateComposition(composer, projectId, raw.compositionCases);
  }

  const retrievalLatencies = [];
  const retrievalResults = [];
  const compositionLatencies = [];
  let retrievalResult;
  let compositionResult;
  for (let iteration = 0; iteration < requested; iteration += 1) {
    const retrievalStarted = performance.now();
    retrievalResult = await evaluator.evaluate(projectId, suite);
    retrievalResults.push(retrievalResult);
    retrievalLatencies.push(performance.now() - retrievalStarted);
    const compositionStarted = performance.now();
    compositionResult = await evaluateComposition(composer, projectId, raw.compositionCases);
    compositionLatencies.push(performance.now() - compositionStarted);
  }
  const report = {
    benchmark: suite.name,
    corpusVersion: suite.version,
    corpusLicense: raw.license,
    corpusKind: 'synthetic deterministic software-capability selection regression suite',
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    iterations: requested,
    warmups,
    capabilities: raw.capabilities.length,
    retrievalCases: suite.cases.length,
    compositionCases: raw.compositionCases.length,
    semanticEmbeddingsUsed: false,
    retrievalGate: {
      status: retrievalResults.every((result) => result.status === 'passed') ? 'passed' : 'failed',
      baseline: aggregateRetrievalMetrics(retrievalResults, 'baseline'),
      candidate: aggregateRetrievalMetrics(retrievalResults, 'candidate'),
      delta: retrievalResult.delta,
      fullSuiteLatencyMs: summarize(retrievalLatencies),
    },
    composition: {
      ...compositionResult,
      fullSuiteLatencyMs: summarize(compositionLatencies),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.retrievalGate.status !== 'passed') {
    throw new Error('Phase 4 retrieval gate failed');
  }
  if (compositionResult.completionRate !== 1 || compositionResult.exactBundleRate !== 1) {
    throw new Error('Phase 4 composition gate failed');
  }
} finally {
  await database.stop();
}

async function evaluateComposition(composer, projectId, cases) {
  let completed = 0;
  let exactBundles = 0;
  let totalContextBytes = 0;
  for (const testCase of cases) {
    const result = await composer.compose({
      projectId,
      query: testCase.query,
      requiredCapabilities: testCase.requiredCapabilities,
      maxContextBytes: testCase.maxContextBytes,
      retrievalLimit: 20,
    });
    if (result.status === 'complete') completed += 1;
    const actual = result.selected.map((item) => item.name).sort();
    const expected = [...testCase.expectedNames].sort();
    if (JSON.stringify(actual) === JSON.stringify(expected)) exactBundles += 1;
    totalContextBytes += result.contextBytes;
  }
  return {
    completionRate: completed / cases.length,
    exactBundleRate: exactBundles / cases.length,
    meanContextBytes: Number((totalContextBytes / cases.length).toFixed(2)),
  };
}

function aggregateRetrievalMetrics(results, strategy) {
  const latest = results.at(-1)[strategy];
  const medianLatencies = results
    .map((result) => result[strategy].medianLatencyMs)
    .sort((left, right) => left - right);
  const p95Latencies = results
    .map((result) => result[strategy].p95LatencyMs)
    .sort((left, right) => left - right);
  return {
    recallAtK: latest.recallAtK,
    meanReciprocalRankAtK: latest.meanReciprocalRankAtK,
    forbiddenHitRate: latest.forbiddenHitRate,
    medianLatencyMs: precise(percentile(medianLatencies, 0.5)),
    p95LatencyMs: precise(percentile(p95Latencies, 0.95)),
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    min: rounded(sorted[0]),
    max: rounded(sorted.at(-1)),
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

function rounded(value) {
  return Number(value.toFixed(2));
}

function precise(value) {
  return Number(value.toFixed(6));
}

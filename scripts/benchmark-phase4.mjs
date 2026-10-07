import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { CapabilityGraph, CapabilityRetriever } from '../packages/capabilities/dist/index.js';
import { ProjectRepository, SqliteDatabase } from '../packages/database/dist/index.js';

const requested = Number(process.argv[2] ?? 20);
if (!Number.isInteger(requested) || requested < 1 || requested > 200) {
  throw new RangeError('Iterations must be an integer between 1 and 200');
}
const corpus = JSON.parse(
  await readFile(
    new URL('../tests/fixtures/phase4-retrieval-corpus-v1.json', import.meta.url),
    'utf8',
  ),
);
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
  for (const capability of corpus.capabilities) {
    graph.register({
      projectId,
      nodeType: 'skill',
      objectId: `benchmark_${capability.name}`,
      objectVersionId: `benchmark_${capability.name}_v1`,
      name: capability.name,
      description: capability.description,
      tags: capability.tags,
      capabilities: capability.behaviors,
      contextBytes: Buffer.byteLength(capability.description, 'utf8'),
      risk: 'low',
    });
  }
  const retriever = new CapabilityRetriever(database);
  const warmups = 2;
  for (let iteration = 0; iteration < warmups; iteration += 1) {
    await evaluate(retriever, projectId, corpus.cases, 'hybrid');
  }
  const measurements = { baseline: [], hybrid: [] };
  let baselineMetrics;
  let hybridMetrics;
  for (let iteration = 0; iteration < requested; iteration += 1) {
    const baselineStart = performance.now();
    baselineMetrics = await evaluate(retriever, projectId, corpus.cases, 'baseline');
    measurements.baseline.push(performance.now() - baselineStart);
    const hybridStart = performance.now();
    hybridMetrics = await evaluate(retriever, projectId, corpus.cases, 'hybrid');
    measurements.hybrid.push(performance.now() - hybridStart);
  }
  console.log(
    JSON.stringify(
      {
        benchmark: corpus.name,
        corpusVersion: corpus.version,
        corpusLicense: corpus.license,
        corpusKind: 'synthetic deterministic capability-selection corpus',
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        iterations: requested,
        warmups,
        capabilities: corpus.capabilities.length,
        cases: corpus.cases.length,
        semanticEmbeddingsUsed: false,
        baseline: {
          strategy: 'FTS5 lexical only',
          ...baselineMetrics,
          latencyMsPerCorpus: summarize(measurements.baseline),
        },
        phase4Foundation: {
          strategy: 'FTS5 lexical + metadata RRF',
          ...hybridMetrics,
          latencyMsPerCorpus: summarize(measurements.hybrid),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await database.stop();
}

async function evaluate(retriever, projectId, cases, mode) {
  let reciprocalRank = 0;
  let top1 = 0;
  for (const testCase of cases) {
    const response = await retriever.retrieve({
      projectId,
      query: testCase.query,
      limit: 5,
      ...(mode === 'baseline'
        ? { weights: { lexical: 1, semantic: 0, metadata: 0, graph: 0 } }
        : { preferredTags: testCase.preferredTags }),
    });
    const rank = response.results.findIndex((item) => item.name === testCase.expected) + 1;
    if (rank === 1) top1 += 1;
    if (rank > 0) reciprocalRank += 1 / rank;
  }
  return {
    recallAt1: top1 / cases.length,
    meanReciprocalRankAt5: reciprocalRank / cases.length,
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted.at(-1).toFixed(2)),
  };
}

function percentile(sorted, quantile) {
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(2));
}

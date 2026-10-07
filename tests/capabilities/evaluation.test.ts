import { describe, expect, it } from 'vitest';

import {
  CapabilityGraph,
  RetrievalEvaluator,
  parseRetrievalEvaluationSuite,
  runEmbeddingProviderConformance,
  type EmbeddingProvider,
} from '@nexus-ai/capabilities';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';

const PROJECT_ID = 'prj_retrieval_evaluation';

async function setup() {
  const database = new SqliteDatabase({ path: ':memory:' });
  await database.start();
  new ProjectRepository(database).upsert({
    id: PROJECT_ID,
    name: 'Retrieval Evaluation',
    rootPath: '/tmp/retrieval-evaluation',
  });
  const graph = new CapabilityGraph(database);
  graph.register({
    projectId: PROJECT_ID,
    nodeType: 'skill',
    objectId: 'skill_release',
    objectVersionId: 'version_release_1',
    name: 'release-notes',
    description: 'Prepare verified software change summaries.',
    tags: ['release'],
    capabilities: ['release-notes'],
  });
  graph.register({
    projectId: PROJECT_ID,
    nodeType: 'skill',
    objectId: 'skill_security',
    objectVersionId: 'version_security_1',
    name: 'security-review',
    description: 'Inspect source for unsafe data flows and vulnerabilities.',
    tags: ['security'],
    capabilities: ['security-review'],
  });
  graph.register({
    projectId: PROJECT_ID,
    nodeType: 'skill',
    objectId: 'skill_api',
    objectVersionId: 'version_api_1',
    name: 'api-documentation',
    description: 'Document typed HTTP request and response contracts.',
    tags: ['api'],
    capabilities: ['api-documentation'],
  });
  return database;
}

describe('RetrievalEvaluator', () => {
  it('persists an append-only measured improvement without raw query text', async () => {
    const database = await setup();
    try {
      const result = await new RetrievalEvaluator(database).evaluate(PROJECT_ID, {
        name: 'selection-regression',
        version: '2',
        description: 'Deterministic retrieval selection regression suite.',
        cases: [
          {
            id: 'release-intent',
            query: 'assemble the verified delivery artifact',
            expectedNames: ['release-notes'],
            preferredTags: ['release'],
          },
          {
            id: 'security-intent',
            query: 'examine dangerous information paths',
            expectedNames: ['security-review'],
            preferredTags: ['security'],
          },
          {
            id: 'api-lexical',
            query: 'typed HTTP request response contracts',
            expectedNames: ['api-documentation'],
            forbiddenNames: ['security-review'],
          },
        ],
      });

      expect(result).toMatchObject({
        status: 'passed',
        caseCount: 3,
        baseline: { recallAtK: 0.666667 },
        candidate: { recallAtK: 1, forbiddenHitRate: 0 },
        delta: { recallAtK: 0.333333 },
      });
      const row = database.connection
        .prepare(
          `SELECT corpus_sha256 AS corpusHash, status FROM retrieval_evaluation_runs WHERE id = ?`,
        )
        .get(result.runId) as { readonly corpusHash: string; readonly status: string };
      expect(row).toMatchObject({ status: 'passed' });
      expect(row.corpusHash).toMatch(/^[a-f0-9]{64}$/u);
      const cases = database.connection
        .prepare(
          `SELECT id, query_sha256 AS queryHash,
                  baseline_retrieval_run_id AS baselineRunId,
                  candidate_retrieval_run_id AS candidateRunId
           FROM retrieval_evaluation_case_results
           WHERE run_id = ? ORDER BY case_id`,
        )
        .all(result.runId) as {
        readonly id: string;
        readonly queryHash: string;
        readonly baselineRunId: string;
        readonly candidateRunId: string;
      }[];
      expect(cases).toHaveLength(3);
      expect(cases.every((item) => /^[a-f0-9]{64}$/u.test(item.queryHash))).toBe(true);
      expect(cases.every((item) => item.baselineRunId !== item.candidateRunId)).toBe(true);
      expect(() =>
        database.connection
          .prepare('UPDATE retrieval_evaluation_case_results SET case_id = ? WHERE id = ?')
          .run('tampered', cases[0]?.id),
      ).toThrow(/append-only/u);
      expect(() =>
        database.connection
          .prepare('UPDATE retrieval_evaluation_runs SET status = ? WHERE id = ?')
          .run('failed', result.runId),
      ).toThrow(/append-only/u);
    } finally {
      await database.stop();
    }
  });

  it('fails a strict gate on parity and rejects malformed corpus data', async () => {
    const database = await setup();
    try {
      const result = await new RetrievalEvaluator(database).evaluate(PROJECT_ID, {
        name: 'parity-suite',
        version: '1',
        description: 'A suite where metadata adds no measured value.',
        cases: [
          {
            id: 'api',
            query: 'typed HTTP request response contracts',
            expectedNames: ['api-documentation'],
          },
        ],
      });
      expect(result.status).toBe('failed');
      expect(result.gateChecks).toContainEqual(
        expect.objectContaining({ id: 'strict-improvement', passed: false }),
      );
      expect(() => parseRetrievalEvaluationSuite({ name: 'bad', cases: 'not-an-array' })).toThrow(
        /cases must be an array/u,
      );
      expect(() =>
        parseRetrievalEvaluationSuite({
          name: 'bad',
          version: '1',
          description: 'Unknown configuration must not be ignored.',
          cases: [],
          typo: true,
        }),
      ).toThrow(/unknown keys: typo/u);
      expect(() =>
        parseRetrievalEvaluationSuite({
          name: 'bad',
          version: '1',
          description: 'Invalid enums must fail before retrieval.',
          cases: [
            {
              id: 'invalid-risk',
              query: 'anything',
              expectedNames: ['release-notes'],
              allowedRisks: ['trusted'],
            },
          ],
        }),
      ).toThrow(/unsupported value: trusted/u);
    } finally {
      await database.stop();
    }
  });
});

describe('embedding provider conformance', () => {
  it('checks vector shape, determinism, multilingual input, and latency', async () => {
    const provider: EmbeddingProvider = {
      provider: 'deterministic-test',
      model: 'two-dimensional-v1',
      dimensions: 2,
      embed: async (texts) => texts.map((text) => [text.length + 1, 1]),
    };
    const report = await runEmbeddingProviderConformance(provider);
    expect(report.passed).toBe(true);
    expect(report.probeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.checks.map((check) => check.id)).toEqual([
      'batch-cardinality',
      'vector-validation',
      'repeat-cardinality',
      'determinism',
      'batch-latency',
    ]);
  });

  it('reports non-deterministic providers without accepting them as conformant', async () => {
    let call = 0;
    const provider: EmbeddingProvider = {
      provider: 'unstable-test',
      model: 'unstable-v1',
      dimensions: 2,
      embed: async (texts) => {
        call += 1;
        return texts.map(() => [call, 1]);
      },
    };
    const report = await runEmbeddingProviderConformance(provider);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'determinism', passed: false }),
    );
  });
});

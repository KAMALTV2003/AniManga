import { describe, expect, it } from 'vitest';

import {
  CapabilityComposer,
  CapabilityEmbeddingIndex,
  CapabilityGraph,
  CapabilityRetriever,
  SynthesisProposalRegistry,
  type EmbeddingProvider,
} from '@nexus-ai/capabilities';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';

const PROJECT_ID = 'prj_capability_test';

async function testDatabase(): Promise<SqliteDatabase> {
  const database = new SqliteDatabase({ path: ':memory:' });
  await database.start();
  new ProjectRepository(database).upsert({
    id: PROJECT_ID,
    name: 'Capability Test',
    rootPath: '/tmp/nexus-capability-test',
  });
  return database;
}

function register(
  graph: CapabilityGraph,
  name: string,
  capabilities: readonly string[],
  options: {
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly contextBytes?: number;
    readonly status?: 'active' | 'inactive';
  } = {},
) {
  return graph.register({
    projectId: PROJECT_ID,
    nodeType: 'skill',
    objectId: `skill_${name}`,
    objectVersionId: `version_${name}_1`,
    name,
    description: options.description ?? `${name} capability`,
    capabilities,
    tags: options.tags ?? capabilities,
    contextBytes: options.contextBytes ?? 100,
    status: options.status ?? 'active',
  });
}

class KeywordEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'test-provider';
  readonly model = 'keyword-v1';
  readonly dimensions = 2;

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return normalized.includes('security') || normalized.includes('protect') ? [1, 0] : [0, 1];
    });
  }
}

describe('CapabilityGraph', () => {
  it('versions indexed documents, scopes edges to a project, and keeps one active version', async () => {
    const database = await testDatabase();
    try {
      const graph = new CapabilityGraph(database);
      const first = register(graph, 'release', ['release-notes']);
      const second = graph.register({
        projectId: PROJECT_ID,
        nodeType: 'skill',
        objectId: 'skill_release',
        objectVersionId: 'version_release_2',
        name: 'release',
        description: 'Improved release capability',
        capabilities: ['release-notes'],
      });
      const security = register(graph, 'security', ['security-review']);

      expect(first.node.id).toBe(second.node.id);
      expect(graph.listActive(PROJECT_ID).map((item) => item.document.objectVersionId)).toEqual([
        'version_release_2',
        'version_security_1',
      ]);
      const edge = graph.connect({
        projectId: PROJECT_ID,
        sourceNodeId: second.node.id,
        targetNodeId: security.node.id,
        edgeType: 'depends_on',
        confidence: 0.9,
      });
      expect(edge).toMatchObject({ edgeType: 'depends_on', confidence: 0.9 });
      expect(graph.listEdges(PROJECT_ID)).toHaveLength(1);

      new ProjectRepository(database).upsert({
        id: 'prj_other',
        name: 'Other',
        rootPath: '/tmp/nexus-capability-other',
      });
      expect(() =>
        graph.register({
          projectId: 'prj_other',
          nodeType: 'skill',
          objectId: 'skill_release',
          objectVersionId: 'version_other',
          name: 'release',
          description: 'Cross-project collision',
        }),
      ).toThrow(/another project/u);
      const other = graph.register({
        projectId: 'prj_other',
        nodeType: 'skill',
        objectId: 'skill_other',
        objectVersionId: 'version_other',
        name: 'other',
        description: 'Other project capability',
      });
      expect(() =>
        graph.connect({
          projectId: PROJECT_ID,
          sourceNodeId: second.node.id,
          targetNodeId: other.node.id,
          edgeType: 'uses',
        }),
      ).toThrow(/not available in project/u);
    } finally {
      await database.stop();
    }
  });

  it('synchronizes active Skill metadata and resolves only project-local dependencies', async () => {
    const database = await testDatabase();
    try {
      insertSkill(database, 'base', 'active', [], ['foundation']);
      insertSkill(database, 'release', 'active', ['base'], ['release']);
      insertSkill(database, 'candidate-only', 'candidate', [], ['candidate']);

      const result = new CapabilityGraph(database).syncActiveSkills(PROJECT_ID);
      expect(result).toMatchObject({ indexedSkills: 2, dependencyEdges: 1 });
      expect(result.unresolvedDependencies).toEqual({});
      expect(new CapabilityGraph(database).listActive(PROJECT_ID)).toHaveLength(2);
    } finally {
      await database.stop();
    }
  });
});

describe('hybrid capability retrieval', () => {
  it('combines bounded lexical, metadata, and graph evidence without persisting raw queries', async () => {
    const database = await testDatabase();
    try {
      const graph = new CapabilityGraph(database);
      const release = register(graph, 'release', ['release-notes'], {
        description: 'Prepare accurate changelogs and software release notes',
        tags: ['documentation'],
      });
      const security = register(graph, 'security', ['security-review'], {
        description: 'Review code for vulnerabilities and unsafe behavior',
        tags: ['security'],
      });
      register(graph, 'inactive', ['release-notes'], { status: 'inactive' });
      graph.connect({
        projectId: PROJECT_ID,
        sourceNodeId: release.node.id,
        targetNodeId: security.node.id,
        edgeType: 'enhances',
      });

      const retriever = new CapabilityRetriever(database);
      const lexical = await retriever.retrieve({
        projectId: PROJECT_ID,
        query: 'accurate release notes',
        requiredTags: ['documentation'],
      });
      expect(lexical.results.map((item) => item.name)).toEqual(['release']);
      expect(lexical.results[0]?.components.lexical).toBeGreaterThan(0);
      expect(lexical.semanticAvailable).toBe(false);

      const graphOnly = await retriever.retrieve({
        projectId: PROJECT_ID,
        query: 'capability',
        anchorNodeIds: [release.node.id],
        weights: { lexical: 0, semantic: 0, metadata: 0, graph: 1 },
      });
      expect(graphOnly.results[0]?.nodeId).toBe(release.node.id);
      expect(graphOnly.results[1]?.nodeId).toBe(security.node.id);
      const persisted = database.connection
        .prepare('SELECT query_sha256 AS queryHash FROM retrieval_runs WHERE id = ?')
        .get(lexical.runId) as { readonly queryHash: string };
      expect(persisted.queryHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(persisted.queryHash).not.toContain('release');
    } finally {
      await database.stop();
    }
  });

  it('indexes validated provider vectors and uses exact cosine similarity', async () => {
    const database = await testDatabase();
    try {
      const graph = new CapabilityGraph(database);
      register(graph, 'security', ['security-review'], {
        description: 'security vulnerability review',
      });
      register(graph, 'release', ['release-notes'], {
        description: 'software release documentation',
      });
      const provider = new KeywordEmbeddingProvider();
      const index = new CapabilityEmbeddingIndex(database);
      await expect(
        index.indexProject(PROJECT_ID, provider, { batchSize: 1 }),
      ).resolves.toMatchObject({
        indexed: 2,
        unchanged: 0,
      });
      await expect(index.indexProject(PROJECT_ID, provider)).resolves.toMatchObject({
        indexed: 0,
        unchanged: 2,
      });

      const response = await new CapabilityRetriever(database).retrieve({
        projectId: PROJECT_ID,
        query: 'protect systems',
        embeddingProvider: provider,
        weights: { lexical: 0, semantic: 1, metadata: 0, graph: 0 },
      });
      expect(response.semanticAvailable).toBe(true);
      expect(response.results[0]).toMatchObject({ name: 'security' });
      expect(response.results[0]?.components.semantic).toBe(1);

      const invalid: EmbeddingProvider = {
        provider: 'invalid-provider',
        model: 'invalid-v1',
        dimensions: 2,
        embed: async (texts) => texts.map(() => [Number.NaN, 0]),
      };
      await expect(index.indexProject(PROJECT_ID, invalid)).rejects.toMatchObject({
        code: 'EMBEDDING_RESPONSE_INVALID',
      });
      const invalidRows = database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM capability_embeddings WHERE provider = 'invalid-provider'",
        )
        .get() as { readonly count: number };
      expect(invalidRows.count).toBe(0);
    } finally {
      await database.stop();
    }
  });
});

describe('capability composition and synthesis contracts', () => {
  it('includes transitive dependencies and finds a smallest sufficient bounded bundle', async () => {
    const database = await testDatabase();
    try {
      const graph = new CapabilityGraph(database);
      const audit = register(graph, 'audit', ['security-review'], { contextBytes: 80 });
      const deploy = register(graph, 'deploy', ['deployment'], { contextBytes: 120 });
      register(graph, 'docs', ['documentation'], { contextBytes: 20 });
      graph.connect({
        projectId: PROJECT_ID,
        sourceNodeId: deploy.node.id,
        targetNodeId: audit.node.id,
        edgeType: 'depends_on',
      });

      const result = await new CapabilityComposer(database).compose({
        projectId: PROJECT_ID,
        query: 'secure deployment capability',
        requiredCapabilities: ['deployment', 'security-review'],
        maxContextBytes: 500,
      });
      expect(result).toMatchObject({
        status: 'complete',
        solverMode: 'bounded-exact',
        contextBytes: 200,
        uncoveredCapabilities: [],
      });
      expect(result.selected.map((item) => [item.name, item.selectedAs])).toEqual(
        expect.arrayContaining([
          ['audit', 'dependency'],
          ['deploy', 'primary'],
        ]),
      );
      expect(
        database.connection
          .prepare('SELECT status FROM composition_plans WHERE id = ?')
          .get(result.planId),
      ).toEqual({ status: 'complete' });
    } finally {
      await database.stop();
    }
  });

  it('fails closed on conflicts and budgets, then persists an inert evidence-backed proposal', async () => {
    const database = await testDatabase();
    try {
      const graph = new CapabilityGraph(database);
      const writer = register(graph, 'writer', ['write'], { contextBytes: 90 });
      const reviewer = register(graph, 'reviewer', ['review'], { contextBytes: 90 });
      graph.connect({
        projectId: PROJECT_ID,
        sourceNodeId: writer.node.id,
        targetNodeId: reviewer.node.id,
        edgeType: 'conflicts_with',
      });

      const composition = await new CapabilityComposer(database).compose({
        projectId: PROJECT_ID,
        query: 'write and review output',
        requiredCapabilities: ['write', 'review', 'publish'],
        maxContextBytes: 100,
      });
      expect(composition.status).toBe('incomplete');
      expect(composition.solverMode).toBe('infeasible');
      expect(composition.uncoveredCapabilities).toContain('publish');

      const registry = new SynthesisProposalRegistry(database);
      const proposal = registry.create({
        projectId: PROJECT_ID,
        composition,
        name: 'safe-publisher',
        intent: 'Publish reviewed output without external side effects',
        requiredBehaviors: ['publish'],
        acceptanceCriteria: ['Reject output that has not passed review'],
        prohibitedBehaviors: ['Do not execute imported content'],
      });
      expect(proposal).toMatchObject({ status: 'draft', requiredBehaviors: ['publish'] });
      expect(
        registry.create({
          projectId: PROJECT_ID,
          composition,
          name: 'safe-publisher',
          intent: 'Publish reviewed output without external side effects',
          requiredBehaviors: ['publish'],
          acceptanceCriteria: ['Reject output that has not passed review'],
          prohibitedBehaviors: ['Do not execute imported content'],
        }).id,
      ).toBe(proposal.id);
      const stored = database.connection
        .prepare('SELECT intent_sha256 AS intentHash FROM synthesis_proposals WHERE id = ?')
        .get(proposal.id) as { readonly intentHash: string };
      expect(stored.intentHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await database.stop();
    }
  });
});

function insertSkill(
  database: SqliteDatabase,
  name: string,
  status: 'active' | 'candidate',
  dependencies: readonly string[],
  tags: readonly string[],
): void {
  const skillId = `skill_sync_${name}`;
  const versionId = `skill_version_sync_${name}`;
  const now = new Date().toISOString();
  database.connection
    .prepare(
      `INSERT INTO skills(
         id, project_id, name, description, scope, status, current_version_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'project', ?, ?, ?, ?)`,
    )
    .run(skillId, PROJECT_ID, name, `${name} description`, status, versionId, now, now);
  database.connection
    .prepare(
      `INSERT INTO skill_versions(
         id, skill_id, version, instructions_path, metadata_json, dependencies_json,
         required_tools_json, risk_level, content_sha256, created_at
       ) VALUES (?, ?, '1.0.0', ?, ?, ?, '[]', 'low', ?, ?)`,
    )
    .run(
      versionId,
      skillId,
      `/tmp/${name}/SKILL.md`,
      JSON.stringify({ tags }),
      JSON.stringify(dependencies),
      name
        .padEnd(64, 'a')
        .slice(0, 64)
        .replaceAll(/[^a-f0-9]/gu, 'a'),
      now,
    );
}

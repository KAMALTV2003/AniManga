import { performance } from 'node:perf_hooks';

import { createId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import { MAX_EXACT_EMBEDDING_VALUES, validateVector } from './embeddings.js';
import { CapabilityGraph } from './graph.js';
import type {
  CapabilityDocument,
  CapabilityNode,
  CapabilityNodeType,
  CapabilityRetrievalResult,
  CapabilityRisk,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalScoreComponents,
  RetrievalWeights,
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

export const RETRIEVAL_STRATEGY_VERSION = 'hybrid-rrf-v1';
const DEFAULT_WEIGHTS: RetrievalWeights = {
  lexical: 0.45,
  semantic: 0.3,
  metadata: 0.15,
  graph: 0.1,
};
const DEFAULT_RISKS: readonly CapabilityRisk[] = ['unknown', 'safe', 'low', 'medium', 'high'];

interface LexicalRow {
  readonly documentId: string;
  readonly rank: number;
}

interface EmbeddingRow {
  readonly documentId: string;
  readonly dimensions: number;
  readonly vectorJson: string;
  readonly vectorNorm: number;
}

interface ScoredCandidate {
  readonly capability: { readonly node: CapabilityNode; readonly document: CapabilityDocument };
  readonly score: number;
  readonly components: RetrievalScoreComponents;
  readonly explanation: readonly string[];
}

export class CapabilityRetriever {
  readonly #database: SqliteDatabase;
  readonly #graph: CapabilityGraph;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#graph = new CapabilityGraph(database);
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const started = performance.now();
    const projectId = requireSimpleKey(request.projectId, 'projectId', 160);
    const query = requireBoundedText(request.query, 'query', 512);
    const tokens = tokenizeQuery(query);
    const limit = requirePositiveInteger(request.limit ?? 10, 'limit', 100);
    const candidateLimit = requirePositiveInteger(
      request.candidateLimit ?? Math.max(100, limit * 5),
      'candidateLimit',
      500,
    );
    if (candidateLimit < limit) throw new RangeError('candidateLimit cannot be lower than limit');
    const requiredTags = normalizeTerms(request.requiredTags, 'requiredTags', 32);
    const preferredTags = normalizeTerms(request.preferredTags, 'preferredTags', 32);
    const anchorNodeIds = normalizeIds(request.anchorNodeIds, 'anchorNodeIds', 32);
    const nodeTypes = normalizeNodeTypes(request.nodeTypes);
    const allowedRisks = normalizeRisks(request.allowedRisks);
    const configuredWeights = validateWeights(request.weights);

    const count = this.#database.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM capability_documents
         WHERE project_id = ? AND status = 'active'`,
      )
      .get(projectId) as { readonly count: number };
    if (count.count > 10_000) {
      throw capabilityError(
        'CAPABILITY_RETRIEVAL_LIMIT',
        'Exact local retrieval is bounded to 10000 active documents per project',
      );
    }
    const all = this.#graph.listActive(projectId, 10_000).filter(({ node, document }) => {
      return (
        (nodeTypes.length === 0 || nodeTypes.includes(node.nodeType)) &&
        allowedRisks.includes(document.risk) &&
        requiredTags.every((tag) => document.tags.includes(tag))
      );
    });
    const byDocument = new Map(all.map((item) => [item.document.id, item]));

    const lexicalRanks = this.#lexicalRanks(projectId, tokens, candidateLimit, byDocument);
    const metadataScores = scoreMetadata(all, preferredTags, requiredTags);
    const graphScores = this.#graphScores(projectId, anchorNodeIds, byDocument);
    const semantic = await this.#semanticScores(
      projectId,
      query,
      request.embeddingProvider,
      candidateLimit,
      byDocument,
    );
    const availability = {
      lexical: true,
      semantic: semantic.available,
      metadata: preferredTags.length > 0 || requiredTags.length > 0,
      graph: anchorNodeIds.length > 0,
    };
    const effectiveWeights = effectiveWeightsFor(configuredWeights, availability);
    const candidateIds = new Set<string>([
      ...lexicalRanks.keys(),
      ...semantic.scores.keys(),
      ...metadataScores.keys(),
      ...graphScores.keys(),
    ]);
    const candidates: ScoredCandidate[] = [];
    for (const documentId of candidateIds) {
      const capability = byDocument.get(documentId);
      if (capability === undefined) continue;
      const lexical = lexicalRanks.get(documentId) ?? 0;
      const semanticScore = semantic.scores.get(documentId) ?? 0;
      const metadata = metadataScores.get(documentId) ?? 0;
      const graph = graphScores.get(documentId) ?? 0;
      const components: RetrievalScoreComponents = {
        lexical,
        semantic: availability.semantic ? semanticScore : null,
        metadata: availability.metadata ? metadata : null,
        graph: availability.graph ? graph : null,
      };
      const score =
        lexical * effectiveWeights.lexical +
        semanticScore * effectiveWeights.semantic +
        metadata * effectiveWeights.metadata +
        graph * effectiveWeights.graph;
      if (score <= 0) continue;
      candidates.push({
        capability,
        score,
        components,
        explanation: explanations(components),
      });
    }
    candidates.sort(
      (left, right) =>
        right.score - left.score ||
        left.capability.document.name.localeCompare(right.capability.document.name, 'en') ||
        left.capability.node.id.localeCompare(right.capability.node.id, 'en'),
    );
    const results = candidates.slice(0, limit).map(mapResult);
    const durationMs = Math.max(0, performance.now() - started);
    const runId = createId('retrieval');
    const filters = {
      nodeTypes,
      requiredTags,
      preferredTags,
      anchorNodeIds,
      allowedRisks,
      limit,
      candidateLimit,
    };
    this.#database.connection
      .prepare(
        `INSERT INTO retrieval_runs(
           id, project_id, query_sha256, strategy_version, embedding_provider,
           embedding_model, weights_json, filters_json, candidate_count, results_json,
           duration_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        projectId,
        sha256(query),
        RETRIEVAL_STRATEGY_VERSION,
        request.embeddingProvider?.provider ?? null,
        request.embeddingProvider?.model ?? null,
        stableStringify(effectiveWeights),
        stableStringify(filters),
        candidateIds.size,
        stableStringify(results),
        durationMs,
        new Date().toISOString(),
      );
    return {
      runId,
      strategyVersion: RETRIEVAL_STRATEGY_VERSION,
      indexBackend: 'sqlite-fts5+exact-cosine',
      semanticAvailable: semantic.available,
      effectiveWeights,
      candidateCount: candidateIds.size,
      durationMs,
      results,
    };
  }

  #lexicalRanks(
    projectId: string,
    tokens: readonly string[],
    limit: number,
    allowed: ReadonlyMap<string, unknown>,
  ): ReadonlyMap<string, number> {
    const expression = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ');
    const rows = this.#database.connection
      .prepare(
        `SELECT d.id AS documentId, bm25(capability_documents_fts, 8.0, 3.0, 1.0) AS rank
         FROM capability_documents_fts
         JOIN capability_documents d ON d.rowid = capability_documents_fts.rowid
         WHERE capability_documents_fts MATCH ? AND d.project_id = ? AND d.status = 'active'
         ORDER BY rank ASC, d.id ASC LIMIT ?`,
      )
      .all(expression, projectId, Math.min(limit * 2, 1_000)) as LexicalRow[];
    const filtered = rows.filter((row) => allowed.has(row.documentId)).slice(0, limit);
    return new Map(filtered.map((row, index) => [row.documentId, 1 / (index + 1)]));
  }

  #graphScores(
    projectId: string,
    anchors: readonly string[],
    allowed: ReadonlyMap<string, unknown>,
  ): ReadonlyMap<string, number> {
    if (anchors.length === 0) return new Map();
    const allowedNodeIds = new Set(
      [...allowed.values()].map((item) => (item as { readonly node: CapabilityNode }).node.id),
    );
    for (const anchor of anchors) {
      if (!allowedNodeIds.has(anchor)) {
        throw capabilityError(
          'CAPABILITY_ANCHOR_NOT_FOUND',
          `Retrieval anchor is not an active capability in this project: ${anchor}`,
        );
      }
    }
    const adjacency = new Map<string, Set<string>>();
    for (const edge of this.#graph.listEdges(projectId)) {
      addNeighbor(adjacency, edge.sourceNodeId, edge.targetNodeId);
      addNeighbor(adjacency, edge.targetNodeId, edge.sourceNodeId);
    }
    const distances = new Map<string, number>();
    let frontier = [...anchors];
    for (const anchor of anchors) distances.set(anchor, 0);
    for (let depth = 1; depth <= 3 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const neighbor of adjacency.get(nodeId) ?? []) {
          if (!allowedNodeIds.has(neighbor) || distances.has(neighbor)) continue;
          distances.set(neighbor, depth);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    const scores = new Map<string, number>();
    for (const capability of allowed.values()) {
      const typed = capability as {
        readonly node: CapabilityNode;
        readonly document: CapabilityDocument;
      };
      const distance = distances.get(typed.node.id);
      if (distance !== undefined) scores.set(typed.document.id, 1 / (distance + 1));
    }
    return scores;
  }

  async #semanticScores(
    projectId: string,
    query: string,
    provider: RetrievalRequest['embeddingProvider'],
    limit: number,
    allowed: ReadonlyMap<string, unknown>,
  ): Promise<{ readonly available: boolean; readonly scores: ReadonlyMap<string, number> }> {
    if (provider === undefined) return { available: false, scores: new Map() };
    const providerName = requireSimpleKey(provider.provider, 'embedding provider');
    const model = requireSimpleKey(provider.model, 'embedding model');
    const dimensions = requirePositiveInteger(provider.dimensions, 'embedding dimensions', 8_192);
    const rows = this.#database.connection
      .prepare(
        `SELECT e.document_id AS documentId, e.dimensions, e.vector_json AS vectorJson,
                e.vector_norm AS vectorNorm
         FROM capability_embeddings e
         JOIN capability_documents d ON d.id = e.document_id
         WHERE d.project_id = ? AND d.status = 'active'
           AND e.provider = ? AND e.model = ? AND e.dimensions = ?
           AND e.content_sha256 = d.content_sha256
         ORDER BY e.document_id`,
      )
      .all(projectId, providerName, model, dimensions) as EmbeddingRow[];
    const filtered = rows.filter((row) => allowed.has(row.documentId));
    if (filtered.length === 0) return { available: false, scores: new Map() };
    if (filtered.length * dimensions > MAX_EXACT_EMBEDDING_VALUES) {
      throw capabilityError(
        'CAPABILITY_EMBEDDING_LIMIT',
        'Exact cosine retrieval exceeds the bounded vector-value budget',
      );
    }
    const response = await provider.embed([query]);
    if (response.length !== 1 || response[0] === undefined) {
      throw capabilityError(
        'EMBEDDING_RESPONSE_INVALID',
        'Embedding provider did not return one query vector',
      );
    }
    const queryVector = validateVector(response[0], dimensions);
    const scored: [string, number][] = filtered.map((row) => {
      const stored = parseStoredVector(row.vectorJson, row.dimensions, row.vectorNorm);
      const similarity = cosine(queryVector.values, queryVector.norm, stored.values, stored.norm);
      return [row.documentId, Math.max(0, similarity)];
    });
    scored.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'));
    return { available: true, scores: new Map(scored.slice(0, limit)) };
  }
}

function tokenizeQuery(query: string): readonly string[] {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  if (tokens.length === 0) throw new RangeError('query must contain a letter or number');
  if (tokens.length > 20) throw new RangeError('query must not exceed 20 terms');
  return [...new Set(tokens.map((token) => token.toLocaleLowerCase('en-US')))];
}

function normalizeIds(
  values: readonly string[] | undefined,
  name: string,
  maximum: number,
): readonly string[] {
  if (values === undefined) return [];
  if (values.length > maximum) throw new RangeError(`${name} must not exceed ${maximum} items`);
  return [...new Set(values.map((value) => requireSimpleKey(value, `${name} item`, 256)))].sort();
}

function normalizeNodeTypes(
  values: readonly CapabilityNodeType[] | undefined,
): readonly CapabilityNodeType[] {
  if (values === undefined) return [];
  if (values.length > 11) throw new RangeError('nodeTypes must not exceed 11 items');
  const allowed: readonly string[] = [
    'skill',
    'agent',
    'tool',
    'model',
    'mcp_server',
    'workflow',
    'dataset',
    'project',
    'policy',
    'evaluator',
    'memory',
  ];
  for (const value of values) {
    if (!allowed.includes(value)) throw new RangeError(`Unsupported node type: ${value}`);
  }
  return [...new Set(values)].sort();
}

function normalizeRisks(values: readonly CapabilityRisk[] | undefined): readonly CapabilityRisk[] {
  const risks = values ?? DEFAULT_RISKS;
  const allowed: readonly string[] = [
    'unknown',
    'safe',
    'low',
    'medium',
    'high',
    'critical',
    'blocked',
  ];
  if (risks.length === 0 || risks.length > allowed.length) {
    throw new RangeError('allowedRisks must contain between 1 and 7 values');
  }
  for (const value of risks) {
    if (!allowed.includes(value)) throw new RangeError(`Unsupported risk: ${value}`);
  }
  return [...new Set(risks)].sort();
}

function validateWeights(value: Partial<RetrievalWeights> | undefined): RetrievalWeights {
  const weights = { ...DEFAULT_WEIGHTS, ...value };
  for (const [name, weight] of Object.entries(weights)) requireFiniteUnit(weight, `${name} weight`);
  if (Object.values(weights).every((weight) => weight === 0)) {
    throw new RangeError('At least one retrieval weight must be greater than zero');
  }
  return weights;
}

function effectiveWeightsFor(
  configured: RetrievalWeights,
  available: Readonly<Record<keyof RetrievalWeights, boolean>>,
): RetrievalWeights {
  const total = (Object.keys(configured) as (keyof RetrievalWeights)[]).reduce(
    (sum, key) => sum + (available[key] ? configured[key] : 0),
    0,
  );
  if (total === 0) {
    throw new RangeError('Configured retrieval weights disable all available retrieval signals');
  }
  return {
    lexical: available.lexical ? configured.lexical / total : 0,
    semantic: available.semantic ? configured.semantic / total : 0,
    metadata: available.metadata ? configured.metadata / total : 0,
    graph: available.graph ? configured.graph / total : 0,
  };
}

function scoreMetadata(
  capabilities: readonly { readonly document: CapabilityDocument }[],
  preferred: readonly string[],
  required: readonly string[],
): ReadonlyMap<string, number> {
  const terms = preferred.length > 0 ? preferred : required;
  if (terms.length === 0) return new Map();
  const scores = new Map<string, number>();
  for (const { document } of capabilities) {
    const searchable = new Set([...document.tags, ...document.capabilities]);
    const matches = terms.filter((term) => searchable.has(term)).length;
    if (matches > 0) scores.set(document.id, matches / terms.length);
  }
  return scores;
}

function addNeighbor(adjacency: Map<string, Set<string>>, source: string, target: string): void {
  const neighbors = adjacency.get(source) ?? new Set<string>();
  neighbors.add(target);
  adjacency.set(source, neighbors);
}

function parseStoredVector(
  value: string,
  dimensions: number,
  expectedNorm: number,
): { readonly values: readonly number[]; readonly norm: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw capabilityError(
      'CAPABILITY_INDEX_CORRUPT',
      'Stored embedding is invalid JSON',
      undefined,
      error,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number')) {
    throw capabilityError('CAPABILITY_INDEX_CORRUPT', 'Stored embedding is not a numeric vector');
  }
  let vector;
  try {
    vector = validateVector(parsed, dimensions);
  } catch (error) {
    throw capabilityError(
      'CAPABILITY_INDEX_CORRUPT',
      'Stored embedding vector is invalid',
      undefined,
      error,
    );
  }
  if (!Number.isFinite(expectedNorm) || Math.abs(vector.norm - expectedNorm) > 1e-9 * vector.norm) {
    throw capabilityError(
      'CAPABILITY_INDEX_CORRUPT',
      'Stored embedding norm does not match its vector',
    );
  }
  return vector;
}

function cosine(
  left: readonly number[],
  leftNorm: number,
  right: readonly number[],
  rightNorm: number,
): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  const value = dot / (leftNorm * rightNorm);
  if (!Number.isFinite(value)) {
    throw capabilityError('CAPABILITY_INDEX_CORRUPT', 'Cosine similarity was not finite');
  }
  return Math.max(-1, Math.min(1, value));
}

function explanations(components: RetrievalScoreComponents): readonly string[] {
  const output: string[] = [];
  if ((components.lexical ?? 0) > 0) output.push('lexical match');
  if ((components.semantic ?? 0) > 0) output.push('semantic similarity');
  if ((components.metadata ?? 0) > 0) output.push('metadata preference match');
  if ((components.graph ?? 0) > 0) output.push('graph proximity');
  return output;
}

function mapResult(candidate: ScoredCandidate): CapabilityRetrievalResult {
  const { node, document } = candidate.capability;
  return {
    nodeId: node.id,
    documentId: document.id,
    nodeType: node.nodeType,
    objectId: node.objectId,
    objectVersionId: document.objectVersionId,
    name: document.name,
    description: document.description,
    risk: document.risk,
    tags: document.tags,
    capabilities: document.capabilities,
    contextBytes: document.contextBytes,
    score: candidate.score,
    components: candidate.components,
    explanation: candidate.explanation,
  };
}

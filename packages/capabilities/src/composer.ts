import { createId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import { CapabilityGraph } from './graph.js';
import { CapabilityRetriever } from './retrieval.js';
import type {
  CapabilityDocument,
  CapabilityNode,
  CapabilityRetrievalResult,
  ComposedCapability,
  CompositionRequest,
  CompositionResponse,
} from './types.js';
import {
  normalizeTerms,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSimpleKey,
  sha256,
} from './validation.js';

const MAX_EXPLORED_STATES = 200_000;

interface Option {
  readonly root: CapabilityRetrievalResult;
  readonly nodes: ReadonlySet<string>;
  readonly coverage: ReadonlySet<string>;
  readonly contextBytes: number;
  readonly valid: boolean;
  readonly reason: string | null;
}

interface Solution {
  readonly nodeIds: ReadonlySet<string>;
  readonly rootIds: ReadonlySet<string>;
  readonly covered: ReadonlySet<string>;
  readonly contextBytes: number;
  readonly score: number;
}

export class CapabilityComposer {
  readonly #database: SqliteDatabase;
  readonly #graph: CapabilityGraph;
  readonly #retriever: CapabilityRetriever;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#graph = new CapabilityGraph(database);
    this.#retriever = new CapabilityRetriever(database);
  }

  async compose(request: CompositionRequest): Promise<CompositionResponse> {
    const projectId = requireSimpleKey(request.projectId, 'projectId', 160);
    const requirements = normalizeTerms(request.requiredCapabilities, 'requiredCapabilities', 16);
    if (requirements.length === 0) {
      throw new RangeError('requiredCapabilities must contain at least one behavior');
    }
    const maxNodes = requirePositiveInteger(request.maxNodes ?? 10, 'maxNodes', 20);
    const maxContextBytes = requireNonNegativeInteger(
      request.maxContextBytes ?? 1_000_000,
      'maxContextBytes',
      100_000_000,
    );
    const retrievalLimit = requirePositiveInteger(
      request.retrievalLimit ?? 20,
      'retrievalLimit',
      20,
    );
    const forbidden = new Set(normalizeNodeIds(request.forbiddenNodeIds, 'forbiddenNodeIds', 100));
    const preferredTags = normalizeTerms(
      [...(request.preferredTags ?? []), ...requirements],
      'preferredTags',
      48,
    );
    const retrieval = await this.#retriever.retrieve({
      projectId,
      query: request.query,
      limit: retrievalLimit,
      preferredTags,
      ...(request.candidateLimit === undefined ? {} : { candidateLimit: request.candidateLimit }),
      ...(request.nodeTypes === undefined ? {} : { nodeTypes: request.nodeTypes }),
      ...(request.requiredTags === undefined ? {} : { requiredTags: request.requiredTags }),
      ...(request.anchorNodeIds === undefined ? {} : { anchorNodeIds: request.anchorNodeIds }),
      ...(request.allowedRisks === undefined ? {} : { allowedRisks: request.allowedRisks }),
      ...(request.weights === undefined ? {} : { weights: request.weights }),
      ...(request.embeddingProvider === undefined
        ? {}
        : { embeddingProvider: request.embeddingProvider }),
    });
    const active = this.#graph.listActive(projectId, 10_000);
    const byNode = new Map(active.map((item) => [item.node.id, item]));
    const edges = this.#graph.listEdges(projectId);
    const dependencies = new Map<string, Set<string>>();
    const conflicts = new Set<string>();
    for (const edge of edges) {
      if (edge.edgeType === 'depends_on' || edge.edgeType === 'requires') {
        addSetValue(dependencies, edge.sourceNodeId, edge.targetNodeId);
      }
      if (edge.edgeType === 'conflicts_with') {
        conflicts.add(conflictKey(edge.sourceNodeId, edge.targetNodeId));
      }
    }
    const options = retrieval.results.map((result) =>
      buildOption(result, byNode, dependencies, conflicts, forbidden),
    );
    const invalidReasons = options
      .filter((option) => !option.valid && option.reason !== null)
      .map((option) => `${option.root.name}: ${option.reason}`);

    const viable = options.filter((option) => option.valid);
    const searchResult = solveBounded(viable, requirements, byNode, conflicts, {
      maxNodes,
      maxContextBytes,
    });
    const selectedSolution =
      searchResult.best ??
      greedyPartial(viable, requirements, byNode, conflicts, {
        maxNodes,
        maxContextBytes,
      });
    const uncovered = requirements.filter(
      (requirement) => !selectedSolution.covered.has(requirement),
    );
    const status = uncovered.length === 0 ? 'complete' : 'incomplete';
    const solverMode = searchResult.bounded
      ? 'bounded-search'
      : searchResult.best === null
        ? 'infeasible'
        : 'bounded-exact';
    const selected = mapSelection(selectedSolution, byNode);
    const evidence = [
      `retrieval strategy ${retrieval.strategyVersion} produced ${retrieval.results.length} results`,
      `solver considered ${viable.length} valid root capabilities across ${searchResult.exploredStates} states`,
      `selected ${selected.length} unique nodes using ${selectedSolution.contextBytes} context bytes`,
      ...invalidReasons.slice(0, 20),
    ];
    const planId = createId('composition');
    this.#database.connection
      .prepare(
        `INSERT INTO composition_plans(
           id, project_id, retrieval_run_id, query_sha256, strategy_version, solver_mode,
           status, requirements_json, selected_nodes_json, uncovered_json, evidence_json,
           context_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        planId,
        projectId,
        retrieval.runId,
        sha256(request.query.normalize('NFKC').trim()),
        `set-cover-v1+${retrieval.strategyVersion}`,
        solverMode,
        status,
        stableStringify(requirements),
        stableStringify(selected),
        stableStringify(uncovered),
        stableStringify({
          messages: evidence,
          exploredStates: searchResult.exploredStates,
          maxNodes,
          maxContextBytes,
          bounded: searchResult.bounded,
        }),
        selectedSolution.contextBytes,
        new Date().toISOString(),
      );
    return {
      planId,
      retrievalRunId: retrieval.runId,
      status,
      solverMode,
      requiredCapabilities: requirements,
      selected,
      uncoveredCapabilities: uncovered,
      contextBytes: selectedSolution.contextBytes,
      exploredStates: searchResult.exploredStates,
      evidence,
    };
  }
}

function buildOption(
  root: CapabilityRetrievalResult,
  byNode: ReadonlyMap<
    string,
    { readonly node: CapabilityNode; readonly document: CapabilityDocument }
  >,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  conflicts: ReadonlySet<string>,
  forbidden: ReadonlySet<string>,
): Option {
  const nodes = new Set<string>();
  const pending = [root.nodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || nodes.has(nodeId)) continue;
    if (forbidden.has(nodeId)) {
      return invalidOption(root, nodes, `forbidden dependency ${nodeId}`);
    }
    const capability = byNode.get(nodeId);
    if (capability === undefined) {
      return invalidOption(root, nodes, `missing or inactive dependency ${nodeId}`);
    }
    nodes.add(nodeId);
    if (nodes.size > 100) return invalidOption(root, nodes, 'dependency closure exceeds 100 nodes');
    pending.push(...(dependencies.get(nodeId) ?? []));
  }
  if (hasConflict(nodes, conflicts)) {
    return invalidOption(root, nodes, 'dependency closure contains a conflict');
  }
  const rootDocument = byNode.get(root.nodeId)?.document;
  const declaredDependencies = stringArrayMetadata(rootDocument?.metadata['dependencies']);
  if (declaredDependencies.length > (dependencies.get(root.nodeId)?.size ?? 0)) {
    return invalidOption(root, nodes, 'one or more declared dependencies are unresolved');
  }
  return {
    root,
    nodes,
    coverage: coverageFor(nodes, byNode),
    contextBytes: contextFor(nodes, byNode),
    valid: true,
    reason: null,
  };
}

function invalidOption(
  root: CapabilityRetrievalResult,
  nodes: ReadonlySet<string>,
  reason: string,
): Option {
  return { root, nodes, coverage: new Set(), contextBytes: 0, valid: false, reason };
}

function compareOptions(left: Option, right: Option): number {
  return (
    left.nodes.size - right.nodes.size ||
    left.contextBytes - right.contextBytes ||
    right.root.score - left.root.score ||
    left.root.nodeId.localeCompare(right.root.nodeId, 'en')
  );
}

function compareSolutions(left: Solution, right: Solution): number {
  return (
    left.nodeIds.size - right.nodeIds.size ||
    left.contextBytes - right.contextBytes ||
    left.rootIds.size - right.rootIds.size ||
    right.score - left.score ||
    [...left.nodeIds]
      .sort()
      .join('|')
      .localeCompare([...right.nodeIds].sort().join('|'), 'en')
  );
}

function solveBounded(
  options: readonly Option[],
  requirements: readonly string[],
  byNode: ReadonlyMap<
    string,
    { readonly node: CapabilityNode; readonly document: CapabilityDocument }
  >,
  conflicts: ReadonlySet<string>,
  limits: { readonly maxNodes: number; readonly maxContextBytes: number },
): { readonly best: Solution | null; readonly bounded: boolean; readonly exploredStates: number } {
  const result: { best: Solution | null; bounded: boolean; exploredStates: number } = {
    best: null,
    bounded: false,
    exploredStates: 0,
  };
  const seen = new Set<string>();
  const search = (solution: Solution): void => {
    result.exploredStates += 1;
    if (result.exploredStates > MAX_EXPLORED_STATES) {
      result.bounded = true;
      return;
    }
    const stateKey = `${[...solution.nodeIds].sort().join('|')}::${[...solution.rootIds]
      .sort()
      .join('|')}`;
    if (seen.has(stateKey)) return;
    seen.add(stateKey);
    if (requirements.every((requirement) => solution.covered.has(requirement))) {
      if (result.best === null || compareSolutions(solution, result.best) < 0) {
        result.best = solution;
      }
      return;
    }
    if (result.best !== null && solution.nodeIds.size >= result.best.nodeIds.size) return;
    const uncovered = requirements.find((requirement) => !solution.covered.has(requirement));
    if (uncovered === undefined) return;
    const choices = options
      .filter(
        (option) => option.coverage.has(uncovered) && !solution.rootIds.has(option.root.nodeId),
      )
      .sort(compareOptions);
    for (const option of choices) {
      if (result.bounded) return;
      const mergedNodes = new Set([...solution.nodeIds, ...option.nodes]);
      if (mergedNodes.size > limits.maxNodes || hasConflict(mergedNodes, conflicts)) continue;
      const contextBytes = contextFor(mergedNodes, byNode);
      if (contextBytes > limits.maxContextBytes) continue;
      search({
        nodeIds: mergedNodes,
        rootIds: new Set([...solution.rootIds, option.root.nodeId]),
        covered: coverageFor(mergedNodes, byNode),
        contextBytes,
        score: solution.score + option.root.score,
      });
    }
  };
  search({
    nodeIds: new Set(),
    rootIds: new Set(),
    covered: new Set(),
    contextBytes: 0,
    score: 0,
  });
  return result;
}

function greedyPartial(
  options: readonly Option[],
  requirements: readonly string[],
  byNode: ReadonlyMap<
    string,
    { readonly node: CapabilityNode; readonly document: CapabilityDocument }
  >,
  conflicts: ReadonlySet<string>,
  limits: { readonly maxNodes: number; readonly maxContextBytes: number },
): Solution {
  let solution: Solution = {
    nodeIds: new Set(),
    rootIds: new Set(),
    covered: new Set(),
    contextBytes: 0,
    score: 0,
  };
  for (;;) {
    const candidates = options
      .filter((option) => !solution.rootIds.has(option.root.nodeId))
      .map((option) => {
        const nodes = new Set([...solution.nodeIds, ...option.nodes]);
        const contextBytes = contextFor(nodes, byNode);
        const newCoverage = [...option.coverage].filter(
          (item) => requirements.includes(item) && !solution.covered.has(item),
        ).length;
        return { option, nodes, contextBytes, newCoverage };
      })
      .filter(
        (item) =>
          item.newCoverage > 0 &&
          item.nodes.size <= limits.maxNodes &&
          item.contextBytes <= limits.maxContextBytes &&
          !hasConflict(item.nodes, conflicts),
      )
      .sort(
        (left, right) =>
          right.newCoverage - left.newCoverage || compareOptions(left.option, right.option),
      );
    const next = candidates[0];
    if (next === undefined) break;
    solution = {
      nodeIds: next.nodes,
      rootIds: new Set([...solution.rootIds, next.option.root.nodeId]),
      covered: coverageFor(next.nodes, byNode),
      contextBytes: next.contextBytes,
      score: solution.score + next.option.root.score,
    };
  }
  return solution;
}

function mapSelection(
  solution: Solution,
  byNode: ReadonlyMap<
    string,
    { readonly node: CapabilityNode; readonly document: CapabilityDocument }
  >,
): readonly ComposedCapability[] {
  return [...solution.nodeIds].sort().map((nodeId) => {
    const capability = byNode.get(nodeId);
    if (capability === undefined) throw new Error('Composition selected an unavailable capability');
    return {
      nodeId,
      documentId: capability.document.id,
      name: capability.document.name,
      objectVersionId: capability.document.objectVersionId,
      contextBytes: capability.document.contextBytes,
      capabilities: capability.document.capabilities,
      selectedAs: solution.rootIds.has(nodeId) ? 'primary' : 'dependency',
    };
  });
}

function coverageFor(
  nodes: ReadonlySet<string>,
  byNode: ReadonlyMap<string, { readonly document: CapabilityDocument }>,
): ReadonlySet<string> {
  const output = new Set<string>();
  for (const nodeId of nodes) {
    for (const behavior of byNode.get(nodeId)?.document.capabilities ?? []) output.add(behavior);
  }
  return output;
}

function contextFor(
  nodes: ReadonlySet<string>,
  byNode: ReadonlyMap<string, { readonly document: CapabilityDocument }>,
): number {
  let total = 0;
  for (const nodeId of nodes) total += byNode.get(nodeId)?.document.contextBytes ?? 0;
  return total;
}

function hasConflict(nodes: ReadonlySet<string>, conflicts: ReadonlySet<string>): boolean {
  const values = [...nodes];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const leftNode = values[left];
      const rightNode = values[right];
      if (
        leftNode !== undefined &&
        rightNode !== undefined &&
        conflicts.has(conflictKey(leftNode, rightNode))
      ) {
        return true;
      }
    }
  }
  return false;
}

function conflictKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function addSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function normalizeNodeIds(
  values: readonly string[] | undefined,
  name: string,
  maximum: number,
): readonly string[] {
  if (values === undefined) return [];
  if (values.length > maximum) throw new RangeError(`${name} must not exceed ${maximum} items`);
  return [...new Set(values.map((value) => requireSimpleKey(value, `${name} item`, 256)))].sort();
}

function stringArrayMetadata(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RangeError('Capability dependency metadata is invalid');
  }
  return value as readonly string[];
}

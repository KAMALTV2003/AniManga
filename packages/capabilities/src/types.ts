export const CAPABILITY_NODE_TYPES = [
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
] as const;

export type CapabilityNodeType = (typeof CAPABILITY_NODE_TYPES)[number];

export const CAPABILITY_EDGE_TYPES = [
  'requires',
  'depends_on',
  'compatible_with',
  'conflicts_with',
  'enhances',
  'replaces',
  'derived_from',
  'tested_by',
  'uses',
  'recommended_for',
] as const;

export type CapabilityEdgeType = (typeof CAPABILITY_EDGE_TYPES)[number];
export type CapabilityRisk =
  'unknown' | 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'blocked';

export interface CapabilityNode {
  readonly id: string;
  readonly projectId: string;
  readonly nodeType: CapabilityNodeType;
  readonly objectId: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CapabilityDocument {
  readonly id: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly objectVersionId: string;
  readonly name: string;
  readonly description: string;
  readonly searchText: string;
  readonly status: 'active' | 'inactive';
  readonly risk: CapabilityRisk;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly contextBytes: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegisterCapabilityInput {
  readonly projectId: string;
  readonly nodeType: CapabilityNodeType;
  readonly objectId: string;
  readonly objectVersionId: string;
  readonly name: string;
  readonly description: string;
  readonly searchText?: string;
  readonly status?: 'active' | 'inactive';
  readonly risk?: CapabilityRisk;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly contextBytes?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contentHash?: string;
}

export interface CapabilityEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: CapabilityEdgeType;
  readonly confidence: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ConnectCapabilitiesInput {
  readonly projectId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: CapabilityEdgeType;
  readonly confidence?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SkillGraphSyncResult {
  readonly projectId: string;
  readonly indexedSkills: number;
  readonly dependencyEdges: number;
  readonly unresolvedDependencies: Readonly<Record<string, readonly string[]>>;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface EmbeddingIndexResult {
  readonly projectId: string;
  readonly provider: string;
  readonly model: string;
  readonly indexed: number;
  readonly unchanged: number;
}

export interface RetrievalWeights {
  readonly lexical: number;
  readonly semantic: number;
  readonly metadata: number;
  readonly graph: number;
}

export interface RetrievalRequest {
  readonly projectId: string;
  readonly query: string;
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly nodeTypes?: readonly CapabilityNodeType[];
  readonly requiredTags?: readonly string[];
  readonly preferredTags?: readonly string[];
  readonly anchorNodeIds?: readonly string[];
  readonly allowedRisks?: readonly CapabilityRisk[];
  readonly weights?: Partial<RetrievalWeights>;
  readonly embeddingProvider?: EmbeddingProvider;
}

export interface RetrievalScoreComponents {
  readonly lexical: number | null;
  readonly semantic: number | null;
  readonly metadata: number | null;
  readonly graph: number | null;
}

export interface CapabilityRetrievalResult {
  readonly nodeId: string;
  readonly documentId: string;
  readonly nodeType: CapabilityNodeType;
  readonly objectId: string;
  readonly objectVersionId: string;
  readonly name: string;
  readonly description: string;
  readonly risk: CapabilityRisk;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly contextBytes: number;
  readonly score: number;
  readonly components: RetrievalScoreComponents;
  readonly explanation: readonly string[];
}

export interface RetrievalResponse {
  readonly runId: string;
  readonly strategyVersion: string;
  readonly indexBackend: 'sqlite-fts5+exact-cosine';
  readonly semanticAvailable: boolean;
  readonly effectiveWeights: RetrievalWeights;
  readonly candidateCount: number;
  readonly durationMs: number;
  readonly results: readonly CapabilityRetrievalResult[];
}

export interface CompositionRequest extends Omit<RetrievalRequest, 'limit'> {
  readonly requiredCapabilities: readonly string[];
  readonly maxNodes?: number;
  readonly maxContextBytes?: number;
  readonly retrievalLimit?: number;
  readonly forbiddenNodeIds?: readonly string[];
}

export interface ComposedCapability {
  readonly nodeId: string;
  readonly documentId: string;
  readonly name: string;
  readonly objectVersionId: string;
  readonly contextBytes: number;
  readonly capabilities: readonly string[];
  readonly selectedAs: 'primary' | 'dependency';
}

export interface CompositionResponse {
  readonly planId: string;
  readonly retrievalRunId: string;
  readonly status: 'complete' | 'incomplete';
  readonly solverMode: 'bounded-exact' | 'bounded-search' | 'infeasible';
  readonly requiredCapabilities: readonly string[];
  readonly selected: readonly ComposedCapability[];
  readonly uncoveredCapabilities: readonly string[];
  readonly contextBytes: number;
  readonly exploredStates: number;
  readonly evidence: readonly string[];
}

export interface CreateSynthesisProposalInput {
  readonly projectId: string;
  readonly composition: CompositionResponse;
  readonly name: string;
  readonly intent: string;
  readonly requiredBehaviors: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedBehaviors?: readonly string[];
}

export interface SynthesisProposal {
  readonly id: string;
  readonly projectId: string;
  readonly compositionPlanId: string;
  readonly name: string;
  readonly intentHash: string;
  readonly requiredBehaviors: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly prohibitedBehaviors: readonly string[];
  readonly status: 'draft' | 'evaluated' | 'approved' | 'rejected' | 'superseded';
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

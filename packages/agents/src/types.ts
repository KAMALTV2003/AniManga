export const AGENT_STATUSES = ['candidate', 'active', 'deprecated', 'archived', 'blocked'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MODEL_CAPABILITIES = [
  'text',
  'structured_output',
  'tool_calling',
  'vision',
  'audio_input',
  'audio_output',
  'reasoning',
  'streaming',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_STATUSES = ['available', 'degraded', 'unavailable', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export interface AgentConstraints {
  readonly maxSteps: number;
  readonly maxRetries: number;
  readonly maxContextBytes: number;
  readonly maxCostMicrounits: number;
  readonly timeoutMs: number;
}

export interface AgentEscalationPolicy {
  readonly onBlocked: 'fail' | 'manual';
  readonly onBudgetExceeded: 'fail' | 'manual';
  readonly onRepeatedFailure: 'fail' | 'manual';
}

export interface AgentModelPolicy {
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly allowedProviders: readonly string[];
  readonly allowedModelIds: readonly string[];
  readonly allowUnmeasured: boolean;
}

export interface AgentContextPolicy {
  readonly maxInputTokens: number;
  readonly includeSkillInstructions: boolean;
  readonly includeMemory: boolean;
}

export interface AgentDefinition {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly constraints: AgentConstraints;
  readonly escalationPolicy: AgentEscalationPolicy;
  readonly evaluationCriteria: readonly string[];
  readonly modelPolicy: AgentModelPolicy;
  readonly contextPolicy: AgentContextPolicy;
}

export interface RegisteredAgentVersion {
  readonly agentId: string;
  readonly versionId: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly currentVersionId: string | null;
  readonly definition: AgentDefinition;
  readonly definitionHash: string;
  readonly created: boolean;
}

export interface AgentLifecycleDecision {
  readonly id: string;
  readonly action: 'activate' | 'deprecate' | 'block';
  readonly projectId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly previousStatus: AgentStatus;
  readonly resultingStatus: AgentStatus;
  readonly previousVersionId: string | null;
  readonly resultingVersionId: string | null;
  readonly createdAt: string;
}

export interface ModelRegistration {
  readonly provider: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly capabilities: readonly ModelCapability[];
  readonly contextWindow: number;
  readonly status?: ModelStatus;
}

export interface RegisteredModel {
  readonly id: string;
  readonly provider: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly capabilities: readonly ModelCapability[];
  readonly contextWindow: number;
  readonly status: ModelStatus;
  readonly created: boolean;
}

export interface ModelMetricInput {
  readonly modelId: string;
  readonly taskType: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrounits: number;
  readonly toolErrorCount?: number;
  readonly evaluationScore?: number | null;
}

export interface ModelMetricAggregate {
  readonly sampleCount: number;
  readonly successRate: number | null;
  readonly p95LatencyMs: number | null;
  readonly averageCostMicrounits: number | null;
  readonly averageEvaluationScore: number | null;
}

export interface ModelRoutePolicy {
  readonly version?: string;
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly allowedProviders?: readonly string[];
  readonly allowedModelIds?: readonly string[];
  readonly minimumContextWindow?: number;
  readonly maximumP95LatencyMs?: number;
  readonly maximumAverageCostMicrounits?: number;
  readonly minimumSuccessRate?: number;
  readonly allowDegraded?: boolean;
  readonly allowUnmeasured?: boolean;
  readonly sampleWindow?: number;
  readonly weights?: {
    readonly quality?: number;
    readonly reliability?: number;
    readonly latency?: number;
    readonly cost?: number;
  };
}

export interface ModelRouteCandidate {
  readonly modelId: string;
  readonly provider: string;
  readonly modelKey: string;
  readonly status: ModelStatus;
  readonly eligible: boolean;
  readonly rejectionReasons: readonly string[];
  readonly metrics: ModelMetricAggregate;
  readonly score: number | null;
  readonly scoreComponents: {
    readonly quality: number | null;
    readonly reliability: number | null;
    readonly latency: number | null;
    readonly cost: number | null;
  };
}

export interface ModelRouteDecision {
  readonly id: string;
  readonly projectId: string;
  readonly taskType: string;
  readonly status: 'selected' | 'no_match';
  readonly selectedModelId: string | null;
  readonly policyVersion: string;
  readonly reasonCode: 'best_eligible_score' | 'no_eligible_model';
  readonly candidates: readonly ModelRouteCandidate[];
  readonly createdAt: string;
}

export type ModelMessageRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

export interface ModelRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly responseFormat?:
    | { readonly type: 'text' }
    | {
        readonly type: 'json_schema';
        readonly name: string;
        readonly schema: Readonly<Record<string, unknown>>;
      };
}

export type ModelStopReason =
  | 'completed'
  | 'max_output_tokens'
  | 'tool_call'
  | 'content_filter'
  | 'cancelled'
  | 'error'
  | 'unknown';

export interface ModelResponse {
  readonly requestId: string;
  readonly providerRequestId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly stopReason: ModelStopReason;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly costMicrounits: number | null;
}

export interface ModelProvider {
  readonly provider: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ModelInvocationResult {
  readonly response: ModelResponse;
  readonly latencyMs: number;
}

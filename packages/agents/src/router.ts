import { createId, redactText, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import {
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelMetricAggregate,
  type ModelRouteCandidate,
  type ModelRouteDecision,
  type ModelRoutePolicy,
  type ModelStatus,
} from './types.js';
import {
  agentError,
  normalizeKeys,
  requireInteger,
  requireKey,
  requireUnit,
  rounded,
  sha256,
} from './validation.js';

interface RouteModelRow {
  readonly id: string;
  readonly provider: string;
  readonly modelKey: string;
  readonly capabilitiesJson: string;
  readonly contextWindow: number;
  readonly status: ModelStatus;
}

interface MetricRow {
  readonly success: number;
  readonly latencyMs: number;
  readonly costMicrounits: number;
  readonly evaluationScore: number | null;
}

interface NormalizedPolicy {
  readonly version: string;
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly allowedProviders: readonly string[];
  readonly allowedModelIds: readonly string[];
  readonly minimumContextWindow: number;
  readonly maximumP95LatencyMs: number | null;
  readonly maximumAverageCostMicrounits: number | null;
  readonly minimumSuccessRate: number;
  readonly allowDegraded: boolean;
  readonly allowUnmeasured: boolean;
  readonly sampleWindow: number;
  readonly weights: {
    readonly quality: number;
    readonly reliability: number;
    readonly latency: number;
    readonly cost: number;
  };
}

export class ModelRouter {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  route(projectId: string, taskType: string, policy: ModelRoutePolicy = {}): ModelRouteDecision {
    const normalizedProjectId = requireKey(projectId, 'projectId', 160);
    const normalizedTaskType = requireKey(taskType, 'taskType');
    if (redactText(normalizedTaskType) !== normalizedTaskType) {
      throw agentError(
        'MODEL_ROUTE_TASK_SENSITIVE',
        'Model route task classification appears to contain credential material',
      );
    }
    const normalizedPolicy = normalizeRoutePolicy(policy);
    this.#assertProject(normalizedProjectId);
    const rows = this.#database.connection
      .prepare(
        `SELECT id, provider, model_key AS modelKey, capabilities_json AS capabilitiesJson,
                context_window AS contextWindow, status
         FROM models ORDER BY provider ASC, model_key ASC LIMIT 501`,
      )
      .all() as RouteModelRow[];
    if (rows.length > 500) {
      throw agentError('MODEL_ROUTE_LIMIT', 'Routing cannot evaluate more than 500 models');
    }
    const candidates = rows.map((row) =>
      this.#candidate(row, normalizedTaskType, normalizedPolicy),
    );
    const eligible = candidates
      .filter((candidate) => candidate.eligible && candidate.score !== null)
      .sort(
        (left, right) =>
          (right.score ?? -1) - (left.score ?? -1) || left.modelId.localeCompare(right.modelId),
      );
    const selected = eligible[0] ?? null;
    const now = new Date().toISOString();
    const decision: ModelRouteDecision = {
      id: createId('model_route'),
      projectId: normalizedProjectId,
      taskType: normalizedTaskType,
      status: selected === null ? 'no_match' : 'selected',
      selectedModelId: selected?.modelId ?? null,
      policyVersion: normalizedPolicy.version,
      reasonCode: selected === null ? 'no_eligible_model' : 'best_eligible_score',
      candidates,
      createdAt: now,
    };
    this.#database.connection
      .prepare(
        `INSERT INTO model_routing_decisions(
           id, project_id, task_type, policy_version, status, selected_model_id,
           constraints_json, candidates_json, reason_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.projectId,
        decision.taskType,
        decision.policyVersion,
        decision.status,
        decision.selectedModelId,
        stableStringify(routePolicyEvidence(normalizedPolicy)),
        stableStringify(decision.candidates),
        decision.reasonCode,
        decision.createdAt,
      );
    return decision;
  }

  #candidate(row: RouteModelRow, taskType: string, policy: NormalizedPolicy): ModelRouteCandidate {
    const capabilities = parseCapabilities(row.capabilitiesJson);
    const metrics = this.#metrics(row.id, taskType, policy.sampleWindow);
    const rejectionReasons: string[] = [];
    if (row.status !== 'available' && !(policy.allowDegraded && row.status === 'degraded')) {
      rejectionReasons.push(`status:${row.status}`);
    }
    for (const required of policy.requiredCapabilities) {
      if (!capabilities.includes(required)) rejectionReasons.push(`missing_capability:${required}`);
    }
    if (policy.allowedProviders.length > 0 && !policy.allowedProviders.includes(row.provider)) {
      rejectionReasons.push('provider_not_allowed');
    }
    if (policy.allowedModelIds.length > 0 && !policy.allowedModelIds.includes(row.id)) {
      rejectionReasons.push('model_not_allowed');
    }
    if (row.contextWindow < policy.minimumContextWindow) {
      rejectionReasons.push('context_window_too_small');
    }
    if (metrics.sampleCount === 0 && !policy.allowUnmeasured) {
      rejectionReasons.push('metrics_required');
    }
    if (
      metrics.averageEvaluationScore === null &&
      !policy.allowUnmeasured &&
      policy.weights.quality > 0
    ) {
      rejectionReasons.push('quality_unmeasured');
    }
    if (metrics.successRate !== null && metrics.successRate < policy.minimumSuccessRate) {
      rejectionReasons.push('success_rate_below_minimum');
    }
    if (metrics.successRate === null && policy.minimumSuccessRate > 0) {
      rejectionReasons.push('success_rate_unmeasured');
    }
    if (policy.maximumP95LatencyMs !== null) {
      if (metrics.p95LatencyMs === null) rejectionReasons.push('latency_unmeasured');
      else if (metrics.p95LatencyMs > policy.maximumP95LatencyMs) {
        rejectionReasons.push('latency_above_maximum');
      }
    }
    if (policy.maximumAverageCostMicrounits !== null) {
      if (metrics.averageCostMicrounits === null) rejectionReasons.push('cost_unmeasured');
      else if (metrics.averageCostMicrounits > policy.maximumAverageCostMicrounits) {
        rejectionReasons.push('cost_above_maximum');
      }
    }
    const eligible = rejectionReasons.length === 0;
    const scoreComponents = {
      quality: metrics.averageEvaluationScore ?? (policy.allowUnmeasured ? 0.5 : null),
      reliability: metrics.successRate ?? (policy.allowUnmeasured ? 0.5 : null),
      latency:
        metrics.p95LatencyMs === null
          ? policy.allowUnmeasured
            ? 0.5
            : null
          : 1 / (1 + metrics.p95LatencyMs / 1_000),
      cost:
        metrics.averageCostMicrounits === null
          ? policy.allowUnmeasured
            ? 0.5
            : null
          : 1 / (1 + metrics.averageCostMicrounits / 1_000_000),
    };
    const weightedComponentsMeasured =
      (policy.weights.quality === 0 || scoreComponents.quality !== null) &&
      (policy.weights.reliability === 0 || scoreComponents.reliability !== null) &&
      (policy.weights.latency === 0 || scoreComponents.latency !== null) &&
      (policy.weights.cost === 0 || scoreComponents.cost !== null);
    const score =
      eligible && weightedComponentsMeasured
        ? rounded(
            (scoreComponents.quality ?? 0) * policy.weights.quality +
              (scoreComponents.reliability ?? 0) * policy.weights.reliability +
              (scoreComponents.latency ?? 0) * policy.weights.latency +
              (scoreComponents.cost ?? 0) * policy.weights.cost,
          )
        : null;
    return {
      modelId: row.id,
      provider: row.provider,
      modelKey: row.modelKey,
      status: row.status,
      eligible,
      rejectionReasons,
      metrics,
      score,
      scoreComponents: {
        quality: scoreComponents.quality === null ? null : rounded(scoreComponents.quality),
        reliability:
          scoreComponents.reliability === null ? null : rounded(scoreComponents.reliability),
        latency: scoreComponents.latency === null ? null : rounded(scoreComponents.latency),
        cost: scoreComponents.cost === null ? null : rounded(scoreComponents.cost),
      },
    };
  }

  #metrics(modelId: string, taskType: string, sampleWindow: number): ModelMetricAggregate {
    const rows = this.#database.connection
      .prepare(
        `SELECT success, latency_ms AS latencyMs, cost_microunits AS costMicrounits,
                evaluation_score AS evaluationScore
         FROM model_metric_samples
         WHERE model_id = ? AND task_type = ?
         ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      )
      .all(modelId, taskType, sampleWindow) as MetricRow[];
    if (rows.length === 0) {
      return {
        sampleCount: 0,
        successRate: null,
        p95LatencyMs: null,
        averageCostMicrounits: null,
        averageEvaluationScore: null,
      };
    }
    const latencies = rows.map((row) => row.latencyMs).sort((left, right) => left - right);
    const evaluated = rows
      .map((row) => row.evaluationScore)
      .filter((value): value is number => value !== null);
    return {
      sampleCount: rows.length,
      successRate: rounded(rows.filter((row) => row.success === 1).length / rows.length),
      p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0,
      averageCostMicrounits: rounded(
        rows.reduce((sum, row) => sum + row.costMicrounits, 0) / rows.length,
      ),
      averageEvaluationScore:
        evaluated.length === 0
          ? null
          : rounded(evaluated.reduce((sum, value) => sum + value, 0) / evaluated.length),
    };
  }

  #assertProject(projectId: string): void {
    const row = this.#database.connection
      .prepare('SELECT 1 AS present FROM projects WHERE id = ?')
      .get(projectId) as { readonly present: number } | undefined;
    if (row === undefined)
      throw agentError('MODEL_ROUTE_PROJECT_NOT_FOUND', 'Project was not found');
  }
}

export function normalizeRoutePolicy(policy: ModelRoutePolicy): NormalizedPolicy {
  const requiredCapabilities = normalizeKeys(
    policy.requiredCapabilities ?? ['text'],
    'requiredCapabilities',
    MODEL_CAPABILITIES.length,
  );
  if (
    requiredCapabilities.some(
      (capability) => !MODEL_CAPABILITIES.includes(capability as ModelCapability),
    )
  ) {
    throw new RangeError('Routing policy contains an unsupported capability');
  }
  const rawWeights = {
    quality: requireUnit(policy.weights?.quality ?? 0.4, 'quality weight'),
    reliability: requireUnit(policy.weights?.reliability ?? 0.3, 'reliability weight'),
    latency: requireUnit(policy.weights?.latency ?? 0.15, 'latency weight'),
    cost: requireUnit(policy.weights?.cost ?? 0.15, 'cost weight'),
  };
  const weightTotal = Object.values(rawWeights).reduce((sum, value) => sum + value, 0);
  if (weightTotal === 0) throw new RangeError('At least one routing weight must be positive');
  const configuration = {
    requiredCapabilities: requiredCapabilities as readonly ModelCapability[],
    allowedProviders: normalizeKeys(policy.allowedProviders ?? [], 'allowedProviders', 32),
    allowedModelIds: normalizeKeys(policy.allowedModelIds ?? [], 'allowedModelIds', 128),
    minimumContextWindow: requireInteger(
      policy.minimumContextWindow ?? 1,
      'minimumContextWindow',
      1,
      10_000_000,
    ),
    maximumP95LatencyMs:
      policy.maximumP95LatencyMs === undefined
        ? null
        : requireInteger(policy.maximumP95LatencyMs, 'maximumP95LatencyMs', 1, 86_400_000),
    maximumAverageCostMicrounits:
      policy.maximumAverageCostMicrounits === undefined
        ? null
        : requireInteger(
            policy.maximumAverageCostMicrounits,
            'maximumAverageCostMicrounits',
            0,
            1_000_000_000_000_000,
          ),
    minimumSuccessRate: requireUnit(policy.minimumSuccessRate ?? 0, 'minimumSuccessRate'),
    allowDegraded: policy.allowDegraded ?? false,
    allowUnmeasured: policy.allowUnmeasured ?? false,
    sampleWindow: requireInteger(policy.sampleWindow ?? 100, 'sampleWindow', 1, 1_000),
    weights: {
      quality: rawWeights.quality / weightTotal,
      reliability: rawWeights.reliability / weightTotal,
      latency: rawWeights.latency / weightTotal,
      cost: rawWeights.cost / weightTotal,
    },
  };
  if (
    typeof configuration.allowDegraded !== 'boolean' ||
    typeof configuration.allowUnmeasured !== 'boolean'
  ) {
    throw new TypeError('Routing policy flags must be boolean');
  }
  const declaredVersion = requireKey(policy.version ?? 'nexus.model-route-v1', 'policy version');
  return {
    version: `${declaredVersion}:${sha256(stableStringify(configuration)).slice(0, 16)}`,
    ...configuration,
  };
}

function routePolicyEvidence(policy: NormalizedPolicy): Readonly<Record<string, unknown>> {
  return {
    requiredCapabilities: policy.requiredCapabilities,
    allowedProviders: policy.allowedProviders,
    allowedModelIds: policy.allowedModelIds,
    minimumContextWindow: policy.minimumContextWindow,
    maximumP95LatencyMs: policy.maximumP95LatencyMs,
    maximumAverageCostMicrounits: policy.maximumAverageCostMicrounits,
    minimumSuccessRate: policy.minimumSuccessRate,
    allowDegraded: policy.allowDegraded,
    allowUnmeasured: policy.allowUnmeasured,
    sampleWindow: policy.sampleWindow,
    weights: policy.weights,
  };
}

function parseCapabilities(value: string): readonly ModelCapability[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) => typeof item !== 'string' || !MODEL_CAPABILITIES.includes(item as ModelCapability),
      )
    ) {
      throw new Error('invalid capabilities');
    }
    return parsed as readonly ModelCapability[];
  } catch (error) {
    throw agentError(
      'MODEL_REGISTRY_CORRUPT',
      'Stored model capabilities are invalid',
      undefined,
      error,
    );
  }
}

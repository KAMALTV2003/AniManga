import { createId, deterministicId, redactText, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import {
  MODEL_CAPABILITIES,
  MODEL_STATUSES,
  type ModelCapability,
  type ModelMetricInput,
  type ModelRegistration,
  type ModelStatus,
  type RegisteredModel,
} from './types.js';
import {
  agentError,
  normalizeKeys,
  requireInteger,
  requireKey,
  requireText,
  requireUnit,
} from './validation.js';

interface ModelRow {
  readonly id: string;
  readonly provider: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly capabilitiesJson: string;
  readonly contextWindow: number;
  readonly status: ModelStatus;
}

export class ModelRegistry {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  register(input: ModelRegistration): RegisteredModel {
    const normalized = normalizeModelRegistration(input);
    const id = deterministicId('model', `${normalized.provider}:${normalized.modelKey}`);
    const now = new Date().toISOString();
    const database = this.#database.connection;
    const existing = this.#find(normalized.provider, normalized.modelKey);
    if (existing !== undefined) {
      const mapped = mapModel(existing, false);
      if (
        mapped.displayName !== normalized.displayName ||
        mapped.contextWindow !== normalized.contextWindow ||
        stableStringify(mapped.capabilities) !== stableStringify(normalized.capabilities)
      ) {
        throw agentError(
          'MODEL_REGISTRATION_CONFLICT',
          'Provider model identity already exists with different metadata',
          { modelId: existing.id },
        );
      }
      return mapped;
    }
    database
      .prepare(
        `INSERT INTO models(
           id, provider, model_key, display_name, capabilities_json,
           context_window, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        normalized.provider,
        normalized.modelKey,
        normalized.displayName,
        stableStringify(normalized.capabilities),
        normalized.contextWindow,
        normalized.status,
        now,
        now,
      );
    const created = this.#byId(id);
    if (created === undefined) throw new Error('Model insert did not persist');
    return mapModel(created, true);
  }

  setStatus(modelId: string, status: ModelStatus): RegisteredModel {
    const normalizedId = requireKey(modelId, 'modelId', 256);
    if (!MODEL_STATUSES.includes(status)) throw new RangeError('Unsupported model status');
    const result = this.#database.connection
      .prepare('UPDATE models SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), normalizedId);
    if (result.changes !== 1) throw agentError('MODEL_NOT_FOUND', 'Model was not found');
    const row = this.#byId(normalizedId);
    if (row === undefined) throw new Error('Model status update did not persist');
    return mapModel(row, false);
  }

  recordMetric(input: ModelMetricInput): string {
    const modelId = requireKey(input.modelId, 'modelId', 256);
    if (this.#byId(modelId) === undefined)
      throw agentError('MODEL_NOT_FOUND', 'Model was not found');
    const taskType = requireKey(input.taskType, 'taskType');
    if (redactText(taskType) !== taskType) {
      throw agentError(
        'MODEL_METRIC_TASK_SENSITIVE',
        'Model metric task classification appears to contain credential material',
      );
    }
    if (typeof input.success !== 'boolean') throw new TypeError('success must be boolean');
    const evaluationScore =
      input.evaluationScore === undefined || input.evaluationScore === null
        ? null
        : requireUnit(input.evaluationScore, 'evaluationScore');
    const id = createId('model_metric');
    this.#database.connection
      .prepare(
        `INSERT INTO model_metric_samples(
           id, model_id, task_type, success, latency_ms, input_tokens,
           output_tokens, cost_microunits, tool_error_count,
           evaluation_score, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        modelId,
        taskType,
        input.success ? 1 : 0,
        requireInteger(input.latencyMs, 'latencyMs', 0, 86_400_000),
        requireInteger(input.inputTokens, 'inputTokens', 0, 100_000_000),
        requireInteger(input.outputTokens, 'outputTokens', 0, 100_000_000),
        requireInteger(input.costMicrounits, 'costMicrounits', 0, 1_000_000_000_000_000),
        requireInteger(input.toolErrorCount ?? 0, 'toolErrorCount', 0, 1_000_000),
        evaluationScore,
        new Date().toISOString(),
      );
    return id;
  }

  get(modelId: string): RegisteredModel {
    const normalizedId = requireKey(modelId, 'modelId', 256);
    const row = this.#byId(normalizedId);
    if (row === undefined) throw agentError('MODEL_NOT_FOUND', 'Model was not found');
    return mapModel(row, false);
  }

  list(limit = 1_000): readonly RegisteredModel[] {
    const normalizedLimit = requireInteger(limit, 'limit', 1, 10_000);
    const rows = this.#database.connection
      .prepare(
        `SELECT id, provider, model_key AS modelKey, display_name AS displayName,
                capabilities_json AS capabilitiesJson, context_window AS contextWindow, status
         FROM models ORDER BY provider ASC, model_key ASC LIMIT ?`,
      )
      .all(normalizedLimit) as ModelRow[];
    return rows.map((row) => mapModel(row, false));
  }

  #find(provider: string, modelKey: string): ModelRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT id, provider, model_key AS modelKey, display_name AS displayName,
                capabilities_json AS capabilitiesJson, context_window AS contextWindow, status
         FROM models WHERE provider = ? AND model_key = ?`,
      )
      .get(provider, modelKey) as ModelRow | undefined;
  }

  #byId(id: string): ModelRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT id, provider, model_key AS modelKey, display_name AS displayName,
                capabilities_json AS capabilitiesJson, context_window AS contextWindow, status
         FROM models WHERE id = ?`,
      )
      .get(id) as ModelRow | undefined;
  }
}

export function normalizeModelRegistration(input: ModelRegistration): Required<ModelRegistration> {
  const capabilities = normalizeKeys(
    input.capabilities,
    'model capabilities',
    MODEL_CAPABILITIES.length,
  );
  if (capabilities.length === 0) throw new RangeError('Model must declare at least one capability');
  if (
    capabilities.some((capability) => !MODEL_CAPABILITIES.includes(capability as ModelCapability))
  ) {
    throw new RangeError('Model contains an unsupported capability');
  }
  const status = input.status ?? 'disabled';
  if (!MODEL_STATUSES.includes(status)) throw new RangeError('Unsupported model status');
  const normalized = {
    provider: requireKey(input.provider, 'provider', 128).toLocaleLowerCase('en-US'),
    modelKey: requireKey(input.modelKey, 'modelKey', 192),
    displayName: requireText(input.displayName, 'displayName', 256),
    capabilities: capabilities as readonly ModelCapability[],
    contextWindow: requireInteger(input.contextWindow, 'contextWindow', 1, 10_000_000),
    status,
  };
  const canonical = stableStringify(normalized);
  if (redactText(canonical) !== canonical) {
    throw agentError(
      'MODEL_METADATA_SENSITIVE',
      'Model metadata appears to contain sensitive credential material',
    );
  }
  return normalized;
}

function mapModel(row: ModelRow, created: boolean): RegisteredModel {
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(row.capabilitiesJson) as unknown;
  } catch (error) {
    throw agentError(
      'MODEL_REGISTRY_CORRUPT',
      'Stored model capabilities are invalid',
      undefined,
      error,
    );
  }
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (capability) =>
        typeof capability !== 'string' ||
        !MODEL_CAPABILITIES.includes(capability as ModelCapability),
    ) ||
    !MODEL_STATUSES.includes(row.status)
  ) {
    throw agentError('MODEL_REGISTRY_CORRUPT', 'Stored model metadata is invalid');
  }
  return {
    id: row.id,
    provider: row.provider,
    modelKey: row.modelKey,
    displayName: row.displayName,
    capabilities: capabilities as readonly ModelCapability[],
    contextWindow: row.contextWindow,
    status: row.status,
    created,
  };
}

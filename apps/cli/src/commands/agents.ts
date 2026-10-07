import {
  AgentRegistry,
  ModelRegistry,
  ModelRouter,
  parseAgentDefinition,
  type ModelCapability,
  type ModelRoutePolicy,
  type ModelStatus,
} from '@nexus-ai/agents';
import { loadNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase } from '@nexus-ai/database';

import { readBoundedJsonFile } from './files.js';

export async function registerAgent(startDir: string, definitionPath: string) {
  const parsed = await readBoundedJsonFile(startDir, definitionPath, 'Agent definition');
  const definition = parseAgentDefinition(parsed);
  return withDatabase(startDir, (database, projectId) => {
    if (definition.projectId !== projectId) {
      throw new RangeError('Agent definition projectId does not match the initialized project');
    }
    return new AgentRegistry(database).register(definition);
  });
}

export async function listAgents(startDir: string) {
  return withDatabase(startDir, (database, projectId) =>
    new AgentRegistry(database).list(projectId),
  );
}

export async function activateAgent(
  startDir: string,
  agentId: string,
  version: string,
  input: {
    readonly actor: string;
    readonly reason: string;
    readonly acknowledgeLocalOperator: boolean;
  },
) {
  return withDatabase(startDir, (database, projectId) =>
    new AgentRegistry(database).activate({
      projectId,
      agentId,
      version,
      actor: input.actor,
      reason: input.reason,
      acknowledgeLocalOperator: input.acknowledgeLocalOperator,
    }),
  );
}

export async function registerModel(
  startDir: string,
  input: {
    readonly provider: string;
    readonly modelKey: string;
    readonly displayName: string;
    readonly capabilities: readonly ModelCapability[];
    readonly contextWindow: number;
    readonly status: ModelStatus;
  },
) {
  return withDatabase(startDir, (database) => new ModelRegistry(database).register(input));
}

export async function listModels(startDir: string) {
  return withDatabase(startDir, (database) => new ModelRegistry(database).list());
}

export async function setModelStatus(startDir: string, modelId: string, status: ModelStatus) {
  return withDatabase(startDir, (database) =>
    new ModelRegistry(database).setStatus(modelId, status),
  );
}

export async function recordModelMetric(
  startDir: string,
  input: {
    readonly modelId: string;
    readonly taskType: string;
    readonly success: boolean;
    readonly latencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicrounits: number;
    readonly evaluationScore?: number;
  },
) {
  return withDatabase(startDir, (database) => ({
    id: new ModelRegistry(database).recordMetric(input),
    modelId: input.modelId,
    taskType: input.taskType,
  }));
}

export async function routeModel(startDir: string, taskType: string, policy: ModelRoutePolicy) {
  return withDatabase(startDir, (database, projectId) =>
    new ModelRouter(database).route(projectId, taskType, policy),
  );
}

async function withDatabase<T>(
  startDir: string,
  action: (database: SqliteDatabase, projectId: string) => T | Promise<T>,
): Promise<T> {
  const loaded = loadNexusConfig({ startDir });
  const database = new SqliteDatabase({
    path: loaded.config.database.path,
    busyTimeoutMs: loaded.config.database.busyTimeoutMs,
    migrationMode: 'validate',
  });
  try {
    await database.start();
    return await action(database, loaded.config.project.id);
  } finally {
    await database.stop();
  }
}

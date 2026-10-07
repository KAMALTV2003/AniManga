import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  CapabilityComposer,
  CapabilityGraph,
  CapabilityRetriever,
  RetrievalEvaluator,
  SkillPromotionService,
  parseRetrievalEvaluationSuite,
  SynthesisProposalRegistry,
  type CompositionResponse,
  type RequiredEvaluationSuite,
  type RetrievalEvaluationSuite,
} from '@nexus-ai/capabilities';
import { loadNexusConfig } from '@nexus-ai/config';
import { SqliteDatabase } from '@nexus-ai/database';

export async function syncCapabilities(startDir: string) {
  return withDatabase(startDir, (database, projectId) =>
    new CapabilityGraph(database).syncActiveSkills(projectId),
  );
}

export async function searchCapabilities(
  startDir: string,
  query: string,
  options: { readonly limit: number; readonly tags?: readonly string[] },
) {
  return withDatabase(startDir, async (database, projectId) => {
    const graph = new CapabilityGraph(database);
    graph.syncActiveSkills(projectId);
    return new CapabilityRetriever(database).retrieve({
      projectId,
      query,
      limit: options.limit,
      ...(options.tags === undefined ? {} : { preferredTags: options.tags }),
    });
  });
}

export async function composeCapabilities(
  startDir: string,
  query: string,
  options: {
    readonly requirements: readonly string[];
    readonly maxNodes: number;
    readonly maxContextBytes: number;
  },
): Promise<CompositionResponse> {
  return withDatabase(startDir, async (database, projectId) => {
    new CapabilityGraph(database).syncActiveSkills(projectId);
    return new CapabilityComposer(database).compose({
      projectId,
      query,
      requiredCapabilities: options.requirements,
      maxNodes: options.maxNodes,
      maxContextBytes: options.maxContextBytes,
      nodeTypes: ['skill'],
    });
  });
}

export async function proposeCapability(
  startDir: string,
  query: string,
  options: {
    readonly name: string;
    readonly requirements: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly prohibitedBehaviors?: readonly string[];
  },
) {
  return withDatabase(startDir, async (database, projectId) => {
    new CapabilityGraph(database).syncActiveSkills(projectId);
    const composition = await new CapabilityComposer(database).compose({
      projectId,
      query,
      requiredCapabilities: options.requirements,
      nodeTypes: ['skill'],
    });
    const proposal = new SynthesisProposalRegistry(database).create({
      projectId,
      composition,
      name: options.name,
      intent: query,
      requiredBehaviors: composition.uncoveredCapabilities,
      acceptanceCriteria: options.acceptanceCriteria,
      ...(options.prohibitedBehaviors === undefined
        ? {}
        : { prohibitedBehaviors: options.prohibitedBehaviors }),
    });
    return { composition, proposal, generatedExecutableContent: false as const };
  });
}

export async function evaluateRetrieval(startDir: string, suitePath: string) {
  const absolute = path.resolve(startDir, suitePath);
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const maximumBytes = 1_000_000;
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new RangeError(
        'Evaluation suite must be a real JSON file no larger than 1000000 bytes',
      );
    }
    const bounded = Buffer.allocUnsafe(maximumBytes + 1);
    const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
    const after = await handle.stat();
    if (bytesRead > maximumBytes) {
      throw new RangeError('Evaluation suite exceeded the 1000000-byte read limit');
    }
    if (before.size !== after.size || bytesRead !== before.size) {
      throw new Error('Evaluation suite changed while being read');
    }
    bytes = bounded.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new SyntaxError(`Evaluation suite is not valid JSON: ${String(error)}`, { cause: error });
  }
  const suite: RetrievalEvaluationSuite = parseRetrievalEvaluationSuite(parsed);
  return withDatabase(startDir, async (database, projectId) => {
    new CapabilityGraph(database).syncActiveSkills(projectId);
    return new RetrievalEvaluator(database).evaluate(projectId, suite);
  });
}

export async function checkSkillPromotion(
  startDir: string,
  skillId: string,
  version: string,
  requiredSuites: readonly RequiredEvaluationSuite[],
) {
  return withDatabase(startDir, (database, projectId) =>
    new SkillPromotionService(database).assess(projectId, skillId, version, {
      requiredSuites,
    }),
  );
}

export async function promoteSkillVersion(
  startDir: string,
  skillId: string,
  version: string,
  input: {
    readonly actor: string;
    readonly reason: string;
    readonly requiredSuites: readonly RequiredEvaluationSuite[];
    readonly acknowledgeLocalOperator: boolean;
  },
) {
  return withDatabase(startDir, (database, projectId) =>
    new SkillPromotionService(database).promote({
      projectId,
      skillId,
      version,
      actor: input.actor,
      reason: input.reason,
      acknowledgeLocalOperator: input.acknowledgeLocalOperator,
      policy: { requiredSuites: input.requiredSuites },
    }),
  );
}

export async function rollbackSkillPromotion(
  startDir: string,
  promotionDecisionId: string,
  input: {
    readonly actor: string;
    readonly reason: string;
    readonly acknowledgeLocalOperator: boolean;
  },
) {
  return withDatabase(startDir, (database, projectId) =>
    new SkillPromotionService(database).rollback({
      projectId,
      promotionDecisionId,
      actor: input.actor,
      reason: input.reason,
      acknowledgeLocalOperator: input.acknowledgeLocalOperator,
    }),
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

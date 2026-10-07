import {
  AgentRegistry,
  ModelGateway,
  ModelRegistry,
  ModelRouter,
  parseAgentDefinition,
  runModelProviderConformance,
  type AgentDefinition,
  type ModelProvider,
} from '@nexus-ai/agents';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';
import { describe, expect, it } from 'vitest';

const PROJECT_ID = 'prj_agent_runtime';

async function databaseFixture(): Promise<SqliteDatabase> {
  const database = new SqliteDatabase({ path: ':memory:' });
  await database.start();
  new ProjectRepository(database).upsert({
    id: PROJECT_ID,
    name: 'Agent Runtime',
    rootPath: '/tmp/agent-runtime',
  });
  return database;
}

function agentDefinition(version = '1.0.0'): AgentDefinition {
  return {
    projectId: PROJECT_ID,
    name: 'release-coordinator',
    description: `Coordinate a bounded release workflow at version ${version}.`,
    version,
    role: 'Select reviewed release capabilities and escalate blocked work.',
    capabilities: ['release-coordination', 'evidence-summary'],
    tools: [],
    constraints: {
      maxSteps: 12,
      maxRetries: 2,
      maxContextBytes: 200_000,
      maxCostMicrounits: 5_000_000,
      timeoutMs: 60_000,
    },
    escalationPolicy: {
      onBlocked: 'manual',
      onBudgetExceeded: 'fail',
      onRepeatedFailure: 'manual',
    },
    evaluationCriteria: ['All required release evidence is cited.', 'Blocked work is escalated.'],
    modelPolicy: {
      requiredCapabilities: ['text', 'structured_output'],
      allowedProviders: [],
      allowedModelIds: [],
      allowUnmeasured: false,
    },
    contextPolicy: {
      maxInputTokens: 20_000,
      includeSkillInstructions: false,
      includeMemory: false,
    },
  };
}

class DeterministicConformanceProvider implements ModelProvider {
  readonly provider = 'fixture-provider';

  async invoke(request: Parameters<ModelProvider['invoke']>[0]) {
    return {
      requestId: request.requestId,
      providerRequestId: 'provider-request-1',
      provider: this.provider,
      model: request.model,
      text: 'Bounded multilingual input received.',
      stopReason: 'completed' as const,
      usage: { inputTokens: 18, outputTokens: 6 },
      costMicrounits: 42,
    };
  }
}

describe('AgentRegistry', () => {
  it('persists immutable candidate versions and records explicit local activation', async () => {
    const database = await databaseFixture();
    try {
      const registry = new AgentRegistry(database);
      expect(() => parseAgentDefinition({ ...agentDefinition(), unexpectedPolicy: true })).toThrow(
        /unknown keys: unexpectedPolicy/u,
      );
      expect(() =>
        parseAgentDefinition({ ...agentDefinition(), role: 'Use Bearer credential-material' }),
      ).toThrowError(expect.objectContaining({ code: 'AGENT_DEFINITION_SENSITIVE' }));
      const first = registry.register(agentDefinition());
      expect(first).toMatchObject({ created: true, status: 'candidate', currentVersionId: null });
      expect(registry.register(agentDefinition())).toMatchObject({
        created: false,
        versionId: first.versionId,
      });
      expect(() =>
        registry.register({ ...agentDefinition(), role: 'Conflicting immutable role.' }),
      ).toThrowError(expect.objectContaining({ code: 'AGENT_VERSION_CONFLICT' }));
      expect(() =>
        registry.activate({
          projectId: PROJECT_ID,
          agentId: first.agentId,
          version: '1.0.0',
          actor: 'local-operator',
          reason: 'Activation without acknowledgement must fail.',
          acknowledgeLocalOperator: false,
        }),
      ).toThrowError(expect.objectContaining({ code: 'LOCAL_OPERATOR_ACKNOWLEDGEMENT_REQUIRED' }));
      expect(() =>
        registry.activate({
          projectId: PROJECT_ID,
          agentId: first.agentId,
          version: '1.0.0',
          actor: 'local-operator',
          reason: 'token=must-not-be-persisted',
          acknowledgeLocalOperator: true,
        }),
      ).toThrowError(expect.objectContaining({ code: 'AGENT_AUDIT_TEXT_SENSITIVE' }));

      const activated = registry.activate({
        projectId: PROJECT_ID,
        agentId: first.agentId,
        version: '1.0.0',
        actor: 'local-operator',
        reason: 'Canonical definition reviewed for local routing tests.',
        acknowledgeLocalOperator: true,
      });
      expect(activated).toMatchObject({
        action: 'activate',
        previousStatus: 'candidate',
        resultingStatus: 'active',
        resultingVersionId: first.versionId,
      });
      expect(registry.getActive(PROJECT_ID, first.agentId)).toMatchObject({
        status: 'active',
        versionId: first.versionId,
      });
      expect(() =>
        database.connection
          .prepare('UPDATE agent_versions SET role = ? WHERE id = ?')
          .run('tampered', first.versionId),
      ).toThrow(/immutable/u);
      expect(() =>
        database.connection
          .prepare('DELETE FROM agent_lifecycle_decisions WHERE id = ?')
          .run(activated.id),
      ).toThrow(/append-only/u);
    } finally {
      await database.stop();
    }
  });

  it('rejects stored definitions that diverge from their integrity evidence', async () => {
    const database = await databaseFixture();
    try {
      const registry = new AgentRegistry(database);
      const registered = registry.register(agentDefinition());
      database.connection.exec('DROP TRIGGER agent_version_integrity_reject_update');
      database.connection
        .prepare(
          'UPDATE agent_version_integrity SET definition_sha256 = ? WHERE agent_version_id = ?',
        )
        .run('0'.repeat(64), registered.versionId);
      expect(() => registry.list(PROJECT_ID)).toThrowError(
        expect.objectContaining({ code: 'AGENT_REGISTRY_CORRUPT' }),
      );
    } finally {
      await database.stop();
    }
  });

  it('activates an exact newer version without mutating the previous version', async () => {
    const database = await databaseFixture();
    try {
      const registry = new AgentRegistry(database);
      const first = registry.register(agentDefinition());
      registry.activate({
        projectId: PROJECT_ID,
        agentId: first.agentId,
        version: '1.0.0',
        actor: 'local-operator',
        reason: 'Activate initial reviewed definition.',
        acknowledgeLocalOperator: true,
      });
      const second = registry.register(agentDefinition('1.1.0'));
      expect(second.versionId).not.toBe(first.versionId);
      const decision = registry.activate({
        projectId: PROJECT_ID,
        agentId: first.agentId,
        version: '1.1.0',
        actor: 'local-operator',
        reason: 'Activate the independently reviewed second definition.',
        acknowledgeLocalOperator: true,
      });
      expect(decision).toMatchObject({
        previousVersionId: first.versionId,
        resultingVersionId: second.versionId,
      });
      expect(registry.getActive(PROJECT_ID, first.agentId).definition.version).toBe('1.1.0');
    } finally {
      await database.stop();
    }
  });
});

describe('ModelRegistry and ModelRouter', () => {
  it('routes over append-only measured evidence with deterministic explanations', async () => {
    const database = await databaseFixture();
    try {
      const models = new ModelRegistry(database);
      const fast = models.register({
        provider: 'provider-a',
        modelKey: 'fast-v1',
        displayName: 'Fast V1',
        capabilities: ['text', 'structured_output'],
        contextWindow: 128_000,
        status: 'available',
      });
      const costly = models.register({
        provider: 'provider-b',
        modelKey: 'costly-v1',
        displayName: 'Costly V1',
        capabilities: ['text', 'structured_output'],
        contextWindow: 200_000,
        status: 'available',
      });
      for (let index = 0; index < 3; index += 1) {
        models.recordMetric({
          modelId: fast.id,
          taskType: 'release',
          success: true,
          latencyMs: 100 + index,
          inputTokens: 100,
          outputTokens: 20,
          costMicrounits: 500_000,
          evaluationScore: 0.9,
        });
        models.recordMetric({
          modelId: costly.id,
          taskType: 'release',
          success: true,
          latencyMs: 500 + index,
          inputTokens: 100,
          outputTokens: 20,
          costMicrounits: 2_000_000,
          evaluationScore: 0.95,
        });
      }
      const decision = new ModelRouter(database).route(PROJECT_ID, 'release', {
        requiredCapabilities: ['text', 'structured_output'],
        minimumSuccessRate: 0.9,
      });
      expect(decision).toMatchObject({
        status: 'selected',
        selectedModelId: fast.id,
        reasonCode: 'best_eligible_score',
      });
      expect(decision.policyVersion).toMatch(/^nexus\.model-route-v1:[a-f0-9]{16}$/u);
      expect(decision.candidates).toHaveLength(2);
      expect(decision.candidates.every((candidate) => candidate.metrics.sampleCount === 3)).toBe(
        true,
      );
      const noMatch = new ModelRouter(database).route(PROJECT_ID, 'release', {
        requiredCapabilities: ['vision'],
      });
      expect(noMatch).toMatchObject({ status: 'no_match', selectedModelId: null });
      expect(noMatch.candidates.every((candidate) => !candidate.eligible)).toBe(true);
      expect(() =>
        database.connection
          .prepare('UPDATE model_routing_decisions SET reason_code = ? WHERE id = ?')
          .run('tampered', decision.id),
      ).toThrow(/append-only/u);
      expect(() =>
        database.connection
          .prepare('DELETE FROM model_metric_samples WHERE model_id = ?')
          .run(fast.id),
      ).toThrow(/append-only/u);
    } finally {
      await database.stop();
    }
  });

  it('does not require an unweighted quality signal', async () => {
    const database = await databaseFixture();
    try {
      const models = new ModelRegistry(database);
      const model = models.register({
        provider: 'provider-a',
        modelKey: 'outcome-only-v1',
        displayName: 'Outcome Only V1',
        capabilities: ['text'],
        contextWindow: 32_000,
        status: 'available',
      });
      models.recordMetric({
        modelId: model.id,
        taskType: 'classification',
        success: true,
        latencyMs: 40,
        inputTokens: 20,
        outputTokens: 2,
        costMicrounits: 10,
      });
      expect(
        new ModelRouter(database).route(PROJECT_ID, 'classification', {
          weights: { quality: 0, reliability: 0.6, latency: 0.2, cost: 0.2 },
        }),
      ).toMatchObject({ status: 'selected', selectedModelId: model.id });
    } finally {
      await database.stop();
    }
  });

  it('fails closed for unmeasured models unless policy explicitly permits them', async () => {
    const database = await databaseFixture();
    try {
      const model = new ModelRegistry(database).register({
        provider: 'provider-a',
        modelKey: 'cold-v1',
        displayName: 'Cold V1',
        capabilities: ['text'],
        contextWindow: 32_000,
        status: 'available',
      });
      const router = new ModelRouter(database);
      expect(router.route(PROJECT_ID, 'unknown-task')).toMatchObject({ status: 'no_match' });
      expect(router.route(PROJECT_ID, 'unknown-task', { allowUnmeasured: true })).toMatchObject({
        status: 'selected',
        selectedModelId: model.id,
      });
    } finally {
      await database.stop();
    }
  });
});

describe('ModelGateway', () => {
  it('normalizes provider responses and runs bounded conformance probes', async () => {
    const provider = new DeterministicConformanceProvider();
    const result = await new ModelGateway().invoke(provider, {
      requestId: 'request-1',
      model: 'fixture-v1',
      messages: [{ role: 'user', content: 'Confirm a bounded request.' }],
      maxOutputTokens: 32,
    });
    expect(result.response).toMatchObject({
      provider: 'fixture-provider',
      model: 'fixture-v1',
      stopReason: 'completed',
      usage: { inputTokens: 18, outputTokens: 6 },
    });
    const conformance = await runModelProviderConformance(provider, { model: 'fixture-v1' });
    expect(conformance.passed).toBe(true);
    expect(conformance.probeHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects mismatched responses and enforces a caller timeout', async () => {
    const mismatch: ModelProvider = {
      provider: 'fixture-provider',
      invoke: async (request) => ({
        requestId: request.requestId,
        providerRequestId: null,
        provider: 'different-provider',
        model: request.model,
        text: 'Wrong identity.',
        stopReason: 'completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        costMicrounits: null,
      }),
    };
    await expect(
      new ModelGateway().invoke(mismatch, {
        requestId: 'request-mismatch',
        model: 'fixture-v1',
        messages: [{ role: 'user', content: 'test' }],
        maxOutputTokens: 8,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_MISMATCH' });

    const slow: ModelProvider = {
      provider: 'slow-provider',
      invoke: (_request, signal): Promise<ModelResponse> =>
        new Promise<ModelResponse>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('provider observed abort', { cause: signal.reason })),
            { once: true },
          );
        }),
    };
    await expect(
      new ModelGateway().invoke(
        slow,
        {
          requestId: 'request-timeout',
          model: 'fixture-v1',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 8,
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_INVOCATION_TIMEOUT' });

    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(
      new ModelGateway().invoke(
        slow,
        {
          requestId: 'request-cancelled',
          model: 'fixture-v1',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 8,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CANCELLED' });
  });
});

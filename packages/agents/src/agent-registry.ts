import { createId, deterministicId, redactText, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import {
  AGENT_STATUSES,
  MODEL_CAPABILITIES,
  type AgentDefinition,
  type AgentLifecycleDecision,
  type AgentStatus,
  type RegisteredAgentVersion,
} from './types.js';
import {
  agentError,
  normalizeKeys,
  normalizeTexts,
  requireAuditText,
  requireInteger,
  requireKey,
  requireSemver,
  requireText,
  sha256,
} from './validation.js';

interface AgentRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly status: AgentStatus;
  readonly currentVersionId: string | null;
}

interface AgentVersionRow {
  readonly id: string;
  readonly version: string;
  readonly role: string;
  readonly capabilitiesJson: string;
  readonly toolsJson: string;
  readonly constraintsJson: string;
  readonly escalationPolicyJson: string;
  readonly evaluationCriteriaJson: string;
  readonly modelPolicyJson: string;
  readonly contextPolicyJson: string;
  readonly definitionHash: string;
  readonly definitionJson: string;
}

export class AgentRegistry {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  register(input: AgentDefinition): RegisteredAgentVersion {
    const definition = normalizeAgentDefinition(input);
    this.#assertProject(definition.projectId);
    const definitionJson = stableStringify(definition);
    const definitionHash = sha256(definitionJson);
    const agentId = deterministicId('agent', `${definition.projectId}:${definition.name}`);
    const versionId = deterministicId('agent_version', `${agentId}:${definition.version}`);
    const now = new Date().toISOString();
    const database = this.#database.connection;

    return database
      .transaction(() => {
        const existingAgent = this.#agent(definition.projectId, definition.name);
        if (existingAgent === undefined) {
          database
            .prepare(
              `INSERT INTO agents(
               id, project_id, name, description, status, current_version_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'candidate', NULL, ?, ?)`,
            )
            .run(agentId, definition.projectId, definition.name, definition.description, now, now);
        }
        const identity = existingAgent?.id ?? agentId;
        const existingVersion = this.#version(identity, definition.version);
        if (existingVersion === undefined && this.#rawVersionExists(identity, definition.version)) {
          throw agentError(
            'AGENT_VERSION_INTEGRITY_MISSING',
            'Legacy agent version has no canonical integrity record and cannot be overwritten',
            { agentId: identity, version: definition.version },
          );
        }
        if (existingVersion !== undefined) {
          if (
            existingVersion.definitionHash !== definitionHash ||
            existingVersion.definitionJson !== definitionJson
          ) {
            throw agentError(
              'AGENT_VERSION_CONFLICT',
              'Agent version already exists with different immutable content',
              { agentId: identity, version: definition.version },
            );
          }
          const agent = this.#agentById(definition.projectId, identity);
          return this.#registered(agent, existingVersion, false);
        }
        database
          .prepare(
            `INSERT INTO agent_versions(
             id, agent_id, version, role, capabilities_json, tools_json,
             constraints_json, escalation_policy_json, evaluation_criteria_json,
             model_policy_json, context_policy_json, provenance_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            versionId,
            identity,
            definition.version,
            definition.role,
            stableStringify(definition.capabilities),
            stableStringify(definition.tools),
            stableStringify(definition.constraints),
            stableStringify(definition.escalationPolicy),
            stableStringify(definition.evaluationCriteria),
            stableStringify(definition.modelPolicy),
            stableStringify(definition.contextPolicy),
            now,
          );
        database
          .prepare(
            `INSERT INTO agent_version_integrity(
             agent_version_id, schema_version, definition_sha256, definition_json, created_at
           ) VALUES (?, 1, ?, ?, ?)`,
          )
          .run(versionId, definitionHash, definitionJson, now);
        const agent = this.#agentById(definition.projectId, identity);
        const version = this.#version(identity, definition.version);
        if (version === undefined) throw new Error('Agent version insert did not persist');
        return this.#registered(agent, version, true);
      })
      .immediate();
  }

  activate(input: {
    readonly projectId: string;
    readonly agentId: string;
    readonly version: string;
    readonly actor: string;
    readonly reason: string;
    readonly acknowledgeLocalOperator: boolean;
  }): AgentLifecycleDecision {
    if (!input.acknowledgeLocalOperator) {
      throw agentError(
        'LOCAL_OPERATOR_ACKNOWLEDGEMENT_REQUIRED',
        'Agent activation requires explicit local-operator acknowledgement',
      );
    }
    const projectId = requireKey(input.projectId, 'projectId', 160);
    const agentId = requireKey(input.agentId, 'agentId', 256);
    const versionName = requireSemver(input.version);
    const actor = requireAuditText(input.actor, 'actor', 256);
    const reason = requireAuditText(input.reason, 'reason', 2_048);
    const decisionId = createId('agent_decision');
    const now = new Date().toISOString();
    const database = this.#database.connection;

    return database
      .transaction(() => {
        const agent = this.#agentById(projectId, agentId);
        if (agent.status === 'blocked' || agent.status === 'archived') {
          throw agentError(
            'AGENT_ACTIVATION_BLOCKED',
            'Blocked or archived agents cannot be activated locally',
            { status: agent.status },
          );
        }
        const version = this.#version(agent.id, versionName);
        if (version === undefined) {
          throw agentError('AGENT_VERSION_NOT_FOUND', 'Agent version was not found');
        }
        const definition = verifiedDefinition(agent, version);
        database
          .prepare(
            `UPDATE agents
           SET status = 'active', current_version_id = ?, description = ?, updated_at = ?
           WHERE id = ? AND project_id = ?`,
          )
          .run(version.id, definition.description, now, agent.id, projectId);
        database
          .prepare(
            `INSERT INTO agent_lifecycle_decisions(
             id, project_id, agent_id, agent_version_id, action, actor, reason,
             previous_status, resulting_status, previous_version_id,
             resulting_version_id, created_at
           ) VALUES (?, ?, ?, ?, 'activate', ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            decisionId,
            projectId,
            agent.id,
            version.id,
            actor,
            reason,
            agent.status,
            agent.currentVersionId,
            version.id,
            now,
          );
        return {
          id: decisionId,
          action: 'activate',
          projectId,
          agentId: agent.id,
          agentVersionId: version.id,
          previousStatus: agent.status,
          resultingStatus: 'active',
          previousVersionId: agent.currentVersionId,
          resultingVersionId: version.id,
          createdAt: now,
        } satisfies AgentLifecycleDecision;
      })
      .immediate();
  }

  getActive(projectId: string, agentId: string): RegisteredAgentVersion {
    const normalizedProjectId = requireKey(projectId, 'projectId', 160);
    const normalizedAgentId = requireKey(agentId, 'agentId', 256);
    const agent = this.#agentById(normalizedProjectId, normalizedAgentId);
    if (agent.status !== 'active' || agent.currentVersionId === null) {
      throw agentError('AGENT_NOT_ACTIVE', 'Agent is not active');
    }
    const version = this.#versionById(agent.currentVersionId);
    if (version === undefined) {
      throw agentError('AGENT_REGISTRY_CORRUPT', 'Active agent version is missing');
    }
    return this.#registered(agent, version, false);
  }

  list(projectId: string, limit = 100): readonly RegisteredAgentVersion[] {
    const normalizedProjectId = requireKey(projectId, 'projectId', 160);
    const normalizedLimit = requireInteger(limit, 'limit', 1, 1_000);
    const agents = this.#database.connection
      .prepare(
        `SELECT id, project_id AS projectId, name, description, status,
                current_version_id AS currentVersionId
         FROM agents WHERE project_id = ? ORDER BY name ASC LIMIT ?`,
      )
      .all(normalizedProjectId, normalizedLimit) as AgentRow[];
    return agents.flatMap((agent) => {
      const version =
        agent.currentVersionId === null
          ? this.#latestVersion(agent.id)
          : this.#versionById(agent.currentVersionId);
      return version === undefined ? [] : [this.#registered(agent, version, false)];
    });
  }

  #registered(agent: AgentRow, version: AgentVersionRow, created: boolean): RegisteredAgentVersion {
    return {
      agentId: agent.id,
      versionId: version.id,
      projectId: agent.projectId,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      currentVersionId: agent.currentVersionId,
      definition: verifiedDefinition(agent, version),
      definitionHash: version.definitionHash,
      created,
    };
  }

  #agent(projectId: string, name: string): AgentRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT id, project_id AS projectId, name, description, status,
                current_version_id AS currentVersionId
         FROM agents WHERE project_id = ? AND name = ?`,
      )
      .get(projectId, name) as AgentRow | undefined;
  }

  #agentById(projectId: string, id: string): AgentRow {
    const row = this.#database.connection
      .prepare(
        `SELECT id, project_id AS projectId, name, description, status,
                current_version_id AS currentVersionId
         FROM agents WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as AgentRow | undefined;
    if (row === undefined) throw agentError('AGENT_NOT_FOUND', 'Project-local agent was not found');
    if (!AGENT_STATUSES.includes(row.status)) {
      throw agentError('AGENT_REGISTRY_CORRUPT', 'Stored agent status is invalid');
    }
    return row;
  }

  #version(agentId: string, version: string): AgentVersionRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT av.id, av.version, av.role, av.capabilities_json AS capabilitiesJson,
                av.tools_json AS toolsJson, av.constraints_json AS constraintsJson,
                av.escalation_policy_json AS escalationPolicyJson,
                av.evaluation_criteria_json AS evaluationCriteriaJson,
                av.model_policy_json AS modelPolicyJson,
                av.context_policy_json AS contextPolicyJson,
                integrity.definition_sha256 AS definitionHash,
                integrity.definition_json AS definitionJson
         FROM agent_versions av
         JOIN agent_version_integrity integrity ON integrity.agent_version_id = av.id
         WHERE av.agent_id = ? AND av.version = ?`,
      )
      .get(agentId, version) as AgentVersionRow | undefined;
  }

  #versionById(id: string): AgentVersionRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT av.id, av.version, av.role, av.capabilities_json AS capabilitiesJson,
                av.tools_json AS toolsJson, av.constraints_json AS constraintsJson,
                av.escalation_policy_json AS escalationPolicyJson,
                av.evaluation_criteria_json AS evaluationCriteriaJson,
                av.model_policy_json AS modelPolicyJson,
                av.context_policy_json AS contextPolicyJson,
                integrity.definition_sha256 AS definitionHash,
                integrity.definition_json AS definitionJson
         FROM agent_versions av
         JOIN agent_version_integrity integrity ON integrity.agent_version_id = av.id
         WHERE av.id = ?`,
      )
      .get(id) as AgentVersionRow | undefined;
  }

  #latestVersion(agentId: string): AgentVersionRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT av.id, av.version, av.role, av.capabilities_json AS capabilitiesJson,
                av.tools_json AS toolsJson, av.constraints_json AS constraintsJson,
                av.escalation_policy_json AS escalationPolicyJson,
                av.evaluation_criteria_json AS evaluationCriteriaJson,
                av.model_policy_json AS modelPolicyJson,
                av.context_policy_json AS contextPolicyJson,
                integrity.definition_sha256 AS definitionHash,
                integrity.definition_json AS definitionJson
         FROM agent_versions av
         JOIN agent_version_integrity integrity ON integrity.agent_version_id = av.id
         WHERE av.agent_id = ? ORDER BY av.created_at DESC, av.id DESC LIMIT 1`,
      )
      .get(agentId) as AgentVersionRow | undefined;
  }

  #rawVersionExists(agentId: string, version: string): boolean {
    return (
      this.#database.connection
        .prepare('SELECT 1 AS present FROM agent_versions WHERE agent_id = ? AND version = ?')
        .get(agentId, version) !== undefined
    );
  }

  #assertProject(projectId: string): void {
    const exists = this.#database.connection
      .prepare('SELECT 1 AS present FROM projects WHERE id = ?')
      .get(projectId) as { readonly present: number } | undefined;
    if (exists === undefined) throw agentError('AGENT_PROJECT_NOT_FOUND', 'Project was not found');
  }
}

export function parseAgentDefinition(value: unknown): AgentDefinition {
  const root = requireRecord(value, 'agent definition');
  assertKeys(
    root,
    [
      'projectId',
      'name',
      'description',
      'version',
      'role',
      'capabilities',
      'tools',
      'constraints',
      'escalationPolicy',
      'evaluationCriteria',
      'modelPolicy',
      'contextPolicy',
    ],
    'agent definition',
  );
  const constraints = requireRecord(root['constraints'], 'constraints');
  assertKeys(
    constraints,
    ['maxSteps', 'maxRetries', 'maxContextBytes', 'maxCostMicrounits', 'timeoutMs'],
    'constraints',
  );
  const escalationPolicy = requireRecord(root['escalationPolicy'], 'escalationPolicy');
  assertKeys(
    escalationPolicy,
    ['onBlocked', 'onBudgetExceeded', 'onRepeatedFailure'],
    'escalationPolicy',
  );
  const modelPolicy = requireRecord(root['modelPolicy'], 'modelPolicy');
  assertKeys(
    modelPolicy,
    ['requiredCapabilities', 'allowedProviders', 'allowedModelIds', 'allowUnmeasured'],
    'modelPolicy',
  );
  const contextPolicy = requireRecord(root['contextPolicy'], 'contextPolicy');
  assertKeys(
    contextPolicy,
    ['maxInputTokens', 'includeSkillInstructions', 'includeMemory'],
    'contextPolicy',
  );
  return normalizeAgentDefinition({
    projectId: requireRuntimeString(root['projectId'], 'projectId'),
    name: requireRuntimeString(root['name'], 'name'),
    description: requireRuntimeString(root['description'], 'description'),
    version: requireRuntimeString(root['version'], 'version'),
    role: requireRuntimeString(root['role'], 'role'),
    capabilities: requireRuntimeStrings(root['capabilities'], 'capabilities'),
    tools: requireRuntimeStrings(root['tools'], 'tools'),
    constraints: {
      maxSteps: requireRuntimeNumber(constraints['maxSteps'], 'maxSteps'),
      maxRetries: requireRuntimeNumber(constraints['maxRetries'], 'maxRetries'),
      maxContextBytes: requireRuntimeNumber(constraints['maxContextBytes'], 'maxContextBytes'),
      maxCostMicrounits: requireRuntimeNumber(
        constraints['maxCostMicrounits'],
        'maxCostMicrounits',
      ),
      timeoutMs: requireRuntimeNumber(constraints['timeoutMs'], 'timeoutMs'),
    },
    escalationPolicy: {
      onBlocked: requireRuntimeString(escalationPolicy['onBlocked'], 'onBlocked') as
        'fail' | 'manual',
      onBudgetExceeded: requireRuntimeString(
        escalationPolicy['onBudgetExceeded'],
        'onBudgetExceeded',
      ) as 'fail' | 'manual',
      onRepeatedFailure: requireRuntimeString(
        escalationPolicy['onRepeatedFailure'],
        'onRepeatedFailure',
      ) as 'fail' | 'manual',
    },
    evaluationCriteria: requireRuntimeStrings(root['evaluationCriteria'], 'evaluationCriteria'),
    modelPolicy: {
      requiredCapabilities: requireRuntimeStrings(
        modelPolicy['requiredCapabilities'],
        'requiredCapabilities',
      ) as AgentDefinition['modelPolicy']['requiredCapabilities'],
      allowedProviders: requireRuntimeStrings(modelPolicy['allowedProviders'], 'allowedProviders'),
      allowedModelIds: requireRuntimeStrings(modelPolicy['allowedModelIds'], 'allowedModelIds'),
      allowUnmeasured: requireRuntimeBoolean(modelPolicy['allowUnmeasured'], 'allowUnmeasured'),
    },
    contextPolicy: {
      maxInputTokens: requireRuntimeNumber(contextPolicy['maxInputTokens'], 'maxInputTokens'),
      includeSkillInstructions: requireRuntimeBoolean(
        contextPolicy['includeSkillInstructions'],
        'includeSkillInstructions',
      ),
      includeMemory: requireRuntimeBoolean(contextPolicy['includeMemory'], 'includeMemory'),
    },
  });
}

export function normalizeAgentDefinition(input: AgentDefinition): AgentDefinition {
  const projectId = requireKey(input.projectId, 'projectId', 160);
  const name = requireKey(input.name, 'agent name', 128).toLocaleLowerCase('en-US');
  const description = requireText(input.description, 'agent description', 2_048);
  const version = requireSemver(input.version);
  const role = requireText(input.role, 'agent role', 2_048);
  const capabilities = normalizeKeys(input.capabilities, 'capabilities', 128);
  if (capabilities.length === 0) throw new RangeError('Agent must declare at least one capability');
  const tools = normalizeKeys(input.tools, 'tools', 64);
  const evaluationCriteria = normalizeTexts(
    input.evaluationCriteria,
    'evaluationCriteria',
    64,
    512,
  );
  if (evaluationCriteria.length === 0) {
    throw new RangeError('Agent must declare at least one evaluation criterion');
  }
  const requiredCapabilities = normalizeKeys(
    input.modelPolicy.requiredCapabilities,
    'model requiredCapabilities',
    MODEL_CAPABILITIES.length,
  );
  if (
    requiredCapabilities.some(
      (capability) =>
        !MODEL_CAPABILITIES.includes(capability as (typeof MODEL_CAPABILITIES)[number]),
    )
  ) {
    throw new RangeError('Agent model policy contains an unsupported capability');
  }
  const escalationValues: readonly unknown[] = [
    input.escalationPolicy.onBlocked,
    input.escalationPolicy.onBudgetExceeded,
    input.escalationPolicy.onRepeatedFailure,
  ];
  if (escalationValues.some((value) => value !== 'fail' && value !== 'manual')) {
    throw new RangeError('Agent escalation policy contains an unsupported action');
  }
  if (
    typeof input.modelPolicy.allowUnmeasured !== 'boolean' ||
    typeof input.contextPolicy.includeSkillInstructions !== 'boolean' ||
    typeof input.contextPolicy.includeMemory !== 'boolean'
  ) {
    throw new TypeError('Agent policy flags must be boolean');
  }
  const normalized: AgentDefinition = {
    projectId,
    name,
    description,
    version,
    role,
    capabilities,
    tools,
    constraints: {
      maxSteps: requireInteger(input.constraints.maxSteps, 'maxSteps', 1, 256),
      maxRetries: requireInteger(input.constraints.maxRetries, 'maxRetries', 0, 20),
      maxContextBytes: requireInteger(
        input.constraints.maxContextBytes,
        'maxContextBytes',
        1,
        100_000_000,
      ),
      maxCostMicrounits: requireInteger(
        input.constraints.maxCostMicrounits,
        'maxCostMicrounits',
        0,
        1_000_000_000_000_000,
      ),
      timeoutMs: requireInteger(input.constraints.timeoutMs, 'timeoutMs', 1, 86_400_000),
    },
    escalationPolicy: {
      onBlocked: input.escalationPolicy.onBlocked,
      onBudgetExceeded: input.escalationPolicy.onBudgetExceeded,
      onRepeatedFailure: input.escalationPolicy.onRepeatedFailure,
    },
    evaluationCriteria,
    modelPolicy: {
      requiredCapabilities:
        requiredCapabilities as AgentDefinition['modelPolicy']['requiredCapabilities'],
      allowedProviders: normalizeKeys(input.modelPolicy.allowedProviders, 'allowedProviders', 32),
      allowedModelIds: normalizeKeys(input.modelPolicy.allowedModelIds, 'allowedModelIds', 128),
      allowUnmeasured: input.modelPolicy.allowUnmeasured,
    },
    contextPolicy: {
      maxInputTokens: requireInteger(
        input.contextPolicy.maxInputTokens,
        'maxInputTokens',
        1,
        10_000_000,
      ),
      includeSkillInstructions: input.contextPolicy.includeSkillInstructions,
      includeMemory: input.contextPolicy.includeMemory,
    },
  };
  const canonical = stableStringify(normalized);
  if (redactText(canonical) !== canonical) {
    throw agentError(
      'AGENT_DEFINITION_SENSITIVE',
      'Agent definition appears to contain sensitive credential material',
    );
  }
  return normalized;
}

function verifiedDefinition(agent: AgentRow, version: AgentVersionRow): AgentDefinition {
  const definition = parseDefinition(version.definitionJson);
  const canonical = stableStringify(definition);
  const decomposedMatches =
    definition.projectId === agent.projectId &&
    definition.name === agent.name &&
    definition.version === version.version &&
    definition.role === version.role &&
    stableStringify(definition.capabilities) === version.capabilitiesJson &&
    stableStringify(definition.tools) === version.toolsJson &&
    stableStringify(definition.constraints) === version.constraintsJson &&
    stableStringify(definition.escalationPolicy) === version.escalationPolicyJson &&
    stableStringify(definition.evaluationCriteria) === version.evaluationCriteriaJson &&
    stableStringify(definition.modelPolicy) === version.modelPolicyJson &&
    stableStringify(definition.contextPolicy) === version.contextPolicyJson;
  if (
    canonical !== version.definitionJson ||
    sha256(canonical) !== version.definitionHash ||
    !decomposedMatches
  ) {
    throw agentError(
      'AGENT_REGISTRY_CORRUPT',
      'Stored agent definition does not match its integrity evidence',
      { agentId: agent.id, agentVersionId: version.id },
    );
  }
  return definition;
}

function parseDefinition(value: string): AgentDefinition {
  try {
    return parseAgentDefinition(JSON.parse(value) as unknown);
  } catch (error) {
    throw agentError(
      'AGENT_REGISTRY_CORRUPT',
      'Stored agent definition is invalid',
      undefined,
      error,
    );
  }
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RangeError(`${name} contains unknown keys: ${unknown.sort().join(', ')}`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new RangeError(`${name} is missing required keys: ${missing.join(', ')}`);
  }
}

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function requireRuntimeStrings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value as readonly string[];
}

function requireRuntimeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  return value;
}

function requireRuntimeBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

import { deterministicId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import type { CreateSynthesisProposalInput, SynthesisProposal } from './types.js';
import {
  capabilityError,
  normalizeTerms,
  parseJsonStrings,
  requireBoundedText,
  requireSimpleKey,
  sha256,
} from './validation.js';

interface ProposalRow {
  readonly id: string;
  readonly projectId: string;
  readonly compositionPlanId: string;
  readonly name: string;
  readonly intentHash: string;
  readonly requiredBehaviorsJson: string;
  readonly acceptanceCriteriaJson: string;
  readonly prohibitedBehaviorsJson: string;
  readonly status: SynthesisProposal['status'];
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SynthesisProposalRegistry {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  create(input: CreateSynthesisProposalInput): SynthesisProposal {
    const projectId = requireSimpleKey(input.projectId, 'projectId', 160);
    const name = requireSimpleKey(input.name, 'name');
    const intent = requireBoundedText(input.intent, 'intent', 4_096);
    const requiredBehaviors = normalizeTerms(input.requiredBehaviors, 'requiredBehaviors', 32);
    if (requiredBehaviors.length === 0) {
      throw new RangeError('requiredBehaviors must contain at least one behavior');
    }
    const acceptanceCriteria = normalizeStatements(
      input.acceptanceCriteria,
      'acceptanceCriteria',
      32,
    );
    if (acceptanceCriteria.length === 0) {
      throw new RangeError('acceptanceCriteria must contain at least one criterion');
    }
    const prohibitedBehaviors = normalizeStatements(
      input.prohibitedBehaviors ?? [],
      'prohibitedBehaviors',
      32,
    );
    if (input.composition.status !== 'incomplete') {
      throw capabilityError(
        'SYNTHESIS_GAP_REQUIRED',
        'Synthesis proposals require an incomplete composition plan with measured gaps',
      );
    }
    const uncovered = new Set(input.composition.uncoveredCapabilities);
    if (requiredBehaviors.some((behavior) => !uncovered.has(behavior))) {
      throw capabilityError(
        'SYNTHESIS_BEHAVIOR_NOT_EVIDENCED',
        'Every proposed behavior must be an uncovered composition requirement',
      );
    }
    const plan = this.#database.connection
      .prepare(`SELECT project_id AS projectId, status FROM composition_plans WHERE id = ?`)
      .get(input.composition.planId) as
      { readonly projectId: string; readonly status: string } | undefined;
    if (plan === undefined || plan.projectId !== projectId || plan.status !== 'incomplete') {
      throw capabilityError(
        'SYNTHESIS_PLAN_INVALID',
        'Composition plan is missing, complete, or belongs to another project',
      );
    }
    const intentHash = sha256(intent);
    const canonical = {
      compositionPlanId: input.composition.planId,
      name,
      intentHash,
      requiredBehaviors,
      acceptanceCriteria,
      prohibitedBehaviors,
    };
    const contentHash = sha256(stableStringify(canonical));
    const id = deterministicId('synthesis_proposal', `${projectId}:${contentHash}`);
    const now = new Date().toISOString();
    this.#database.connection
      .prepare(
        `INSERT INTO synthesis_proposals(
           id, project_id, composition_plan_id, name, intent_sha256,
           required_behaviors_json, acceptance_criteria_json, prohibited_behaviors_json,
           status, content_sha256, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
         ON CONFLICT(project_id, content_sha256) DO NOTHING`,
      )
      .run(
        id,
        projectId,
        input.composition.planId,
        name,
        intentHash,
        stableStringify(requiredBehaviors),
        stableStringify(acceptanceCriteria),
        stableStringify(prohibitedBehaviors),
        contentHash,
        now,
        now,
      );
    const stored = this.get(id);
    if (stored === undefined) {
      throw capabilityError('SYNTHESIS_WRITE_FAILED', 'Synthesis proposal was not persisted');
    }
    return stored;
  }

  get(id: string): SynthesisProposal | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT id, project_id AS projectId, composition_plan_id AS compositionPlanId,
                name, intent_sha256 AS intentHash,
                required_behaviors_json AS requiredBehaviorsJson,
                acceptance_criteria_json AS acceptanceCriteriaJson,
                prohibited_behaviors_json AS prohibitedBehaviorsJson,
                status, content_sha256 AS contentHash, created_at AS createdAt,
                updated_at AS updatedAt
         FROM synthesis_proposals WHERE id = ?`,
      )
      .get(id) as ProposalRow | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      projectId: row.projectId,
      compositionPlanId: row.compositionPlanId,
      name: row.name,
      intentHash: row.intentHash,
      requiredBehaviors: parseJsonStrings(row.requiredBehaviorsJson, 'required behaviors'),
      acceptanceCriteria: parseJsonStrings(row.acceptanceCriteriaJson, 'acceptance criteria'),
      prohibitedBehaviors: parseJsonStrings(row.prohibitedBehaviorsJson, 'prohibited behaviors'),
      status: row.status,
      contentHash: row.contentHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function normalizeStatements(
  values: readonly string[],
  name: string,
  maximum: number,
): readonly string[] {
  if (values.length > maximum) throw new RangeError(`${name} must not exceed ${maximum} items`);
  return [
    ...new Set(values.map((value) => requireBoundedText(value, `${name} item`, 1_024))),
  ].sort();
}

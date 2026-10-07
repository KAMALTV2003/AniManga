import { createId, redactText, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import { CapabilityGraph } from './graph.js';
import {
  capabilityError,
  requireBoundedText,
  requireFiniteUnit,
  requireSimpleKey,
  sha256,
} from './validation.js';

export interface RequiredEvaluationSuite {
  readonly name: string;
  readonly version: string;
}

export interface SkillPromotionPolicy {
  readonly version?: string;
  readonly requiredSuites?: readonly RequiredEvaluationSuite[];
  readonly minimumAggregateScore?: number;
  readonly minimumSecurityScore?: number;
  readonly maximumRisk?: 'safe' | 'low' | 'medium';
}

export interface PromotionCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface SkillPromotionAssessment {
  readonly projectId: string;
  readonly skillId: string;
  readonly skillVersionId: string;
  readonly version: string;
  readonly policyVersion: string;
  readonly eligible: boolean;
  readonly checks: readonly PromotionCheck[];
  readonly evidenceIds: readonly string[];
  readonly previousStatus: 'candidate' | 'active' | 'deprecated' | 'archived' | 'blocked';
  readonly previousVersionId: string | null;
}

export interface PromotionDecision {
  readonly id: string;
  readonly decisionType: 'promotion' | 'rollback';
  readonly outcome: 'applied' | 'denied';
  readonly projectId: string;
  readonly skillId: string;
  readonly skillVersionId: string;
  readonly policyVersion: string;
  readonly previousStatus: SkillPromotionAssessment['previousStatus'];
  readonly resultingStatus: SkillPromotionAssessment['previousStatus'];
  readonly previousVersionId: string | null;
  readonly resultingVersionId: string | null;
  readonly checks: readonly PromotionCheck[];
  readonly evidenceIds: readonly string[];
  readonly parentDecisionId: string | null;
  readonly createdAt: string;
  readonly graphSynchronized: boolean;
}

interface TargetRow {
  readonly projectId: string;
  readonly skillId: string;
  readonly status: SkillPromotionAssessment['previousStatus'];
  readonly currentVersionId: string | null;
  readonly versionId: string;
  readonly version: string;
  readonly versionRisk: string;
}

interface AssessmentRow {
  readonly id: string;
  readonly disposition: string;
  readonly risk: string;
  readonly scanId: string;
  readonly scanStatus: string;
  readonly scanRisk: string;
}

interface LicenseRow {
  readonly id: string;
  readonly status: string;
  readonly reviewRequired: number;
}

interface ValidationRow {
  readonly id: string;
  readonly passed: number;
}

interface EvaluationRow {
  readonly id: string;
  readonly status: string;
  readonly aggregateScore: number | null;
  readonly securityScore: number | null;
}

interface DecisionRow {
  readonly id: string;
  readonly projectId: string;
  readonly skillId: string;
  readonly skillVersionId: string;
  readonly policyVersion: string;
  readonly previousStatus: SkillPromotionAssessment['previousStatus'];
  readonly resultingStatus: SkillPromotionAssessment['previousStatus'];
  readonly previousVersionId: string | null;
  readonly resultingVersionId: string | null;
  readonly checksJson: string;
  readonly evidenceJson: string;
  readonly createdAt: string;
}

const RISK_ORDER = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  blocked: 5,
  unknown: 6,
} as const;

export class SkillPromotionService {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  assess(
    projectId: string,
    skillId: string,
    version: string,
    policy: SkillPromotionPolicy = {},
  ): SkillPromotionAssessment {
    const normalizedProjectId = requireSimpleKey(projectId, 'projectId', 160);
    const normalizedSkillId = requireSimpleKey(skillId, 'skillId', 256);
    const normalizedVersion = requireSimpleKey(version, 'version', 64);
    const normalizedPolicy = normalizePolicy(policy);
    const target = this.#target(normalizedProjectId, normalizedSkillId, normalizedVersion);
    const assessment = this.#database.connection
      .prepare(
        `SELECT sa.id, sa.disposition, sa.risk_level AS risk,
                sa.security_scan_id AS scanId, ss.status AS scanStatus,
                ss.risk_level AS scanRisk
         FROM skill_assessments sa
         JOIN security_scans ss ON ss.id = sa.security_scan_id
         WHERE sa.skill_version_id = ?
         ORDER BY sa.created_at DESC, sa.id DESC LIMIT 1`,
      )
      .get(target.versionId) as AssessmentRow | undefined;
    const license = this.#database.connection
      .prepare(
        `SELECT review.id, review.status, review.review_required AS reviewRequired
         FROM harvest_runs harvest
         JOIN skill_license_reviews review ON review.harvest_id = harvest.id
         WHERE harvest.skill_version_id = ?
         ORDER BY review.created_at DESC, review.id DESC LIMIT 1`,
      )
      .get(target.versionId) as LicenseRow | undefined;
    const validation = this.#database.connection
      .prepare(
        `SELECT id, passed FROM skill_validation_runs
         WHERE skill_version_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(target.versionId) as ValidationRow | undefined;
    const blockingFindings =
      assessment === undefined
        ? []
        : (this.#database.connection
            .prepare(
              `SELECT id, severity, rule_id AS ruleId FROM security_findings
               WHERE scan_id = ? AND status IN ('open','acknowledged','blocked')
                 AND severity IN ('high','critical','blocked')
               ORDER BY severity DESC, id ASC`,
            )
            .all(assessment.scanId) as {
            readonly id: string;
            readonly severity: string;
            readonly ruleId: string;
          }[]);
    const checks: PromotionCheck[] = [
      check(
        'registry-state',
        (target.status === 'candidate' || target.status === 'active') &&
          target.currentVersionId !== target.versionId,
        'Target is an unpromoted candidate version of a candidate or active Skill',
        { status: target.status, currentVersionId: target.currentVersionId },
      ),
      check(
        'trust-assessment',
        assessment?.disposition === 'candidate' && assessment.scanStatus === 'completed',
        'Candidate has a completed harvest trust assessment',
        {
          assessmentId: assessment?.id ?? null,
          disposition: assessment?.disposition ?? null,
          scanStatus: assessment?.scanStatus ?? null,
        },
      ),
      check(
        'risk-threshold',
        assessment !== undefined &&
          riskAllowed(assessment.risk, normalizedPolicy.maximumRisk) &&
          riskAllowed(assessment.scanRisk, normalizedPolicy.maximumRisk) &&
          riskAllowed(target.versionRisk, normalizedPolicy.maximumRisk),
        `Recorded risks do not exceed ${normalizedPolicy.maximumRisk}`,
        {
          assessmentRisk: assessment?.risk ?? null,
          scanRisk: assessment?.scanRisk ?? null,
          versionRisk: target.versionRisk,
        },
      ),
      check(
        'license-review',
        license !== undefined && license.reviewRequired === 0,
        'License evidence does not require unresolved review',
        { reviewId: license?.id ?? null, status: license?.status ?? null },
      ),
      check(
        'structural-validation',
        validation?.passed === 1,
        'Latest structural validation passed without executing imported code',
        { validationId: validation?.id ?? null, passed: validation?.passed === 1 },
      ),
      check(
        'blocking-findings',
        blockingFindings.length === 0,
        'No unresolved high, critical, or blocked static findings exist',
        { findingIds: blockingFindings.map((finding) => finding.id) },
      ),
    ];
    const evaluationIds: string[] = [];
    for (const required of normalizedPolicy.requiredSuites) {
      const evaluation = this.#evaluation(target.versionId, required);
      if (evaluation !== undefined) evaluationIds.push(evaluation.id);
      checks.push(
        check(
          `evaluation:${required.name}@${required.version}`,
          evaluation?.status === 'passed' &&
            evaluation.aggregateScore !== null &&
            evaluation.aggregateScore >= normalizedPolicy.minimumAggregateScore &&
            evaluation.securityScore !== null &&
            evaluation.securityScore >= normalizedPolicy.minimumSecurityScore,
          `Required evaluation ${required.name}@${required.version} passed score gates`,
          {
            evaluationId: evaluation?.id ?? null,
            status: evaluation?.status ?? null,
            aggregateScore: evaluation?.aggregateScore ?? null,
            securityScore: evaluation?.securityScore ?? null,
            minimumAggregateScore: normalizedPolicy.minimumAggregateScore,
            minimumSecurityScore: normalizedPolicy.minimumSecurityScore,
          },
        ),
      );
    }
    const evidenceIds = [
      assessment?.id,
      assessment?.scanId,
      license?.id,
      validation?.id,
      ...blockingFindings.map((finding) => finding.id),
      ...evaluationIds,
    ].filter((value): value is string => value !== undefined);
    return {
      projectId: normalizedProjectId,
      skillId: normalizedSkillId,
      skillVersionId: target.versionId,
      version: target.version,
      policyVersion: normalizedPolicy.version,
      eligible: checks.every((item) => item.passed),
      checks,
      evidenceIds: [...new Set(evidenceIds)].sort(),
      previousStatus: target.status,
      previousVersionId: target.currentVersionId,
    };
  }

  promote(input: {
    readonly projectId: string;
    readonly skillId: string;
    readonly version: string;
    readonly actor: string;
    readonly reason: string;
    readonly acknowledgeLocalOperator: boolean;
    readonly policy?: SkillPromotionPolicy;
  }): PromotionDecision {
    assertAcknowledged(input.acknowledgeLocalOperator);
    const actor = requireAuditText(input.actor, 'actor', 256);
    const reason = requireAuditText(input.reason, 'reason', 2_048);
    const decisionId = createId('promotion_decision');
    const database = this.#database.connection;
    return database
      .transaction(() => {
        const assessment = this.assess(input.projectId, input.skillId, input.version, input.policy);
        const now = new Date().toISOString();
        const outcome = assessment.eligible ? 'applied' : 'denied';
        const resultingStatus = assessment.eligible ? 'active' : assessment.previousStatus;
        const resultingVersionId = assessment.eligible
          ? assessment.skillVersionId
          : assessment.previousVersionId;
        if (assessment.eligible) {
          database
            .prepare(
              `UPDATE skills SET status = 'active', current_version_id = ?, updated_at = ?
             WHERE id = ? AND project_id = ?`,
            )
            .run(assessment.skillVersionId, now, assessment.skillId, assessment.projectId);
        }
        insertDecision(database, {
          id: decisionId,
          projectId: assessment.projectId,
          skillId: assessment.skillId,
          skillVersionId: assessment.skillVersionId,
          decisionType: 'promotion',
          outcome,
          policyVersion: assessment.policyVersion,
          actor,
          reason,
          previousStatus: assessment.previousStatus,
          resultingStatus,
          previousVersionId: assessment.previousVersionId,
          resultingVersionId,
          checks: assessment.checks,
          evidenceIds: assessment.evidenceIds,
          parentDecisionId: null,
          createdAt: now,
        });
        const graphSynchronized = assessment.eligible
          ? this.#synchronizeGraph(assessment.projectId, decisionId)
          : false;
        return {
          id: decisionId,
          decisionType: 'promotion',
          outcome,
          projectId: assessment.projectId,
          skillId: assessment.skillId,
          skillVersionId: assessment.skillVersionId,
          policyVersion: assessment.policyVersion,
          previousStatus: assessment.previousStatus,
          resultingStatus,
          previousVersionId: assessment.previousVersionId,
          resultingVersionId,
          checks: assessment.checks,
          evidenceIds: assessment.evidenceIds,
          parentDecisionId: null,
          createdAt: now,
          graphSynchronized,
        } satisfies PromotionDecision;
      })
      .immediate();
  }

  rollback(input: {
    readonly projectId: string;
    readonly promotionDecisionId: string;
    readonly actor: string;
    readonly reason: string;
    readonly acknowledgeLocalOperator: boolean;
  }): PromotionDecision {
    assertAcknowledged(input.acknowledgeLocalOperator);
    const projectId = requireSimpleKey(input.projectId, 'projectId', 160);
    const promotionDecisionId = requireSimpleKey(
      input.promotionDecisionId,
      'promotionDecisionId',
      256,
    );
    const actor = requireAuditText(input.actor, 'actor', 256);
    const reason = requireAuditText(input.reason, 'reason', 2_048);
    const rollbackId = createId('promotion_decision');
    const database = this.#database.connection;
    return database
      .transaction(() => {
        const promotion = database
          .prepare(
            `SELECT id, project_id AS projectId, skill_id AS skillId,
                  skill_version_id AS skillVersionId, policy_version AS policyVersion,
                  previous_status AS previousStatus, resulting_status AS resultingStatus,
                  previous_version_id AS previousVersionId,
                  resulting_version_id AS resultingVersionId, checks_json AS checksJson,
                  evidence_json AS evidenceJson, created_at AS createdAt
           FROM capability_promotion_decisions
           WHERE id = ? AND decision_type = 'promotion' AND outcome = 'applied'`,
          )
          .get(promotionDecisionId) as DecisionRow | undefined;
        if (promotion === undefined || promotion.projectId !== projectId) {
          throw capabilityError(
            'PROMOTION_DECISION_NOT_FOUND',
            'Applied project-local promotion decision was not found',
          );
        }
        const existingRollback = database
          .prepare(
            `SELECT id FROM capability_promotion_decisions
           WHERE parent_decision_id = ? AND decision_type = 'rollback' AND outcome = 'applied'`,
          )
          .get(promotion.id) as { readonly id: string } | undefined;
        if (existingRollback !== undefined) {
          throw capabilityError(
            'PROMOTION_ALREADY_ROLLED_BACK',
            'Promotion decision already has an applied rollback',
            { rollbackDecisionId: existingRollback.id },
          );
        }
        const current = database
          .prepare(
            `SELECT status, current_version_id AS currentVersionId FROM skills
           WHERE id = ? AND project_id = ?`,
          )
          .get(promotion.skillId, projectId) as
          | {
              readonly status: SkillPromotionAssessment['previousStatus'];
              readonly currentVersionId: string | null;
            }
          | undefined;
        if (
          current === undefined ||
          current.status !== promotion.resultingStatus ||
          current.currentVersionId !== promotion.resultingVersionId
        ) {
          throw capabilityError(
            'ROLLBACK_STATE_DIVERGED',
            'Current Skill state no longer matches the selected promotion decision',
          );
        }
        const now = new Date().toISOString();
        const checks: readonly PromotionCheck[] = [
          check('state-match', true, 'Current state matches the applied promotion decision', {
            promotionDecisionId: promotion.id,
          }),
        ];
        database
          .prepare(
            `UPDATE skills SET status = ?, current_version_id = ?, updated_at = ?
           WHERE id = ? AND project_id = ?`,
          )
          .run(
            promotion.previousStatus,
            promotion.previousVersionId,
            now,
            promotion.skillId,
            projectId,
          );
        insertDecision(database, {
          id: rollbackId,
          projectId,
          skillId: promotion.skillId,
          skillVersionId: promotion.skillVersionId,
          decisionType: 'rollback',
          outcome: 'applied',
          policyVersion: promotion.policyVersion,
          actor,
          reason,
          previousStatus: promotion.resultingStatus,
          resultingStatus: promotion.previousStatus,
          previousVersionId: promotion.resultingVersionId,
          resultingVersionId: promotion.previousVersionId,
          checks,
          evidenceIds: [promotion.id],
          parentDecisionId: promotion.id,
          createdAt: now,
        });
        const graphSynchronized = this.#synchronizeGraph(projectId, rollbackId);
        return {
          id: rollbackId,
          decisionType: 'rollback',
          outcome: 'applied',
          projectId,
          skillId: promotion.skillId,
          skillVersionId: promotion.skillVersionId,
          policyVersion: promotion.policyVersion,
          previousStatus: promotion.resultingStatus,
          resultingStatus: promotion.previousStatus,
          previousVersionId: promotion.resultingVersionId,
          resultingVersionId: promotion.previousVersionId,
          checks,
          evidenceIds: [promotion.id],
          parentDecisionId: promotion.id,
          createdAt: now,
          graphSynchronized,
        } satisfies PromotionDecision;
      })
      .immediate();
  }

  #target(projectId: string, skillId: string, version: string): TargetRow {
    const row = this.#database.connection
      .prepare(
        `SELECT s.project_id AS projectId, s.id AS skillId, s.status,
                s.current_version_id AS currentVersionId, sv.id AS versionId,
                sv.version, sv.risk_level AS versionRisk
         FROM skills s JOIN skill_versions sv ON sv.skill_id = s.id
         WHERE s.project_id = ? AND s.id = ? AND sv.version = ?`,
      )
      .get(projectId, skillId, version) as TargetRow | undefined;
    if (row === undefined) {
      throw capabilityError(
        'PROMOTION_TARGET_NOT_FOUND',
        'Skill version was not found in the requested project',
      );
    }
    return row;
  }

  #evaluation(versionId: string, required: RequiredEvaluationSuite): EvaluationRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT e.id, e.status, e.aggregate_score AS aggregateScore,
                scores.score AS securityScore
         FROM evaluations e
         LEFT JOIN evaluation_scores scores
           ON scores.evaluation_id = e.id AND scores.criterion = 'security'
         WHERE e.target_type = 'skill' AND e.target_id = ?
           AND e.suite_name = ? AND e.suite_version = ?
         ORDER BY COALESCE(e.completed_at, e.created_at) DESC, e.id DESC LIMIT 1`,
      )
      .get(versionId, required.name, required.version) as EvaluationRow | undefined;
  }

  #synchronizeGraph(projectId: string, decisionId: string): boolean {
    try {
      new CapabilityGraph(this.#database).syncActiveSkills(projectId);
      return true;
    } catch (error) {
      throw capabilityError(
        'PROMOTION_GRAPH_SYNC_FAILED',
        'Registry decision transaction could not synchronize the derived capability graph',
        { decisionId, registryDecisionApplied: false },
        error,
      );
    }
  }
}

function normalizePolicy(policy: SkillPromotionPolicy): {
  readonly version: string;
  readonly requiredSuites: readonly RequiredEvaluationSuite[];
  readonly minimumAggregateScore: number;
  readonly minimumSecurityScore: number;
  readonly maximumRisk: 'safe' | 'low' | 'medium';
} {
  const requiredSuites = policy.requiredSuites ?? [
    { name: 'nexus.behavioral-skill', version: '1' },
  ];
  if (requiredSuites.length < 1 || requiredSuites.length > 20) {
    throw new RangeError('Promotion policy must require between 1 and 20 evaluation suites');
  }
  const normalizedSuites = requiredSuites.map((suite) => ({
    name: requireSimpleKey(suite.name, 'evaluation suite name'),
    version: requireSimpleKey(suite.version, 'evaluation suite version', 64),
  }));
  const identities = normalizedSuites.map((suite) => `${suite.name}@${suite.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new RangeError('Promotion policy evaluation suites must be unique');
  }
  const maximumRisk = policy.maximumRisk ?? 'low';
  if (!['safe', 'low', 'medium'].includes(maximumRisk)) {
    throw new RangeError('Promotion maximumRisk must be safe, low, or medium');
  }
  const configuration = {
    requiredSuites: normalizedSuites,
    minimumAggregateScore: requireFiniteUnit(
      policy.minimumAggregateScore ?? 0.8,
      'minimumAggregateScore',
    ),
    minimumSecurityScore: requireFiniteUnit(
      policy.minimumSecurityScore ?? 0.9,
      'minimumSecurityScore',
    ),
    maximumRisk,
  };
  const declaredVersion = requireSimpleKey(
    policy.version ?? 'nexus.local-promotion-v1',
    'policy version',
  );
  return {
    version: `${declaredVersion}:${sha256(stableStringify(configuration)).slice(0, 16)}`,
    ...configuration,
  };
}

function requireAuditText(value: string, name: string, maximumBytes: number): string {
  const normalized = requireBoundedText(value, name, maximumBytes);
  if (redactText(normalized) !== normalized) {
    throw capabilityError(
      'PROMOTION_AUDIT_TEXT_SENSITIVE',
      `${name} appears to contain sensitive credential material`,
    );
  }
  return normalized;
}

function check(
  id: string,
  passed: boolean,
  summary: string,
  evidence: Readonly<Record<string, unknown>>,
): PromotionCheck {
  return { id, passed, summary, evidence };
}

function riskAllowed(actual: string, maximum: 'safe' | 'low' | 'medium'): boolean {
  if (!Object.hasOwn(RISK_ORDER, actual)) return false;
  return RISK_ORDER[actual as keyof typeof RISK_ORDER] <= RISK_ORDER[maximum];
}

function assertAcknowledged(acknowledged: boolean): void {
  if (!acknowledged) {
    throw capabilityError(
      'LOCAL_OPERATOR_ACKNOWLEDGEMENT_REQUIRED',
      'Promotion and rollback require explicit local-operator acknowledgement',
    );
  }
}

function insertDecision(
  database: SqliteDatabase['connection'],
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly skillId: string;
    readonly skillVersionId: string;
    readonly decisionType: 'promotion' | 'rollback';
    readonly outcome: 'applied' | 'denied';
    readonly policyVersion: string;
    readonly actor: string;
    readonly reason: string;
    readonly previousStatus: SkillPromotionAssessment['previousStatus'];
    readonly resultingStatus: SkillPromotionAssessment['previousStatus'];
    readonly previousVersionId: string | null;
    readonly resultingVersionId: string | null;
    readonly checks: readonly PromotionCheck[];
    readonly evidenceIds: readonly string[];
    readonly parentDecisionId: string | null;
    readonly createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO capability_promotion_decisions(
         id, project_id, skill_id, skill_version_id, decision_type, outcome,
         policy_version, actor, reason, previous_status, resulting_status,
         previous_version_id, resulting_version_id, checks_json, evidence_json,
         parent_decision_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.skillId,
      input.skillVersionId,
      input.decisionType,
      input.outcome,
      input.policyVersion,
      input.actor,
      input.reason,
      input.previousStatus,
      input.resultingStatus,
      input.previousVersionId,
      input.resultingVersionId,
      stableStringify(input.checks),
      stableStringify({ evidenceIds: input.evidenceIds }),
      input.parentDecisionId,
      input.createdAt,
    );
}

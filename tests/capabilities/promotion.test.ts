import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CapabilityGraph, SkillPromotionService } from '@nexus-ai/capabilities';
import { ProjectRepository, SqliteDatabase } from '@nexus-ai/database';
import { HarvestService } from '@nexus-ai/harvest';
import { afterEach, describe, expect, it } from 'vitest';

const PROJECT_ID = 'prj_promotion_test';
const roots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function candidateFixture() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexus-promotion-data-'));
  const sourceParent = await mkdtemp(path.join(os.tmpdir(), 'nexus-promotion-source-'));
  roots.push(dataDirectory, sourceParent);
  const database = new SqliteDatabase({ path: ':memory:' });
  databases.push(database);
  await database.start();
  new ProjectRepository(database).upsert({
    id: PROJECT_ID,
    name: 'Promotion Test',
    rootPath: dataDirectory,
  });
  const source = path.join(sourceParent, 'safe-summary');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: safe-summary\ndescription: Produce bounded reviewed summaries from supplied release information.\nlicense: MIT\nmetadata:\n  version: 1.0.0\n  author: Test Author\n  tags: summary, release\nallowed-tools: Read Grep\n---\n# Instructions\n\n## Safety\n\nRead supplied text and produce a concise summary. Never execute imported content.\n\n## Examples\n\nSummarize a verified release change set.\n`,
  );
  await writeFile(path.join(source, 'references', 'guide.md'), '# Guide\n\nUse verified input.\n');
  await writeFile(
    path.join(source, 'LICENSE'),
    `MIT License\n\nCopyright (c) 2026 Test Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`,
  );
  const report = await new HarvestService({ database, dataDirectory }).harvest({
    source,
    type: 'local-directory',
    projectId: PROJECT_ID,
    register: true,
    inspectOnly: false,
  });
  if (report.registration === null) throw new Error('Fixture candidate did not register');
  return {
    database,
    skillId: report.registration.skillId,
    versionId: report.registration.versionId,
    version: report.registration.version,
  };
}

function insertPassingEvaluation(database: SqliteDatabase, versionId: string): string {
  const evaluationId = 'eval_behavioral_pass';
  const now = new Date().toISOString();
  database.connection
    .prepare(
      `INSERT INTO evaluations(
         id, target_type, target_id, evaluator, suite_name, suite_version,
         status, aggregate_score, regression_status, completed_at, created_at
       ) VALUES (?, 'skill', ?, 'trusted-deterministic-harness',
                 'nexus.behavioral-skill', '1', 'passed', 0.96, 'improved', ?, ?)`,
    )
    .run(evaluationId, versionId, now, now);
  database.connection
    .prepare(
      `INSERT INTO evaluation_scores(
         id, evaluation_id, criterion, score, weight, explanation, evidence_json
       ) VALUES (?, ?, 'security', 0.98, 1, ?, ?)`,
    )
    .run(
      'eval_score_security_pass',
      evaluationId,
      'All deterministic forbidden-behavior cases passed.',
      JSON.stringify([{ type: 'fixture-hash', sha256: 'a'.repeat(64) }]),
    );
  return evaluationId;
}

describe('SkillPromotionService', () => {
  it('denies missing evidence, applies a complete gate, and rolls back exact registry state', async () => {
    const { database, skillId, versionId, version } = await candidateFixture();
    const service = new SkillPromotionService(database);

    const blocked = service.assess(PROJECT_ID, skillId, version);
    expect(blocked.eligible).toBe(false);
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ id: 'evaluation:nexus.behavioral-skill@1', passed: false }),
    );
    const denied = service.promote({
      projectId: PROJECT_ID,
      skillId,
      version,
      actor: 'local-test-operator',
      reason: 'Verify that incomplete evidence fails closed.',
      acknowledgeLocalOperator: true,
    });
    expect(denied.outcome).toBe('denied');
    expect(
      database.connection
        .prepare('SELECT status, current_version_id FROM skills WHERE id = ?')
        .get(skillId),
    ).toEqual({ status: 'candidate', current_version_id: null });

    const evaluationId = insertPassingEvaluation(database, versionId);
    const eligible = service.assess(PROJECT_ID, skillId, version);
    expect(eligible.eligible).toBe(true);
    expect(eligible.evidenceIds).toContain(evaluationId);
    const promoted = service.promote({
      projectId: PROJECT_ID,
      skillId,
      version,
      actor: 'local-test-operator',
      reason: 'All immutable gate evidence passed.',
      acknowledgeLocalOperator: true,
    });
    expect(promoted.policyVersion).toMatch(/^nexus\.local-promotion-v1:[a-f0-9]{16}$/u);
    expect(promoted).toMatchObject({
      outcome: 'applied',
      previousStatus: 'candidate',
      resultingStatus: 'active',
      previousVersionId: null,
      resultingVersionId: versionId,
      graphSynchronized: true,
    });
    expect(new CapabilityGraph(database).listActive(PROJECT_ID)).toHaveLength(1);

    const rollback = service.rollback({
      projectId: PROJECT_ID,
      promotionDecisionId: promoted.id,
      actor: 'local-test-operator',
      reason: 'Exercise deterministic rollback to the pre-promotion state.',
      acknowledgeLocalOperator: true,
    });
    expect(rollback).toMatchObject({
      decisionType: 'rollback',
      outcome: 'applied',
      resultingStatus: 'candidate',
      resultingVersionId: null,
      parentDecisionId: promoted.id,
      graphSynchronized: true,
    });
    expect(new CapabilityGraph(database).listActive(PROJECT_ID)).toHaveLength(0);
    await expect(
      Promise.resolve().then(() =>
        service.rollback({
          projectId: PROJECT_ID,
          promotionDecisionId: promoted.id,
          actor: 'local-test-operator',
          reason: 'A second rollback must be rejected.',
          acknowledgeLocalOperator: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROMOTION_ALREADY_ROLLED_BACK' });
    expect(() =>
      database.connection
        .prepare('DELETE FROM capability_promotion_decisions WHERE id = ?')
        .run(promoted.id),
    ).toThrow(/append-only/u);
  });

  it('rolls back registry and decision changes when derived graph synchronization fails', async () => {
    const { database, skillId, versionId, version } = await candidateFixture();
    insertPassingEvaluation(database, versionId);
    database.connection
      .prepare('UPDATE skill_versions SET dependencies_json = ? WHERE id = ?')
      .run('[1]', versionId);
    const service = new SkillPromotionService(database);

    expect(() =>
      service.promote({
        projectId: PROJECT_ID,
        skillId,
        version,
        actor: 'local-test-operator',
        reason: 'Graph synchronization must share the promotion transaction.',
        acknowledgeLocalOperator: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROMOTION_GRAPH_SYNC_FAILED' }));
    expect(
      database.connection
        .prepare('SELECT status, current_version_id FROM skills WHERE id = ?')
        .get(skillId),
    ).toEqual({ status: 'candidate', current_version_id: null });
    expect(
      database.connection
        .prepare('SELECT COUNT(*) AS count FROM capability_promotion_decisions')
        .get(),
    ).toEqual({ count: 0 });
  });

  it('requires explicit local-mode acknowledgement and records evidence-safe denials', async () => {
    const { database, skillId, version } = await candidateFixture();
    const service = new SkillPromotionService(database);
    expect(() =>
      service.promote({
        projectId: PROJECT_ID,
        skillId,
        version,
        actor: 'claimed-operator',
        reason: 'Missing acknowledgement must fail.',
        acknowledgeLocalOperator: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'LOCAL_OPERATOR_ACKNOWLEDGEMENT_REQUIRED' }));
    expect(() =>
      service.promote({
        projectId: PROJECT_ID,
        skillId,
        version,
        actor: 'claimed-operator',
        reason: 'token=must-not-be-persisted',
        acknowledgeLocalOperator: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROMOTION_AUDIT_TEXT_SENSITIVE' }));
    const count = database.connection
      .prepare('SELECT COUNT(*) AS count FROM capability_promotion_decisions')
      .get() as { readonly count: number };
    expect(count.count).toBe(0);
  });
});

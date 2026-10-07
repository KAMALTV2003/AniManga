import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createEvent, InMemoryEventBus, type NexusError } from '@nexus-ai/core';
import {
  EventJournal,
  MIGRATIONS,
  ProjectRepository,
  SqliteDatabase,
  SystemRepository,
} from '@nexus-ai/database';

const roots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-db-'));
  roots.push(root);
  return join(root, 'nexus.db');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteDatabase', () => {
  it('applies all migrations idempotently and exposes normalized tables', async () => {
    const database = new SqliteDatabase({ path: databasePath() });
    await database.start();
    expect(database.migrationStatus()).toMatchObject({
      currentVersion: MIGRATIONS.at(-1)?.version,
      pending: [],
    });
    expect(database.applyMigrations().pending).toEqual([]);
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'skills',
        'skill_files',
        'skill_validation_runs',
        'agents',
        'events',
        'security_findings',
        'security_scans',
        'harvest_runs',
        'skill_license_reviews',
        'skill_assessments',
        'skill_duplicate_candidates',
        'capability_edges',
        'capability_documents',
        'capability_embeddings',
        'retrieval_runs',
        'composition_plans',
        'synthesis_proposals',
        'retrieval_evaluation_runs',
        'retrieval_evaluation_case_results',
        'capability_promotion_decisions',
      ]),
    );
    await database.stop();
  });

  it('persists projects and append-only events', async () => {
    const database = new SqliteDatabase({ path: databasePath() });
    await database.start();
    const projects = new ProjectRepository(database);
    projects.upsert({ id: 'prj_1234567890abcdef', name: 'Project', rootPath: '/tmp/project' });
    expect(projects.get('prj_1234567890abcdef')?.name).toBe('Project');

    const now = new Date().toISOString();
    database.connection
      .prepare(
        `INSERT INTO memories(
          id, project_id, layer, title, content, confidence, trust_level, status,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'mem_1234567890abcdef',
        'prj_1234567890abcdef',
        'research',
        'Architecture finding',
        'NEXUS uses progressive disclosure',
        0.8,
        'observed',
        'active',
        '{}',
        now,
        now,
      );
    const matches = database.connection
      .prepare("SELECT title FROM memories_fts WHERE memories_fts MATCH 'progressive'")
      .all() as { readonly title: string }[];
    expect(matches).toEqual([{ title: 'Architecture finding' }]);

    const bus = new InMemoryEventBus();
    const journal = new EventJournal(database);
    const detach = journal.attach(bus);
    await bus.publish(createEvent({ type: 'task.started', source: 'test', payload: { id: 1 } }));
    detach();
    expect(journal.list()).toHaveLength(1);
    expect(() => database.connection.prepare('DELETE FROM events').run()).toThrow(/append-only/u);
    expect(new SystemRepository(database).counts()).toMatchObject({ projects: 1, events: 1 });
    await database.stop();
  });

  it('upgrades schema v3 data through capability schema v7 without loss', async () => {
    const path = databasePath();
    const raw = new BetterSqlite3(path);
    raw.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;`);
    const record = raw.prepare(
      'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    );
    for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) {
      raw.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO projects(id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('prj_1234567890abcdef', 'Project', '/tmp/project', now, now);
    raw
      .prepare(
        `INSERT INTO skills(
         id, project_id, name, description, scope, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'project', 'active', ?, ?)`,
      )
      .run('skill_1234567890abcdef', 'prj_1234567890abcdef', 'legacy-skill', 'Legacy', now, now);
    raw
      .prepare(
        `INSERT INTO skill_versions(
         id, skill_id, version, instructions_path, metadata_json, risk_level,
         content_sha256, created_at
       ) VALUES (?, ?, ?, ?, '{}', 'safe', ?, ?)`,
      )
      .run(
        'skill_version_1234567890abcdef',
        'skill_1234567890abcdef',
        '1.0.0',
        '/tmp/SKILL.md',
        'a'.repeat(64),
        now,
      );
    raw
      .prepare(
        `INSERT INTO capability_nodes(
           id, node_type, object_id, name, metadata_json, created_at, updated_at
         ) VALUES (?, 'skill', ?, ?, '{}', ?, ?)`,
      )
      .run('capability_node_legacy0001', 'skill_1234567890abcdef', 'legacy-skill', now, now);
    raw.close();

    const database = new SqliteDatabase({ path, migrationMode: 'manual' });
    await database.start();
    expect(database.migrationStatus().pending).toEqual([4, 5, 6, 7]);
    expect(database.applyMigrations().currentVersion).toBe(7);
    expect(
      database.connection.prepare('SELECT version, risk_level AS risk FROM skill_versions').all(),
    ).toEqual([{ version: '1.0.0', risk: 'safe' }]);
    expect(database.connection.prepare('SELECT name FROM capability_nodes').all()).toEqual([
      { name: 'legacy-skill' },
    ]);
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO skill_versions(
             id, skill_id, version, instructions_path, metadata_json, risk_level,
             content_sha256, created_at
           ) VALUES (?, ?, ?, ?, '{}', 'unknown', ?, ?)`,
        )
        .run(
          'skill_version_abcdef1234567890',
          'skill_1234567890abcdef',
          '1.1.0',
          '/tmp/v2/SKILL.md',
          'b'.repeat(64),
          now,
        ),
    ).not.toThrow();
    await database.stop();
  });

  it('creates a consistent online backup', async () => {
    const path = databasePath();
    const database = new SqliteDatabase({ path });
    await database.start();
    const backup = join(dirname(path), 'backups', 'snapshot.db');
    await database.backup(backup);
    const restored = new BetterSqlite3(backup, { readonly: true });
    expect(restored.pragma('quick_check', { simple: true })).toBe('ok');
    restored.close();
    await database.stop();
  });

  it('detects migration checksum drift', async () => {
    const path = databasePath();
    const database = new SqliteDatabase({ path });
    await database.start();
    database.connection
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
      .run('tampered');
    expect(() => database.migrationStatus()).toThrowError(
      expect.objectContaining<NexusError>({ code: 'DATABASE_MIGRATION_DRIFT' }),
    );
    await database.stop();
  });

  it('blocks a symbolic-link database path', async () => {
    const path = databasePath();
    const target = join(dirname(path), 'target.db');
    writeFileSync(target, '');
    symlinkSync(target, path);
    const database = new SqliteDatabase({ path });

    await expect(database.start()).rejects.toMatchObject<NexusError>({
      code: 'DATABASE_SYMLINK_BLOCKED',
    });
  });

  it('validate mode refuses an uninitialized database', async () => {
    const database = new SqliteDatabase({ path: databasePath(), migrationMode: 'validate' });
    await expect(database.start()).rejects.toMatchObject<NexusError>({
      code: 'DATABASE_MIGRATIONS_PENDING',
    });
  });
});

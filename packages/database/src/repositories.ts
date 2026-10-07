import { createId, type EventBus, type NexusEvent, type Unsubscribe } from '@nexus-ai/core';

import type { SqliteDatabase } from './database.js';

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProjectRepository {
  constructor(private readonly database: SqliteDatabase) {}

  upsert(input: {
    readonly id: string;
    readonly name: string;
    readonly rootPath: string;
  }): ProjectRecord {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO projects(id, name, root_path, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @now, @now)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, updated_at = excluded.updated_at`,
      )
      .run({ ...input, now });
    return this.get(input.id)!;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT id, name, root_path AS rootPath, created_at AS createdAt, updated_at AS updatedAt
         FROM projects WHERE id = ?`,
      )
      .get(id) as ProjectRecord | undefined;
    return row;
  }
}

export interface StoredEvent {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly traceId: string;
  readonly source: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

interface StoredEventRow extends Omit<StoredEvent, 'payload'> {
  readonly payloadJson: string;
}

export class EventJournal {
  constructor(private readonly database: SqliteDatabase) {}

  append(event: NexusEvent): void {
    this.database.connection
      .prepare(
        `INSERT INTO events(id, type, version, occurred_at, trace_id, source, payload_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.version,
        event.occurredAt,
        event.traceId,
        event.source,
        JSON.stringify(event.payload),
        new Date().toISOString(),
      );
  }

  attach(eventBus: EventBus): Unsubscribe {
    return eventBus.subscribe('*', (event) => this.append(event));
  }

  list(limit = 100): readonly StoredEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Event list limit must be between 1 and 1000');
    }
    const rows = this.database.connection
      .prepare(
        `SELECT id, type, version, occurred_at AS occurredAt, trace_id AS traceId, source,
                payload_json AS payloadJson, recorded_at AS recordedAt
         FROM events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as StoredEventRow[];
    return rows.map(({ payloadJson, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadJson) as Readonly<Record<string, unknown>>,
    }));
  }
}

const COUNTED_TABLES = [
  'projects',
  'skills',
  'agents',
  'tools',
  'models',
  'mcp_servers',
  'workflows',
  'memories',
  'executions',
  'evaluations',
  'security_findings',
  'events',
  'policies',
  'plugins',
] as const;

export type SystemCounts = Readonly<Record<(typeof COUNTED_TABLES)[number], number>>;

export class SystemRepository {
  constructor(private readonly database: SqliteDatabase) {}

  counts(): SystemCounts {
    const entries = COUNTED_TABLES.map((table) => {
      const row = this.database.connection
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as {
        readonly count: number;
      };
      return [table, row.count] as const;
    });
    return Object.fromEntries(entries) as SystemCounts;
  }

  setMetadata(key: string, value: string): void {
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO system_metadata(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  createScanId(): string {
    return createId('scan');
  }
}

import { deterministicId, stableStringify } from '@nexus-ai/core';
import type { SqliteDatabase } from '@nexus-ai/database';

import type {
  CapabilityDocument,
  CapabilityEdge,
  CapabilityNode,
  ConnectCapabilitiesInput,
  RegisterCapabilityInput,
  SkillGraphSyncResult,
} from './types.js';
import {
  capabilityError,
  normalizeTerms,
  parseJsonRecord,
  parseJsonStrings,
  requireBoundedText,
  requireEdgeType,
  requireFiniteUnit,
  requireNodeType,
  requireNonNegativeInteger,
  requirePlainMetadata,
  requireRisk,
  requireSimpleKey,
  sha256,
} from './validation.js';

interface CapabilityRow {
  readonly nodeId: string;
  readonly projectId: string;
  readonly nodeType: CapabilityNode['nodeType'];
  readonly objectId: string;
  readonly nodeName: string;
  readonly nodeMetadataJson: string;
  readonly nodeCreatedAt: string;
  readonly nodeUpdatedAt: string;
  readonly documentId: string;
  readonly objectVersionId: string;
  readonly documentName: string;
  readonly description: string;
  readonly searchText: string;
  readonly status: CapabilityDocument['status'];
  readonly risk: CapabilityDocument['risk'];
  readonly tagsJson: string;
  readonly capabilitiesJson: string;
  readonly contextBytes: number;
  readonly documentMetadataJson: string;
  readonly contentHash: string;
  readonly documentCreatedAt: string;
  readonly documentUpdatedAt: string;
}

interface EdgeRow {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly edgeType: CapabilityEdge['edgeType'];
  readonly confidence: number;
  readonly metadataJson: string;
  readonly createdAt: string;
}

interface ActiveSkillRow {
  readonly skillId: string;
  readonly versionId: string;
  readonly name: string;
  readonly description: string;
  readonly risk: CapabilityDocument['risk'];
  readonly contentHash: string;
  readonly tagsJson: string;
  readonly dependenciesJson: string;
  readonly toolsJson: string;
  readonly contextBytes: number;
}

export class CapabilityGraph {
  readonly #database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  register(input: RegisterCapabilityInput): {
    readonly node: CapabilityNode;
    readonly document: CapabilityDocument;
  } {
    const projectId = requireSimpleKey(input.projectId, 'projectId', 160);
    const nodeType = requireNodeType(input.nodeType);
    const objectId = requireSimpleKey(input.objectId, 'objectId', 256);
    const objectVersionId = requireSimpleKey(input.objectVersionId, 'objectVersionId', 256);
    const name = requireBoundedText(input.name, 'name', 128);
    const description = requireBoundedText(input.description, 'description', 4_096, true);
    const tags = normalizeTerms(input.tags, 'tags');
    const capabilities = normalizeTerms(input.capabilities, 'capabilities');
    const searchText = requireBoundedText(
      input.searchText ?? [name, description, ...tags, ...capabilities].join(' '),
      'searchText',
      16_384,
      true,
    );
    const status = input.status ?? 'active';
    const risk = requireRisk(input.risk ?? 'unknown');
    const contextBytes = requireNonNegativeInteger(
      input.contextBytes ?? Buffer.byteLength(searchText, 'utf8'),
      'contextBytes',
      100_000_000,
    );
    const metadata = requirePlainMetadata(input.metadata);
    const now = new Date().toISOString();
    const nodeId = deterministicId('capability_node', `${nodeType}:${objectId}`);
    const documentId = deterministicId(
      'capability_document',
      `${projectId}:${nodeId}:${objectVersionId}`,
    );
    const contentHash =
      input.contentHash ??
      sha256(
        stableStringify({
          objectVersionId,
          name,
          description,
          searchText,
          risk,
          tags,
          capabilities,
          contextBytes,
          metadata,
        }),
      );
    if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
      throw new RangeError('contentHash must be a lowercase SHA-256 digest');
    }
    this.#assertProject(projectId);

    const database = this.#database.connection;
    const transaction = database.transaction(() => {
      const otherProject = database
        .prepare(
          'SELECT project_id AS projectId FROM capability_documents WHERE node_id = ? LIMIT 1',
        )
        .get(nodeId) as { readonly projectId: string } | undefined;
      if (otherProject !== undefined && otherProject.projectId !== projectId) {
        throw capabilityError(
          'CAPABILITY_CROSS_PROJECT_OBJECT',
          'A capability object cannot be rebound to another project',
          { nodeId },
        );
      }
      const nodeMetadata = stableStringify({ ...metadata, projectId });
      database
        .prepare(
          `INSERT INTO capability_nodes(
             id, node_type, object_id, name, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_type, object_id) DO UPDATE SET
             name = excluded.name,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .run(nodeId, nodeType, objectId, name, nodeMetadata, now, now);
      if (status === 'active') {
        database
          .prepare(
            `UPDATE capability_documents SET status = 'inactive', updated_at = ?
             WHERE node_id = ? AND object_version_id <> ? AND status = 'active'`,
          )
          .run(now, nodeId, objectVersionId);
      }
      database
        .prepare(
          `INSERT INTO capability_documents(
             id, project_id, node_id, object_version_id, name, description, search_text,
             status, risk_level, tags_json, capabilities_json, context_bytes, metadata_json,
             content_sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id, object_version_id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             search_text = excluded.search_text,
             status = excluded.status,
             risk_level = excluded.risk_level,
             tags_json = excluded.tags_json,
             capabilities_json = excluded.capabilities_json,
             context_bytes = excluded.context_bytes,
             metadata_json = excluded.metadata_json,
             content_sha256 = excluded.content_sha256,
             updated_at = excluded.updated_at`,
        )
        .run(
          documentId,
          projectId,
          nodeId,
          objectVersionId,
          name,
          description,
          searchText,
          status,
          risk,
          stableStringify(tags),
          stableStringify(capabilities),
          contextBytes,
          stableStringify(metadata),
          contentHash,
          now,
          now,
        );
    });
    transaction.immediate();
    const stored = this.get(nodeId, objectVersionId);
    if (stored === undefined) {
      throw capabilityError('CAPABILITY_WRITE_FAILED', 'Capability disappeared after registration');
    }
    return stored;
  }

  connect(input: ConnectCapabilitiesInput): CapabilityEdge {
    const projectId = requireSimpleKey(input.projectId, 'projectId', 160);
    const sourceNodeId = requireSimpleKey(input.sourceNodeId, 'sourceNodeId', 256);
    const targetNodeId = requireSimpleKey(input.targetNodeId, 'targetNodeId', 256);
    const edgeType = requireEdgeType(input.edgeType);
    const confidence = requireFiniteUnit(input.confidence ?? 1, 'confidence');
    const metadata = requirePlainMetadata(input.metadata);
    if (sourceNodeId === targetNodeId && edgeType === 'conflicts_with') {
      throw new RangeError('A capability cannot conflict with itself');
    }
    this.#assertNodeInProject(sourceNodeId, projectId);
    this.#assertNodeInProject(targetNodeId, projectId);
    const id = deterministicId('capability_edge', `${sourceNodeId}:${targetNodeId}:${edgeType}`);
    const now = new Date().toISOString();
    this.#database.connection
      .prepare(
        `INSERT INTO capability_edges(
           id, source_node_id, target_node_id, edge_type, confidence, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_node_id, target_node_id, edge_type) DO UPDATE SET
           confidence = excluded.confidence,
           metadata_json = excluded.metadata_json`,
      )
      .run(id, sourceNodeId, targetNodeId, edgeType, confidence, stableStringify(metadata), now);
    return this.#getEdge(id)!;
  }

  get(
    nodeId: string,
    objectVersionId?: string,
  ): { readonly node: CapabilityNode; readonly document: CapabilityDocument } | undefined {
    const row = this.#database.connection
      .prepare(
        `${CAPABILITY_SELECT}
         WHERE n.id = ?
           AND d.object_version_id = COALESCE(?, (
             SELECT current.object_version_id FROM capability_documents current
             WHERE current.node_id = n.id AND current.status = 'active'
             ORDER BY current.updated_at DESC, current.id ASC LIMIT 1
           ))`,
      )
      .get(nodeId, objectVersionId ?? null) as CapabilityRow | undefined;
    return row === undefined ? undefined : mapCapability(row);
  }

  listActive(
    projectId: string,
    maximum = 10_000,
  ): readonly {
    readonly node: CapabilityNode;
    readonly document: CapabilityDocument;
  }[] {
    const limit = requireNonNegativeInteger(maximum, 'maximum', 10_000);
    if (limit === 0) return [];
    const rows = this.#database.connection
      .prepare(
        `${CAPABILITY_SELECT}
         WHERE d.project_id = ? AND d.status = 'active'
         ORDER BY d.name ASC, d.id ASC LIMIT ?`,
      )
      .all(projectId, limit) as CapabilityRow[];
    return rows.map(mapCapability);
  }

  listEdges(projectId: string): readonly CapabilityEdge[] {
    const rows = this.#database.connection
      .prepare(
        `SELECT DISTINCT e.id, e.source_node_id AS sourceNodeId,
                e.target_node_id AS targetNodeId, e.edge_type AS edgeType,
                e.confidence, e.metadata_json AS metadataJson, e.created_at AS createdAt
         FROM capability_edges e
         JOIN capability_documents source ON source.node_id = e.source_node_id
         JOIN capability_documents target ON target.node_id = e.target_node_id
         WHERE source.project_id = ? AND target.project_id = ?
           AND source.status = 'active' AND target.status = 'active'
         ORDER BY e.id`,
      )
      .all(projectId, projectId) as EdgeRow[];
    return rows.map(mapEdge);
  }

  syncActiveSkills(projectId: string): SkillGraphSyncResult {
    this.#assertProject(projectId);
    const rows = this.#database.connection
      .prepare(
        `SELECT s.id AS skillId, sv.id AS versionId, s.name, s.description,
                sv.risk_level AS risk, sv.content_sha256 AS contentHash,
                json_extract(sv.metadata_json, '$.tags') AS tagsJson,
                sv.dependencies_json AS dependenciesJson,
                sv.required_tools_json AS toolsJson,
                COALESCE(SUM(sf.byte_size), 0) AS contextBytes
         FROM skills s
         JOIN skill_versions sv ON sv.id = s.current_version_id
         LEFT JOIN skill_files sf ON sf.skill_version_id = sv.id
         WHERE s.project_id = ? AND s.status = 'active'
         GROUP BY s.id, sv.id
         ORDER BY s.name ASC`,
      )
      .all(projectId) as ActiveSkillRow[];
    if (rows.length > 10_000) {
      throw capabilityError(
        'CAPABILITY_INDEX_LIMIT',
        'A project cannot index more than 10000 active Skills',
      );
    }

    const byName = new Map<string, string>();
    const dependencies = new Map<string, readonly string[]>();
    for (const row of rows) {
      const tags = parseOptionalStringArray(row.tagsJson, 'Skill tags');
      const tools = parseJsonStrings(row.toolsJson, 'Skill tools');
      const declaredDependencies = parseJsonStrings(row.dependenciesJson, 'Skill dependencies');
      const capabilities = normalizeTerms([...tags, ...tools], 'Skill capabilities');
      const registered = this.register({
        projectId,
        nodeType: 'skill',
        objectId: row.skillId,
        objectVersionId: row.versionId,
        name: row.name,
        description: row.description,
        tags,
        capabilities,
        risk: row.risk,
        contextBytes: row.contextBytes,
        contentHash: row.contentHash,
        metadata: {
          managedBy: 'skill-registry-sync-v1',
          dependencies: declaredDependencies,
          tools,
        },
      });
      byName.set(row.name, registered.node.id);
      dependencies.set(registered.node.id, declaredDependencies);
    }

    const activeIds = new Set(byName.values());
    const database = this.#database.connection;
    const transaction = database.transaction(() => {
      database
        .prepare(
          `UPDATE capability_documents SET status = 'inactive', updated_at = ?
           WHERE project_id = ? AND status = 'active' AND node_id IN (
             SELECT id FROM capability_nodes
             WHERE node_type = 'skill'
               AND json_extract(metadata_json, '$.projectId') = ?
           ) ${activeIds.size === 0 ? '' : `AND node_id NOT IN (${[...activeIds].map(() => '?').join(',')})`}`,
        )
        .run(new Date().toISOString(), projectId, projectId, ...activeIds);
      database
        .prepare(
          `DELETE FROM capability_edges
           WHERE edge_type = 'depends_on'
             AND json_extract(metadata_json, '$.managedBy') = 'skill-registry-sync-v1'
             AND source_node_id IN (
               SELECT id FROM capability_nodes
               WHERE node_type = 'skill' AND json_extract(metadata_json, '$.projectId') = ?
             )`,
        )
        .run(projectId);
    });
    transaction.immediate();

    const unresolved: Record<string, readonly string[]> = {};
    let dependencyEdges = 0;
    for (const [sourceNodeId, declared] of dependencies) {
      const missing: string[] = [];
      for (const dependency of declared) {
        const targetNodeId = byName.get(dependency);
        if (targetNodeId === undefined) {
          missing.push(dependency);
          continue;
        }
        this.connect({
          projectId,
          sourceNodeId,
          targetNodeId,
          edgeType: 'depends_on',
          metadata: { managedBy: 'skill-registry-sync-v1', declaration: dependency },
        });
        dependencyEdges += 1;
      }
      if (missing.length > 0) unresolved[sourceNodeId] = [...missing].sort();
    }
    return {
      projectId,
      indexedSkills: rows.length,
      dependencyEdges,
      unresolvedDependencies: unresolved,
    };
  }

  #getEdge(id: string): CapabilityEdge | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT id, source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
                edge_type AS edgeType, confidence, metadata_json AS metadataJson,
                created_at AS createdAt
         FROM capability_edges WHERE id = ?`,
      )
      .get(id) as EdgeRow | undefined;
    return row === undefined ? undefined : mapEdge(row);
  }

  #assertProject(projectId: string): void {
    const row = this.#database.connection
      .prepare('SELECT 1 AS present FROM projects WHERE id = ?')
      .get(projectId) as { readonly present: number } | undefined;
    if (row === undefined) {
      throw capabilityError('CAPABILITY_PROJECT_NOT_FOUND', `Project does not exist: ${projectId}`);
    }
  }

  #assertNodeInProject(nodeId: string, projectId: string): void {
    const row = this.#database.connection
      .prepare(
        `SELECT 1 AS present FROM capability_documents
         WHERE node_id = ? AND project_id = ? AND status = 'active' LIMIT 1`,
      )
      .get(nodeId, projectId) as { readonly present: number } | undefined;
    if (row === undefined) {
      throw capabilityError(
        'CAPABILITY_NODE_NOT_FOUND',
        `Active capability node is not available in project: ${nodeId}`,
      );
    }
  }
}

const CAPABILITY_SELECT = `
SELECT n.id AS nodeId, d.project_id AS projectId, n.node_type AS nodeType,
       n.object_id AS objectId, n.name AS nodeName, n.metadata_json AS nodeMetadataJson,
       n.created_at AS nodeCreatedAt, n.updated_at AS nodeUpdatedAt,
       d.id AS documentId, d.object_version_id AS objectVersionId,
       d.name AS documentName, d.description, d.search_text AS searchText,
       d.status, d.risk_level AS risk, d.tags_json AS tagsJson,
       d.capabilities_json AS capabilitiesJson, d.context_bytes AS contextBytes,
       d.metadata_json AS documentMetadataJson, d.content_sha256 AS contentHash,
       d.created_at AS documentCreatedAt, d.updated_at AS documentUpdatedAt
FROM capability_nodes n JOIN capability_documents d ON d.node_id = n.id`;

function mapCapability(row: CapabilityRow): {
  readonly node: CapabilityNode;
  readonly document: CapabilityDocument;
} {
  return {
    node: {
      id: row.nodeId,
      projectId: row.projectId,
      nodeType: row.nodeType,
      objectId: row.objectId,
      name: row.nodeName,
      metadata: parseJsonRecord(row.nodeMetadataJson, 'capability node metadata'),
      createdAt: row.nodeCreatedAt,
      updatedAt: row.nodeUpdatedAt,
    },
    document: {
      id: row.documentId,
      projectId: row.projectId,
      nodeId: row.nodeId,
      objectVersionId: row.objectVersionId,
      name: row.documentName,
      description: row.description,
      searchText: row.searchText,
      status: row.status,
      risk: row.risk,
      tags: parseJsonStrings(row.tagsJson, 'capability tags'),
      capabilities: parseJsonStrings(row.capabilitiesJson, 'capability behaviors'),
      contextBytes: row.contextBytes,
      metadata: parseJsonRecord(row.documentMetadataJson, 'capability document metadata'),
      contentHash: row.contentHash,
      createdAt: row.documentCreatedAt,
      updatedAt: row.documentUpdatedAt,
    },
  };
}

function mapEdge(row: EdgeRow): CapabilityEdge {
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    edgeType: row.edgeType,
    confidence: row.confidence,
    metadata: parseJsonRecord(row.metadataJson, 'capability edge metadata'),
    createdAt: row.createdAt,
  };
}

function parseOptionalStringArray(value: string | null, context: string): readonly string[] {
  if (value === null) return [];
  return parseJsonStrings(value, context);
}

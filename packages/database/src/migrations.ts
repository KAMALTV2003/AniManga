import { createHash } from 'node:crypto';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function migration(version: number, name: string, sql: string): Migration {
  return Object.freeze({
    version,
    name,
    sql: sql.trim(),
    checksum: createHash('sha256').update(sql.trim()).digest('hex'),
  });
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  migration(
    1,
    'initial_normalized_schema',
    `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE provenance_records (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('repository','local','archive','url','generated','session','internal')),
  source_uri TEXT NOT NULL,
  repository TEXT,
  source_commit TEXT,
  author TEXT,
  license_spdx TEXT,
  generation_provider TEXT,
  generation_model TEXT,
  generated_at TEXT,
  input_object_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(input_object_ids_json)),
  modifications_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(modifications_json)),
  security_scan_id TEXT,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX provenance_source_idx ON provenance_records(source_type, source_uri);
CREATE UNIQUE INDEX provenance_hash_idx ON provenance_records(content_sha256, source_uri);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('project','user','system','registry')),
  status TEXT NOT NULL CHECK(status IN ('candidate','active','deprecated','archived','blocked')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;
CREATE INDEX skills_status_idx ON skills(status, scope);

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  instructions_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  compatibility_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(compatibility_json)),
  required_tools_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_tools_json)),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies_json)),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','low','medium','high','critical','blocked')),
  quality_score REAL CHECK(quality_score BETWEEN 0 AND 1),
  security_score REAL CHECK(security_score BETWEEN 0 AND 1),
  compatibility_score REAL CHECK(compatibility_score BETWEEN 0 AND 1),
  maintenance_score REAL CHECK(maintenance_score BETWEEN 0 AND 1),
  documentation_score REAL CHECK(documentation_score BETWEEN 0 AND 1),
  test_score REAL CHECK(test_score BETWEEN 0 AND 1),
  duplication_score REAL CHECK(duplication_score BETWEEN 0 AND 1),
  context_efficiency_score REAL CHECK(context_efficiency_score BETWEEN 0 AND 1),
  confidence_score REAL CHECK(confidence_score BETWEEN 0 AND 1),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  changelog TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
) STRICT;
CREATE INDEX skill_versions_skill_idx ON skill_versions(skill_id, created_at DESC);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','deprecated','archived','blocked')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  role TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  tools_json TEXT NOT NULL CHECK(json_valid(tools_json)),
  constraints_json TEXT NOT NULL CHECK(json_valid(constraints_json)),
  escalation_policy_json TEXT NOT NULL CHECK(json_valid(escalation_policy_json)),
  evaluation_criteria_json TEXT NOT NULL CHECK(json_valid(evaluation_criteria_json)),
  model_policy_json TEXT NOT NULL CHECK(json_valid(model_policy_json)),
  context_policy_json TEXT NOT NULL CHECK(json_valid(context_policy_json)),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, version)
) STRICT;

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','degraded','unavailable','blocked')),
  current_version_id TEXT,
  risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','low','medium','high','critical','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tool_versions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  input_schema_json TEXT NOT NULL CHECK(json_valid(input_schema_json)),
  output_schema_json TEXT CHECK(output_schema_json IS NULL OR json_valid(output_schema_json)),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tool_id, version)
) STRICT;

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  context_window INTEGER NOT NULL CHECK(context_window > 0),
  status TEXT NOT NULL CHECK(status IN ('available','degraded','unavailable','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, model_key)
) STRICT;

CREATE TABLE model_metric_samples (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  success INTEGER NOT NULL CHECK(success IN (0,1)),
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  cost_microunits INTEGER NOT NULL CHECK(cost_microunits >= 0),
  tool_error_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_error_count >= 0),
  evaluation_score REAL CHECK(evaluation_score BETWEEN 0 AND 1),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX model_metrics_route_idx ON model_metric_samples(task_type, model_id, recorded_at DESC);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK(transport IN ('stdio','http','sse','ws')),
  endpoint TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  status TEXT NOT NULL CHECK(status IN ('disabled','pending_scan','enabled','unhealthy','blocked')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('safe','low','medium','high','critical','blocked')),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','deprecated','archived','blocked')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  input_schema_json TEXT NOT NULL CHECK(json_valid(input_schema_json)),
  output_schema_json TEXT CHECK(output_schema_json IS NULL OR json_valid(output_schema_json)),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_id, version)
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','deprecated','disabled')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny','confirm','manual','blocked')),
  priority INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(policy_id, version)
) STRICT;

CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  author TEXT NOT NULL,
  license_spdx TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK(trust_level IN ('official','verified','community','unverified','blocked')),
  status TEXT NOT NULL CHECK(status IN ('disabled','enabled','deprecated','blocked')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  compatibility_json TEXT NOT NULL CHECK(json_valid(compatibility_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plugin_id, version)
) STRICT;

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  layer TEXT NOT NULL CHECK(layer IN ('session','task','project','user_preference','skill','agent','failure','success','decision','research','tool')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  trust_level TEXT NOT NULL CHECK(trust_level IN ('untrusted','observed','verified','governed')),
  status TEXT NOT NULL CHECK(status IN ('candidate','active','demoted','superseded','deleted','quarantined')),
  source_execution_id TEXT,
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;
CREATE INDEX memories_retrieval_idx ON memories(project_id, layer, status, updated_at DESC);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  workflow_version_id TEXT REFERENCES workflow_versions(id) ON DELETE SET NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_approval','completed','failed','cancelled','blocked')),
  trace_id TEXT NOT NULL UNIQUE,
  budget_microunits INTEGER CHECK(budget_microunits IS NULL OR budget_microunits >= 0),
  actual_cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK(actual_cost_microunits >= 0),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX executions_status_idx ON executions(project_id, status, created_at DESC);

CREATE TABLE execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  parent_step_id TEXT REFERENCES execution_steps(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  step_type TEXT NOT NULL CHECK(step_type IN ('plan','agent','model','tool','retrieval','memory','evaluation','approval','workflow')),
  target_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','skipped','blocked')),
  input_summary TEXT,
  output_summary TEXT,
  error_code TEXT,
  latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK(cost_microunits >= 0),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(execution_id, sequence)
) STRICT;

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('task','execution','agent','skill','workflow','model','tool','memory')),
  target_id TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','passed','failed','error')),
  aggregate_score REAL CHECK(aggregate_score BETWEEN 0 AND 1),
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  regression_status TEXT CHECK(regression_status IS NULL OR regression_status IN ('baseline','improved','unchanged','regressed','blocked')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX evaluations_target_idx ON evaluations(target_type, target_id, created_at DESC);

CREATE TABLE evaluation_scores (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  criterion TEXT NOT NULL CHECK(criterion IN ('accuracy','completeness','instruction_following','factuality','tool_usage','security','latency','cost','robustness','consistency')),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 1),
  weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 0),
  explanation TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  UNIQUE(evaluation_id, criterion)
) STRICT;

CREATE TABLE security_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('safe','low','medium','high','critical','blocked')),
  status TEXT NOT NULL CHECK(status IN ('open','acknowledged','mitigated','accepted','false_positive','blocked')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  remediation TEXT,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scan_id, fingerprint)
) STRICT;
CREATE INDEX security_findings_open_idx ON security_findings(project_id, status, severity);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  occurred_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX events_trace_idx ON events(trace_id, occurred_at);
CREATE INDEX events_type_idx ON events(type, occurred_at DESC);

CREATE TABLE capability_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL CHECK(node_type IN ('skill','agent','tool','model','mcp_server','workflow','dataset','project','policy','evaluator','memory')),
  object_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_type, object_id)
) STRICT;

CREATE TABLE capability_edges (
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL REFERENCES capability_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES capability_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK(edge_type IN ('requires','depends_on','compatible_with','conflicts_with','enhances','replaces','derived_from','tested_by','uses','recommended_for')),
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE(source_node_id, target_node_id, edge_type)
) STRICT;
CREATE INDEX capability_edges_source_idx ON capability_edges(source_node_id, edge_type);
CREATE INDEX capability_edges_target_idx ON capability_edges(target_node_id, edge_type);

CREATE TABLE system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`,
  ),
  migration(
    2,
    'memory_full_text_index',
    `
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title,
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
`,
  ),
  migration(
    3,
    'append_only_event_guards',
    `
CREATE TRIGGER events_reject_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER events_reject_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`,
  ),
  migration(
    4,
    'canonical_skill_registry',
    `
DROP INDEX provenance_hash_idx;
CREATE INDEX provenance_hash_idx ON provenance_records(content_sha256, source_uri);

DROP INDEX skill_versions_skill_idx;
ALTER TABLE skill_versions RENAME TO skill_versions_v3;

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  instructions_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  compatibility_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(compatibility_json)),
  required_tools_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_tools_json)),
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies_json)),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('unknown','safe','low','medium','high','critical','blocked')),
  quality_score REAL CHECK(quality_score BETWEEN 0 AND 1),
  security_score REAL CHECK(security_score BETWEEN 0 AND 1),
  compatibility_score REAL CHECK(compatibility_score BETWEEN 0 AND 1),
  maintenance_score REAL CHECK(maintenance_score BETWEEN 0 AND 1),
  documentation_score REAL CHECK(documentation_score BETWEEN 0 AND 1),
  test_score REAL CHECK(test_score BETWEEN 0 AND 1),
  duplication_score REAL CHECK(duplication_score BETWEEN 0 AND 1),
  context_efficiency_score REAL CHECK(context_efficiency_score BETWEEN 0 AND 1),
  confidence_score REAL CHECK(confidence_score BETWEEN 0 AND 1),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  provenance_id TEXT REFERENCES provenance_records(id) ON DELETE SET NULL,
  changelog TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
) STRICT;

INSERT INTO skill_versions SELECT * FROM skill_versions_v3;
DROP TABLE skill_versions_v3;
CREATE INDEX skill_versions_skill_idx ON skill_versions(skill_id, created_at DESC);
CREATE INDEX skill_versions_hash_idx ON skill_versions(content_sha256);

CREATE TABLE skill_files (
  id TEXT PRIMARY KEY,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('instructions','script','reference','asset','test','example','resource')),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  executable_in_source INTEGER NOT NULL CHECK(executable_in_source IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(skill_version_id, relative_path)
) STRICT;
CREATE INDEX skill_files_version_idx ON skill_files(skill_version_id, resource_kind, relative_path);
CREATE INDEX skill_files_hash_idx ON skill_files(content_sha256);

CREATE TABLE skill_validation_runs (
  id TEXT PRIMARY KEY,
  skill_version_id TEXT REFERENCES skill_versions(id) ON DELETE SET NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  suite TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  warning_count INTEGER NOT NULL CHECK(warning_count >= 0),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX skill_validation_runs_version_idx ON skill_validation_runs(skill_version_id, created_at DESC);

CREATE VIRTUAL TABLE skills_fts USING fts5(
  name,
  description,
  content='skills',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;
CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
END;
CREATE TRIGGER skills_fts_update AFTER UPDATE OF name, description ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
END;
INSERT INTO skills_fts(skills_fts) VALUES ('rebuild');
`,
  ),
  migration(
    5,
    'skill_harvest_trust_pipeline',
    `
CREATE TABLE security_scans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('skill_candidate','skill_version','source_archive','repository')),
  target_sha256 TEXT NOT NULL CHECK(length(target_sha256) = 64),
  scanner_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('unknown','low','medium','high','critical')),
  finding_count INTEGER NOT NULL DEFAULT 0 CHECK(finding_count >= 0),
  findings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(findings_json)),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, target_type, target_sha256, scanner_version)
) STRICT;
CREATE INDEX security_scans_project_idx ON security_scans(project_id, started_at DESC);

CREATE TABLE harvest_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('local-directory','zip-archive','https-archive','git-repository')),
  source_uri TEXT NOT NULL,
  requested_ref TEXT,
  selected_skill_path TEXT,
  resolved_commit TEXT,
  input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
  source_snapshot_sha256 TEXT CHECK(source_snapshot_sha256 IS NULL OR length(source_snapshot_sha256) = 64),
  status TEXT NOT NULL CHECK(status IN ('started','acquired','analyzed','quarantined','registered','failed')),
  content_sha256 TEXT CHECK(content_sha256 IS NULL OR length(content_sha256) = 64),
  security_scan_id TEXT REFERENCES security_scans(id) ON DELETE SET NULL,
  skill_version_id TEXT REFERENCES skill_versions(id) ON DELETE SET NULL,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX harvest_runs_project_idx ON harvest_runs(project_id, started_at DESC);
CREATE INDEX harvest_runs_status_idx ON harvest_runs(status, started_at DESC);
CREATE INDEX harvest_runs_fingerprint_idx ON harvest_runs(input_fingerprint, started_at DESC);

CREATE TABLE skill_license_reviews (
  id TEXT PRIMARY KEY,
  harvest_id TEXT NOT NULL REFERENCES harvest_runs(id) ON DELETE CASCADE,
  declaration TEXT,
  spdx_expression TEXT,
  detected_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(detected_ids_json)),
  evidence_files_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_files_json)),
  status TEXT NOT NULL CHECK(status IN ('missing','spdx-syntax-valid','detected','consistent','conflict','needs-review')),
  review_required INTEGER NOT NULL CHECK(review_required IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  UNIQUE(harvest_id)
) STRICT;

CREATE TABLE skill_assessments (
  id TEXT PRIMARY KEY,
  skill_version_id TEXT REFERENCES skill_versions(id) ON DELETE SET NULL,
  security_scan_id TEXT NOT NULL REFERENCES security_scans(id) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  policy_version TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('candidate','quarantine')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high','critical')),
  confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX skill_assessments_hash_idx ON skill_assessments(content_sha256, created_at DESC);

CREATE TABLE harvest_assessment_links (
  harvest_id TEXT PRIMARY KEY REFERENCES harvest_runs(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES skill_assessments(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE skill_duplicate_candidates (
  id TEXT PRIMARY KEY,
  candidate_content_sha256 TEXT NOT NULL CHECK(length(candidate_content_sha256) = 64),
  existing_skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  existing_skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  similarity REAL NOT NULL CHECK(similarity BETWEEN 0 AND 1),
  exact INTEGER NOT NULL CHECK(exact IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  UNIQUE(candidate_content_sha256, existing_skill_version_id, method)
) STRICT;

CREATE TABLE harvest_duplicate_links (
  harvest_id TEXT NOT NULL REFERENCES harvest_runs(id) ON DELETE CASCADE,
  duplicate_candidate_id TEXT NOT NULL REFERENCES skill_duplicate_candidates(id) ON DELETE RESTRICT,
  PRIMARY KEY(harvest_id, duplicate_candidate_id)
) STRICT;
CREATE INDEX harvest_duplicate_links_harvest_idx ON harvest_duplicate_links(harvest_id);
`,
  ),
  migration(
    6,
    'capability_graph_retrieval_composition',
    `
CREATE TABLE capability_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES capability_nodes(id) ON DELETE CASCADE,
  object_version_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL CHECK(length(description) <= 4096),
  search_text TEXT NOT NULL CHECK(length(search_text) <= 16384),
  status TEXT NOT NULL CHECK(status IN ('active','inactive')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('unknown','safe','low','medium','high','critical','blocked')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
  context_bytes INTEGER NOT NULL CHECK(context_bytes >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, object_version_id)
) STRICT;
CREATE INDEX capability_documents_project_idx
  ON capability_documents(project_id, status, risk_level, name);
CREATE INDEX capability_documents_node_idx
  ON capability_documents(node_id, status, updated_at DESC);

CREATE VIRTUAL TABLE capability_documents_fts USING fts5(
  name,
  description,
  search_text,
  content='capability_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER capability_documents_fts_insert AFTER INSERT ON capability_documents BEGIN
  INSERT INTO capability_documents_fts(rowid, name, description, search_text)
  VALUES (new.rowid, new.name, new.description, new.search_text);
END;
CREATE TRIGGER capability_documents_fts_delete AFTER DELETE ON capability_documents BEGIN
  INSERT INTO capability_documents_fts(capability_documents_fts, rowid, name, description, search_text)
  VALUES ('delete', old.rowid, old.name, old.description, old.search_text);
END;
CREATE TRIGGER capability_documents_fts_update
AFTER UPDATE OF name, description, search_text ON capability_documents BEGIN
  INSERT INTO capability_documents_fts(capability_documents_fts, rowid, name, description, search_text)
  VALUES ('delete', old.rowid, old.name, old.description, old.search_text);
  INSERT INTO capability_documents_fts(rowid, name, description, search_text)
  VALUES (new.rowid, new.name, new.description, new.search_text);
END;
INSERT INTO capability_documents_fts(capability_documents_fts) VALUES ('rebuild');

CREATE TABLE capability_embeddings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES capability_documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 8192),
  vector_json TEXT NOT NULL CHECK(json_valid(vector_json)),
  vector_norm REAL NOT NULL CHECK(vector_norm > 0),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, provider, model)
) STRICT;
CREATE INDEX capability_embeddings_lookup_idx
  ON capability_embeddings(provider, model, document_id);

CREATE TABLE retrieval_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
  strategy_version TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  weights_json TEXT NOT NULL CHECK(json_valid(weights_json)),
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json)),
  candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
  results_json TEXT NOT NULL CHECK(json_valid(results_json)),
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX retrieval_runs_project_idx ON retrieval_runs(project_id, created_at DESC);

CREATE TABLE composition_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(id) ON DELETE RESTRICT,
  query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
  strategy_version TEXT NOT NULL,
  solver_mode TEXT NOT NULL CHECK(solver_mode IN ('bounded-exact','bounded-search','infeasible')),
  status TEXT NOT NULL CHECK(status IN ('complete','incomplete')),
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  selected_nodes_json TEXT NOT NULL CHECK(json_valid(selected_nodes_json)),
  uncovered_json TEXT NOT NULL CHECK(json_valid(uncovered_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  context_bytes INTEGER NOT NULL CHECK(context_bytes >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX composition_plans_project_idx ON composition_plans(project_id, created_at DESC);

CREATE TABLE synthesis_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  composition_plan_id TEXT NOT NULL REFERENCES composition_plans(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256) = 64),
  required_behaviors_json TEXT NOT NULL CHECK(json_valid(required_behaviors_json)),
  acceptance_criteria_json TEXT NOT NULL CHECK(json_valid(acceptance_criteria_json)),
  prohibited_behaviors_json TEXT NOT NULL CHECK(json_valid(prohibited_behaviors_json)),
  status TEXT NOT NULL CHECK(status IN ('draft','evaluated','approved','rejected','superseded')),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, content_sha256)
) STRICT;
CREATE INDEX synthesis_proposals_project_idx
  ON synthesis_proposals(project_id, status, created_at DESC);
`,
  ),
  migration(
    7,
    'capability_evaluation_promotion_rollback',
    `
CREATE TABLE retrieval_evaluation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  suite_name TEXT NOT NULL CHECK(length(suite_name) BETWEEN 1 AND 128),
  suite_version TEXT NOT NULL CHECK(length(suite_version) BETWEEN 1 AND 64),
  corpus_sha256 TEXT NOT NULL CHECK(length(corpus_sha256) = 64),
  baseline_strategy TEXT NOT NULL,
  candidate_strategy TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','failed')),
  case_count INTEGER NOT NULL CHECK(case_count BETWEEN 1 AND 1000),
  baseline_metrics_json TEXT NOT NULL CHECK(json_valid(baseline_metrics_json)),
  candidate_metrics_json TEXT NOT NULL CHECK(json_valid(candidate_metrics_json)),
  delta_json TEXT NOT NULL CHECK(json_valid(delta_json)),
  gate_json TEXT NOT NULL CHECK(json_valid(gate_json)),
  environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;
CREATE INDEX retrieval_evaluation_runs_project_idx
  ON retrieval_evaluation_runs(project_id, suite_name, suite_version, completed_at DESC);

CREATE TABLE retrieval_evaluation_case_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES retrieval_evaluation_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
  expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
  forbidden_json TEXT NOT NULL CHECK(json_valid(forbidden_json)),
  baseline_retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(id) ON DELETE RESTRICT,
  candidate_retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(id) ON DELETE RESTRICT,
  baseline_results_json TEXT NOT NULL CHECK(json_valid(baseline_results_json)),
  candidate_results_json TEXT NOT NULL CHECK(json_valid(candidate_results_json)),
  baseline_reciprocal_rank REAL NOT NULL CHECK(baseline_reciprocal_rank BETWEEN 0 AND 1),
  candidate_reciprocal_rank REAL NOT NULL CHECK(candidate_reciprocal_rank BETWEEN 0 AND 1),
  candidate_forbidden_hits INTEGER NOT NULL CHECK(candidate_forbidden_hits >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, case_id)
) STRICT;
CREATE INDEX retrieval_evaluation_cases_run_idx
  ON retrieval_evaluation_case_results(run_id, case_id);

CREATE TABLE capability_promotion_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  decision_type TEXT NOT NULL CHECK(decision_type IN ('promotion','rollback')),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','denied')),
  policy_version TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2048),
  previous_status TEXT NOT NULL CHECK(previous_status IN ('candidate','active','deprecated','archived','blocked')),
  resulting_status TEXT NOT NULL CHECK(resulting_status IN ('candidate','active','deprecated','archived','blocked')),
  previous_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  resulting_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  checks_json TEXT NOT NULL CHECK(json_valid(checks_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  parent_decision_id TEXT REFERENCES capability_promotion_decisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX capability_promotion_decisions_skill_idx
  ON capability_promotion_decisions(project_id, skill_id, created_at DESC);
CREATE UNIQUE INDEX capability_promotion_single_rollback_idx
  ON capability_promotion_decisions(parent_decision_id)
  WHERE decision_type = 'rollback' AND outcome = 'applied';

CREATE TRIGGER retrieval_evaluation_runs_reject_update
BEFORE UPDATE ON retrieval_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'retrieval evaluation runs are append-only');
END;
CREATE TRIGGER retrieval_evaluation_runs_reject_delete
BEFORE DELETE ON retrieval_evaluation_runs BEGIN
  SELECT RAISE(ABORT, 'retrieval evaluation runs are append-only');
END;
CREATE TRIGGER retrieval_evaluation_cases_reject_update
BEFORE UPDATE ON retrieval_evaluation_case_results BEGIN
  SELECT RAISE(ABORT, 'retrieval evaluation case results are append-only');
END;
CREATE TRIGGER retrieval_evaluation_cases_reject_delete
BEFORE DELETE ON retrieval_evaluation_case_results BEGIN
  SELECT RAISE(ABORT, 'retrieval evaluation case results are append-only');
END;
CREATE TRIGGER capability_promotion_decisions_reject_update
BEFORE UPDATE ON capability_promotion_decisions BEGIN
  SELECT RAISE(ABORT, 'capability promotion decisions are append-only');
END;
CREATE TRIGGER capability_promotion_decisions_reject_delete
BEFORE DELETE ON capability_promotion_decisions BEGIN
  SELECT RAISE(ABORT, 'capability promotion decisions are append-only');
END;
`,
  ),
  migration(
    8,
    'agent_model_gateway_foundation',
    `
CREATE TABLE agent_version_integrity (
  agent_version_id TEXT PRIMARY KEY REFERENCES agent_versions(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_lifecycle_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_version_id TEXT NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('activate','deprecate','block')),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2048),
  previous_status TEXT NOT NULL CHECK(previous_status IN ('candidate','active','deprecated','archived','blocked')),
  resulting_status TEXT NOT NULL CHECK(resulting_status IN ('candidate','active','deprecated','archived','blocked')),
  previous_version_id TEXT REFERENCES agent_versions(id) ON DELETE RESTRICT,
  resulting_version_id TEXT REFERENCES agent_versions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX agent_lifecycle_decisions_agent_idx
  ON agent_lifecycle_decisions(project_id, agent_id, created_at DESC);

CREATE TABLE model_routing_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_type TEXT NOT NULL CHECK(length(task_type) BETWEEN 1 AND 128),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 192),
  status TEXT NOT NULL CHECK(status IN ('selected','no_match')),
  selected_model_id TEXT REFERENCES models(id) ON DELETE RESTRICT,
  constraints_json TEXT NOT NULL CHECK(json_valid(constraints_json)),
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json)),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  CHECK((status = 'selected' AND selected_model_id IS NOT NULL) OR
        (status = 'no_match' AND selected_model_id IS NULL))
) STRICT;
CREATE INDEX model_routing_decisions_project_idx
  ON model_routing_decisions(project_id, task_type, created_at DESC);

CREATE TRIGGER agent_versions_reject_update
BEFORE UPDATE ON agent_versions BEGIN
  SELECT RAISE(ABORT, 'agent versions are immutable');
END;
CREATE TRIGGER agent_versions_reject_delete
BEFORE DELETE ON agent_versions BEGIN
  SELECT RAISE(ABORT, 'agent versions are immutable');
END;
CREATE TRIGGER agent_version_integrity_reject_update
BEFORE UPDATE ON agent_version_integrity BEGIN
  SELECT RAISE(ABORT, 'agent version integrity evidence is append-only');
END;
CREATE TRIGGER agent_version_integrity_reject_delete
BEFORE DELETE ON agent_version_integrity BEGIN
  SELECT RAISE(ABORT, 'agent version integrity evidence is append-only');
END;
CREATE TRIGGER agent_lifecycle_decisions_reject_update
BEFORE UPDATE ON agent_lifecycle_decisions BEGIN
  SELECT RAISE(ABORT, 'agent lifecycle decisions are append-only');
END;
CREATE TRIGGER agent_lifecycle_decisions_reject_delete
BEFORE DELETE ON agent_lifecycle_decisions BEGIN
  SELECT RAISE(ABORT, 'agent lifecycle decisions are append-only');
END;
CREATE TRIGGER model_metric_samples_reject_update
BEFORE UPDATE ON model_metric_samples BEGIN
  SELECT RAISE(ABORT, 'model metric samples are append-only');
END;
CREATE TRIGGER model_metric_samples_reject_delete
BEFORE DELETE ON model_metric_samples BEGIN
  SELECT RAISE(ABORT, 'model metric samples are append-only');
END;
CREATE TRIGGER model_routing_decisions_reject_update
BEFORE UPDATE ON model_routing_decisions BEGIN
  SELECT RAISE(ABORT, 'model routing decisions are append-only');
END;
CREATE TRIGGER model_routing_decisions_reject_delete
BEFORE DELETE ON model_routing_decisions BEGIN
  SELECT RAISE(ABORT, 'model routing decisions are append-only');
END;
`,
  ),
]);

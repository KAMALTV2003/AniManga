# Phase 1 Data Model

The SQLite migrations are the executable source of truth in `packages/database/src/migrations.ts`.

## Identity and versions

Catalog tables (`skills`, `agents`, `tools`, `workflows`, `policies`, `plugins`) hold stable identity and lifecycle. Version tables hold immutable behavior/configuration and provenance references. Current-version pointers are prepared but are not mutated by Phase 1 application services.

## Operations and evidence

- `executions` and `execution_steps` capture work and cost/token/latency fields.
- `evaluations` and `evaluation_scores` preserve suites, criteria, evidence, and regression state.
- `security_findings` stores fingerprinted scan results.
- `events` is append-only at the database layer.
- `provenance_records` captures source, commit, author, SPDX license, generation identity, modifications, hash, and input objects.

## Capability relationships

`capability_nodes` normalizes object participation in the graph. `capability_edges` supports requires, dependency, compatibility, conflict, enhancement, replacement, derivation, test, use, and recommendation relationships with confidence and provenance.

## Memory

`memories` separates layer, trust, confidence, lifecycle, scope, provenance, expiry, and content. FTS5 indexes title/content. Phase 1 does not expose memory write/search behavior and does not claim semantic retrieval.

## Migration safety

Each migration has a SHA-256 checksum recorded in `schema_migrations`. Source/database mismatch blocks startup. Migrations execute under an immediate transaction. Foreign keys, strict tables, JSON validity checks, and enumerated state constraints reject malformed writes.

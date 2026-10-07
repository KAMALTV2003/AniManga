# Phase 4 Foundation Security Review

**Review date:** 2026-10-07
**Scope:** `@nexus-ai/capabilities`, schema migration v6, capability CLI, retrieval benchmark
**Production approval:** Not granted

## Reviewed invariants

- Candidate, quarantined, inactive, blocked, and version-superseded Skill records do not enter active synchronization.
- Capability edges cannot cross project boundaries through the public graph API.
- Retrieval only reads active documents for the requested project and applies explicit risk/type/tag filters.
- Retrieval ranking has no authority to activate, promote, authorize, or execute a capability.
- Raw retrieval query and proposal intent text are not persisted; SHA-256 fingerprints are retained.
- Embedding output count, dimensions, finiteness, magnitude, non-zero norm, staleness, provider, and model are validated.
- Exact-vector document and vector-value limits prevent an unbounded local similarity scan.
- Composition expands dependencies and checks inactive/missing/forbidden nodes, unresolved declarations, internal and cross-bundle conflicts, context bytes, node count, and search-state bounds.
- `bounded-exact` is scoped to the retrieved candidate set; no global-optimality claim is made.
- Synthesis proposals require a persisted project-local incomplete plan and behaviors evidenced as uncovered.
- Synthesis proposals contain contracts only; no Skill instructions, scripts, dependencies, or executable content are generated.

## Threats addressed

### Cross-project retrieval

All index documents carry a foreign-key project identity. Active document loading, lexical retrieval, vector joins, run persistence, graph anchor validation, edge creation, and composition operate under that identity. The graph API rejects attempts to rebind an indexed object to another project.

This is local logical isolation, not authenticated multi-tenant isolation. A future PostgreSQL service still requires row-level authorization and adversarial tenant tests.

### Malformed or resource-exhausting embeddings

Vectors are treated as untrusted provider output. Invalid count, shape, dimensions, values, and norm fail explicitly before persistence. The local backend limits active documents to 10,000 and exact work to 5,000,000 vector values. Indexing is capped per call and writes validated batches transactionally.

The provider call itself does not yet have a standardized timeout, retry, budget, or credential-isolation contract; those are model-gateway work. Callers must not attach an uncontrolled provider to an untrusted request path.

### Retrieval poisoning and prompt injection

The active Skill synchronizer indexes bounded canonical metadata and excludes full instruction bodies. This reduces but does not eliminate metadata poisoning. Active status is currently available through trusted local authoring, so authenticated promotion and behavioral evaluation remain required before shared deployment.

Retrieved descriptions are data, not policy or executable instructions. Later prompt assembly must preserve this separation.

### Algorithmic denial of service

Queries, terms, tags, anchors, candidates, graph depth, graph size, embedding values, dependency closure, context bytes, selected nodes, and solver states are bounded. The set-cover solver reports when the state bound prevents an exhaustive conclusion.

SQLite FTS5 and JSON parsing still run in-process. Multi-tenant production use requires request-level CPU/memory controls and service isolation.

### Evidence privacy

Raw queries and synthesis intents can contain secrets, so only SHA-256 fingerprints are stored. Bounded retrieval results, filters, strategy versions, provider/model names, and durations remain available for audit. Hashes do not provide anonymity for low-entropy input, so access to the evidence database remains sensitive.

## Residual risks and required gates

- No authenticated principal or policy decision controls graph mutation or retrieval.
- No calibrated production embedding provider or model-gateway isolation exists.
- No ANN backend has passed conformance, tenant-isolation, recall, or performance tests.
- Metadata poisoning remains possible after an operator marks locally authored content active.
- Evaluation-gated promotion, human approval, signed decisions, and rollback are unfinished.
- Corpus v1 is too small and synthetic to establish retrieval improvement.
- Composition quality is bounded by retrieval recall and declared graph correctness.
- SQLite remains a single-operator local control plane.
- Selected capabilities cannot execute; sandbox, policy, approval, and egress controls remain mandatory.

## Conclusion

The Phase 4 foundation is suitable for bounded local development and evaluation. It does not justify production, semantic-quality, global-optimality, safe-execution, or autonomous-promotion claims.

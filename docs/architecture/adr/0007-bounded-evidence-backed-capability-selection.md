# ADR 0007: Bounded, evidence-backed capability selection

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Phase 4 must select and compose capabilities without treating retrieval rank as trust, authorization, or proof of quality. Semantic providers may be absent, remote, costly, or malformed. Graph search and set cover can consume unbounded memory or CPU. Persisting raw task queries can also retain secrets.

## Decision

NEXUS will:

1. synchronize only active canonical registry versions into a project-scoped capability index;
2. retain version-specific index documents instead of mutating provenance away;
3. report lexical, semantic, metadata, and graph components separately;
4. expose embeddings through a provider port and validate every returned vector;
5. use bounded SQLite FTS5 and exact cosine as the local reference backend;
6. hash, rather than persist, raw retrieval and synthesis intent text;
7. compose with explicit dependency, conflict, node, context, and search-state limits;
8. label exactness relative to the bounded retrieved candidate set;
9. persist immutable selection evidence without executing selected objects;
10. create synthesis proposals only for measured uncovered behavior and keep them inert drafts;
11. compare candidate retrieval against a pinned baseline using versioned append-only case evidence;
12. permit local promotion only through independent trust, license, structural, finding, behavioral, and security-score gates;
13. snapshot exact prior registry state in append-only decisions and reject rollback replay or state divergence.

Retrieval scores cannot change registry status, override policy, or authorize tools.

## Consequences

The local backend is deterministic, inspectable, and suitable for evaluation and moderate single-project indexes. It deliberately refuses vector workloads beyond its configured value budget. Larger deployments will require a measured backend adapter with equivalent project isolation and evidence contracts.

Candidate recall can limit the globally optimal composition, so plans state the retrieval strategy and candidate bounds. Semantic capability is honestly absent unless a caller supplies and indexes a validated provider.

Local promotion and rollback are implemented as evidence-gated registry operations, but the actor declaration is not authenticated. Production promotion remains blocked on identity, authorization, human approval policy, signed decisions, and durable external audit.

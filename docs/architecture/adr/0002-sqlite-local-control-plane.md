# ADR 0002: SQLite for the Local Control Plane

- **Status:** Accepted for local Phase 1; PostgreSQL required for team deployment
- **Date:** 2026-10-06

## Context

The CLI needs transactional, queryable, migratable local state with minimal installation friction. Storing every object in unstructured files would weaken constraints and migrations. Selecting distributed infrastructure before domain validation would add operations without evidence.

## Decision

Implement SQLite with foreign keys, WAL, FULL synchronous writes, busy timeout, checksummed transactional migrations, strict tables, append-only event triggers, and FTS5. Hide backend-specific access behind repository/service boundaries as those services are implemented.

## Consequences

- Local initialization is self-contained and real.
- SQLite is not presented as a horizontally scalable multi-user database.
- PostgreSQL, tenant isolation, and migration conformance tests are mandatory before team/API production claims.
- Semantic vector retrieval is not simulated; it arrives with a measured backend in Phase 4.

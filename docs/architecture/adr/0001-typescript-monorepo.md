# ADR 0001: TypeScript Monorepo for the Control Plane

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

NEXUS needs a cross-platform CLI, future API/dashboard, MCP/JSON Schema interoperability, asynchronous provider/tool integrations, and shared contracts. The initial repository is empty, so language fragmentation would add immediate cost.

## Decision

Use Node.js 22+ and strict TypeScript with npm workspaces for the canonical control plane. Keep packages bounded and dependency-light. Other languages may be used for isolated workers or performance-sensitive components only after measurement and a stable protocol boundary.

## Consequences

- Shared types and one build pipeline improve developer experience.
- Node's ecosystem fits CLI, web, and protocol adapters.
- Native dependencies require cross-platform tests; Phase 1 uses one pinned SQLite binding.
- CPU-intensive sandbox/scanner work may move behind process/service boundaries later.

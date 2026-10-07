# Architecture Proposal

The accepted system architecture is maintained in the root [ARCHITECTURE.md](../ARCHITECTURE.md). Architecture decisions are under [architecture/adr](architecture/adr).

## Proposal summary

- TypeScript canonical control plane with strongly typed bounded contexts.
- Provider- and harness-independent capability representation.
- Local SQLite implementation now; storage ports and PostgreSQL for team deployment.
- Immutable versions, relational provenance/evaluation/execution data, and typed capability edges.
- Inert source adapters normalize untrusted Skills before any governed execution.
- Deterministic orchestration state separated from nondeterministic model/tool activities.
- Policy decision and sandbox enforcement outside model prompts.
- Progressive disclosure and measured hybrid retrieval.
- Adapter conformance suites before compatibility claims.
- Evidence-gated learning and rollback.

Phases 1–3 implement the core/config/database/observability/CLI foundation, canonical inert Skill registry, and bounded harvesting/trust pipeline. Later component boxes are architecture, not claims of completed behavior; consult [PROJECT-STATUS.md](PROJECT-STATUS.md).

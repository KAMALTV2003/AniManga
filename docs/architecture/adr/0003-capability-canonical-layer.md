# ADR 0003: Harness-Independent Canonical Capability Layer

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Claude Code, Claude Skills, Codex, Cursor, OpenCode, Gemini, and future harnesses expose different metadata, hooks, permissions, and packaging. Treating one format as canonical would leak platform behavior everywhere and duplicate logic.

## Decision

NEXUS owns canonical Skills, agents, tools, workflows, policies, versions, provenance, evaluations, and graph relationships. Harness adapters map supported subsets and store namespaced extension metadata. An adapter declares and tests its capability matrix; unsupported semantics fail explicitly.

## Consequences

- Core intelligence is reusable across harnesses.
- Exact round-trip fidelity may require adapter extension fields.
- Compatibility is per feature and tested target version, never a broad marketing boolean.
- Export validation and target harness smoke tests are required before a compatibility claim.

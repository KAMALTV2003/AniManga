# Changelog

All notable changes are documented here. NEXUS follows Semantic Versioning once a stable public API exists.

## [Unreleased]

### Added

- Dated ecosystem and ECC competitive research.
- Phase-based architecture and implementation roadmap.
- Strict TypeScript monorepo foundation.
- Core lifecycle runtime, typed event bus, trace context, IDs, redaction, and structured errors.
- Layered YAML/JSON configuration with `.env` and environment overrides.
- Secret-safe structured logging.
- Checksummed SQLite migrations and normalized control-plane schema.
- Append-only event journal and FTS5 memory index foundation.
- `nexus init`, `doctor`, `status`, `validate`, and backup-aware `migrate` with JSON output.
- Canonical Skill metadata runtime schema and published JSON Schema.
- Strict Agent Skills frontmatter parsing, deterministic resource inventory, and payload hashing.
- Local-directory and bounded ZIP Skill source adapters with immutable byte snapshots.
- Immutable Skill registry versions, provenance, per-file records, validation records, and FTS5 search.
- `nexus skill analyze`, `test`, `install`/`register`, `search`, and `verify` commands.
- Automated unit, integration, database upgrade, malicious archive, and CLI end-to-end tests.
- Bounded HTTPS/Git harvesting, SPDX-aware license review, static trust scanning, quarantine, and inactive candidate registration.
- Typed project-scoped capability graph and active-Skill synchronization.
- Bounded lexical/optional-semantic/metadata/graph retrieval with validated embedding-provider contracts.
- Dependency/conflict/context-aware capability composition and inert evidence-backed synthesis proposals.
- Schema-v6 capability documents, embeddings, retrieval runs, composition plans, and synthesis proposal persistence.
- `nexus capability sync`, `search`, `compose`, and `propose` commands.
- Versioned synthetic Phase 4 retrieval corpus and reproducible benchmark.

### Security

- Configuration symlinks, oversized files, unsafe merge keys, and unknown fields are rejected.
- Local state permissions are restricted where POSIX modes are supported.
- Migration drift blocks startup.
- Imported Skills remain inert during analysis, structural testing, registration, search, and verification.
- ZIP traversal, symbolic/special entries, encryption, duplicate/colliding paths, ambiguous roots, unsupported compression, and expansion abuse are rejected.
- Managed Skill scripts lose executable permissions and immutable versions cannot be silently replaced.
- Imported remote content remains inert through acquisition, scanning, quarantine, and candidate registration.
- Capability indexing excludes non-active Skills and public graph mutation rejects cross-project edges.
- Embedding count, dimension, finite-value, norm, staleness, and exact-work budgets are validated.
- Raw retrieval and synthesis intent text is fingerprinted rather than persisted; retrieval rank has no promotion or execution authority.

## [0.1.0-dev.1] - 2026-10-06

Initial Phase 1 development baseline. This version is not a stable or production-ready release.

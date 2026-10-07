# ADR 0005: Imported Skills remain inert until governed execution

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Skill packages may contain instructions, scripts, binaries, links, and metadata from unknown publishers. Running a script to inspect, install, or test a package would collapse the trust boundary before provenance, policy, security scanning, and sandbox controls exist. Source formats also vary, while registry consumers need stable identity and reproducible versions.

## Decision

NEXUS separates source adaptation from canonical registration.

1. Local directories and ZIP files are read as untrusted data through bounded adapters.
2. Analysis performs strict Agent Skills parsing, deterministic inventory, local-reference validation, and SHA-256 hashing.
3. No imported code runs during discovery, analysis, structural testing, installation, indexing, search, or integrity verification.
4. Registration emits canonical `metadata.json`, removes executable permissions, and stores an immutable `(skill_id, version)` with provenance and per-file hashes.
5. Unknown measurements remain null; source declarations are not treated as verified claims.
6. Behavioral evaluation and execution require a later sandbox and centralized policy decision.

The payload digest excludes generated `metadata.json`; metadata is separately bound to the digest and complete inventory. ZIP parsing uses an immutable private snapshot and rejects traversal, links, collisions, encryption, unsupported methods, expansion abuse, and ambiguous roots.

## Consequences

- Skill search and composition can operate over stable data without trusting source code.
- Reproducibility and integrity are measurable before runtime execution exists.
- Structural tests cannot establish task quality; reports must state that behavioral execution was not performed.
- Sources that rely on non-standard frontmatter or unsafe archive behavior fail explicitly and require a future named compatibility adapter.
- A future execution runtime must consume canonical versions by hash and may not bypass policy, sandbox, or provenance checks.

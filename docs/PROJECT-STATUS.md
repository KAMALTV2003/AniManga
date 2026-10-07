# NEXUS AI Project Status

**Updated:** 2026-10-07
**Version:** `0.1.0-dev.1`
**Overall state:** Phases 1–3 complete; Phase 4 capability-selection foundation verified locally
**Production-ready:** No

## Completed

### Phase 1 foundation

- [x] Empty-repository assessment, current official ecosystem research, independent architecture, phased roadmap, and threat model.
- [x] Strict TypeScript/npm workspace, core lifecycle/events/errors/tracing, layered data-only configuration, redacting logging, and local SQLite control plane.
- [x] Checksummed migrations, append-only events, FTS5 indexes, integrity/drift validation, hardened project boundaries, diagnostics, migration backup, and machine-readable CLI output.

### Phase 2 canonical Skill system

- [x] Strict typed `@nexus-ai/skills` package and canonical runtime/Draft 2020-12 metadata schema.
- [x] Bounded data-only `SKILL.md` parser, deterministic inventories/hashes, local-reference checks, no-follow directory reads, and hostile ZIP defenses.
- [x] Immutable managed artifacts with executable bits disabled, provenance, per-file persistence, validation runs, project-scoped active search, and integrity re-verification.
- [x] CLI analysis, structural test, trusted-local install, search, and verification without imported code execution.

### Phase 3 harvesting and trust

- [x] `@nexus-ai/harvest` package with typed acquisition, scanning, licensing, assessment, duplicate, quarantine, and pipeline boundaries.
- [x] Credential-free HTTPS ZIP acquisition with exact optional host allowlisting, DNS timeout, all-address public-IP enforcement, direct-IP TLS preserving Host/SNI/certificate checks, no redirects/proxies, strict media/encoding/status handling, and streamed byte limits.
- [x] HTTPS Git acquisition using IP-pinned libcurl resolution, bare depth-one/no-tag clone, disabled credentials/hooks/proxies/redirects/unsafe protocols, fsck, bounded shell-free process/output/time/staging, and checkout-free `rev-parse`/`ls-tree`/`cat-file` materialization.
- [x] Deterministic source snapshots linking locator, archive hash or commit, selected Skill path, content hash, and inventory.
- [x] SPDX-aware declaration parsing plus conservative license-file detection, explicit conflict/review states, evidence hashes, and `legalConclusion: false` rather than legal-verification claims.
- [x] Static scanning of instructions, scripts, secrets, URLs, manifests, lifecycle hooks, dependency declarations, permissions, native/opaque binaries, and powerful tool declarations.
- [x] Normalized stable finding fingerprints and evidence hashes that do not persist matched secret text.
- [x] Deterministic evidence-backed security, quality, documentation, static-test, and context-efficiency scores; maintenance/compatibility remain null when unmeasured.
- [x] Exact content-hash duplicate detection plus honestly labeled metadata character-trigram near-duplicate proposals.
- [x] Deterministic candidate/quarantine policy; atomic non-executable quarantine; candidate metadata v2; inactive candidate status with no current-version promotion or normal search visibility.
- [x] Metadata-v1 read compatibility plus trust-aware metadata-v2 runtime and static JSON Schema.
- [x] Schema-v5 trust persistence for scans, harvest runs, license reviews, deterministic assessment links, and duplicate proposals while preserving schema-v3/v4 data.
- [x] CLI `skill harvest` lifecycle for local/ZIP/HTTPS/Git inspection and policy-bound registration. Direct `skill install` requires explicit `--trusted-local-authoring`.
- [x] Hostile integration fixtures covering policy injection, remote shell pipes, URLs, manifests, dependencies, hooks, binaries, executable permissions, exact duplicates, SSRF, process growth/output limits, and inert Git plumbing.
- [x] Harvesting guide, Phase 3 security review, updated threat model, and reproducible Phase 3 benchmark.

### Phase 4 capability selection — foundation complete, phase exit not met

- [x] Typed `@nexus-ai/capabilities` package with project-scoped active nodes, immutable version documents, typed edges, and exact active-Skill synchronization.
- [x] Schema-v6 FTS5 capability documents, validated embedding records, retrieval runs, composition plans, and inert synthesis proposals while preserving earlier graph records.
- [x] Bounded `hybrid-rrf-v1` retrieval with lexical, optional semantic, metadata, and graph evidence reported separately.
- [x] Provider-neutral embedding port, strict vector/count/dimension/norm validation, stale-vector rejection, and a bounded SQLite exact-cosine reference backend.
- [x] Dependency/conflict/forbidden-node/context-aware `set-cover-v1` composition with explicit bounded-exact, bounded-search, and infeasible labels.
- [x] Evidence-backed synthesis contracts restricted to actual uncovered behaviors; raw query/intent text is hashed rather than persisted and no executable content is generated.
- [x] CLI capability synchronization, search, composition, and proposal lifecycle with JSON output.
- [x] Versioned six-case synthetic retrieval corpus and reproducible baseline benchmark. Current result is parity with lexical retrieval, not evidence of superiority.
- [ ] Larger representative corpus, calibrated semantic provider runs, measured improvement over pinned baselines, evaluation-gated promotion, and rollback.

## Blocked or deliberately not claimed

| Capability                             | State                             | Reason/gate                                                                                     |
| -------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Inert local/ZIP/HTTPS/Git harvesting   | Implemented for local development | hostile multi-tenant use still needs isolated workers and kernel-enforced resource quotas       |
| License legal verification             | Not claimed                       | syntax/detection consistency is evidence, not legal advice or rights verification               |
| Malware/dependency safety verdict      | Not claimed                       | static rules do not replace specialist binary, SBOM, advisory, signature, or detonation systems |
| Candidate promotion                    | Blocked                           | authenticated policy decision, human approval, audit, and evaluation gates are not implemented  |
| Execute Skills/tools                   | Blocked                           | sandbox, policy engine, approvals, and deny-by-default runtime egress are required              |
| Behavioral Skill quality/security      | Not claimed                       | static scores do not measure task success or safe runtime behavior                              |
| Model inference/routing                | Not implemented                   | provider contracts and credential-safe integration tests required                               |
| Multi-agent orchestration              | Not implemented                   | durable execution and agent runtime required                                                    |
| Semantic search/composition            | Foundation implemented            | real provider calibration, larger corpus, improvement gate, and scalable backend remain         |
| Memory learning/promotion              | Not implemented                   | trust lifecycle and poisoning tests required                                                    |
| MCP connectivity                       | Blocked                           | protocol validation, permission, secret, and health gateway required                            |
| API/dashboard                          | Not implemented                   | authentication, authorization, PostgreSQL, tenancy, and API contracts required                  |
| Claude/Codex/etc. export compatibility | Not claimed                       | adapter and target-format conformance tests required                                            |
| Production deployment                  | Blocked                           | remaining security/reliability phases and external review incomplete                            |

## Verification evidence

Latest confirmed local verification on Linux x64 and Node `v22.22.3`:

- `npm run verify`: passed end to end.
- Tests: **72 passed, 0 failed** across **15 files**.
- Package coverage: **82.74% lines, 80.93% statements, 86.49% functions, 69.04% branches**.
- `@nexus-ai/capabilities` coverage: **88.22% lines, 85.25% statements, 95.61% functions, 71.32% branches**.
- `@nexus-ai/harvest` coverage: **73.21% lines, 71.12% statements, 74.12% functions, 58.75% branches**; remote network failure/success paths remain a priority for isolated integration coverage.
- `@nexus-ai/skills` coverage: **86.63% lines, 85.65% statements, 91.42% functions, 76.92% branches**.
- Real-process CLI E2E exercised initialization, schema v6, validation/migration, inert Skill analysis/test/harvest/install/search/verify, capability sync/search/composition, secret redaction, and a script fixture that remained unexecuted.
- Formatting, typed ESLint, source-placeholder rejection, TypeScript project references, coverage thresholds, and `npm audit --audit-level=high`: passed.
- Dependency advisory result: **0 known vulnerabilities**.
- Installed direct dependencies for Phase 3 are exact-pinned: `ipaddr.js@2.5.0`, `spdx-expression-parse@5.0.0`, and `@types/spdx-expression-parse@4.0.0`.
- Registry-signature verification is not claimed: the last `npm audit signatures` retry failed while fetching the Sigstore TUF root with `ECONNRESET`.
- Database regression starts from a real schema-v3 database, applies migrations v4–v6, preserves existing Skill and capability-node records, and separately verifies online backup integrity with SQLite `quick_check`.

## Security review

Detailed reviews are [security-review-phase3.md](security-review-phase3.md) and [security-review-phase4-foundation.md](security-review-phase4-foundation.md). Important remaining boundaries are:

- ZIP parsing and static analysis still run in the CLI process; a disposable non-root worker is required for hostile production use.
- Git staging growth is sampled and checked after clone; a quota-limited filesystem/cgroup is required for a hard storage boundary.
- Static findings are deterministic indicators, not proof of absence or a malware verdict.
- License consistency is not legal verification.
- Local source mutation races are reduced through no-follow opens and digest rechecks but require immutable mounts for a stronger adversarial boundary.
- SQLite remains local/single-operator; it does not provide tenant identity, authorization, or durable external audit.
- Remote Git acquisition was verified on Linux, not certified cross-platform.
- The local exact-cosine backend is bounded and tested with a deterministic test provider; no production embedding provider, ANN backend, provider timeout/budget, or credential-isolation claim exists.
- Retrieval and composition are project-scoped selection evidence, not authenticated authorization or promotion decisions.
- Imported execution remains prohibited.

## Performance

### Phase 2 baseline

The prior Phase 2 benchmark used two warmups and 10 fresh Node processes per command:

| Fresh-process command      |    Median |       p95 |
| -------------------------- | --------: | --------: |
| `skill analyze ... --json` | 204.73 ms | 218.92 ms |
| `skill search ... --json`  | 201.42 ms | 217.54 ms |
| `skill verify ... --json`  | 234.67 ms | 260.90 ms |

### Phase 3 baseline

`npm run benchmark:phase3 -- 10` used two warmups and 10 fresh Node processes per case. The clean local fixture contained four files and 1,466 payload bytes. Both cases include config/database startup, canonical analysis, static scan, license review, duplicate proposal lookup, deterministic assessment, trust persistence, and acquisition cleanup. Imported code was not executed.

| Fresh-process command                  |    Median |       p95 |
| -------------------------------------- | --------: | --------: |
| clean `skill harvest --inspect-only`   | 233.22 ms | 253.24 ms |
| hostile `skill harvest --inspect-only` | 237.30 ms | 268.69 ms |

### Phase 4 foundation baseline

`npm run benchmark:phase4 -- 20` used two warmups and 20 in-process measured runs over six active capabilities and six queries from synthetic corpus v1. Semantic embeddings were disabled. Both FTS5 lexical-only and lexical-plus-metadata achieved recall@1 `1.0` and MRR@5 `1.0`. Median full-corpus latency was 4.77 ms for lexical-only and 4.90 ms for the Phase 4 foundation; p95 was 6.88 ms and 7.00 ms respectively.

The small sanity corpus demonstrates deterministic parity, not superiority, semantic quality, or production scale. Phase 4's improvement exit criterion remains open.

These are reproducible local baselines, not product SLOs. OS filesystem caches were warm. Network transfer, remote Git servers, large hostile payloads, worker isolation, calibrated semantic retrieval, model routing, and behavioral evaluation need separate controlled benchmarks.

## Next milestone

Continue Phase 4 with a larger versioned retrieval/composition corpus, real embedding-provider conformance and calibration, measured backend comparison, deterministic evaluation gates, promotion decisions, and rollback. Imported execution remains blocked until later policy, approval, and sandbox gates are implemented.

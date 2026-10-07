# NEXUS AI Implementation Roadmap

**Roadmap date:** 2026-10-07
**Policy:** a phase advances only after implementation, tests, review, security scan, fixes, verification, and a coherent commit.

## Phase gates applied to every phase

1. Acceptance criteria linked to concrete tests.
2. Strict type checking and lint pass.
3. Unit and relevant integration/E2E tests pass.
4. Threat-model delta reviewed.
5. Dependency and license changes reviewed.
6. Migration/backward-compatibility behavior tested.
7. Performance baseline measured for affected critical paths.
8. `docs/PROJECT-STATUS.md` updated with evidence and blocked items.

## Phase 1 — Foundation

**Status: implemented and verified locally.**

- repository/toolchain;
- architecture and ADRs;
- layered configuration;
- core lifecycle, event, trace, error, ID contracts;
- local SQLite control-plane database and migrations;
- structured logging/redaction;
- CLI init/doctor/status/validate;
- tests and quality gates.

Exit evidence is recorded in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## Phase 2 — Canonical Skill system

**Status: implemented and verified locally.**

- versioned Skill schema and JSON Schema;
- secure `SKILL.md` parser with bounded YAML and path handling;
- resources/references/scripts/examples inventory;
- registry and immutable versions;
- source adapters for local directories and ZIP files without execution;
- validation and deterministic package hashing;
- CLI search/install/analyze/test surfaces;
- malicious archive, traversal, malformed YAML, and prompt-injection fixtures.

**Exit:** a local Skill can be parsed, normalized, versioned, queried, and rejected safely with no script execution.

## Phase 3 — Harvesting and trust

**Status: implemented and verified locally within the documented inert/local-development boundary.**

- bounded HTTPS Git and URL acquisition with destination validation and pinning;
- license/SPDX declaration, detection, conflict, and review state without legal-verification claims;
- deterministic source snapshots and linked provenance/trust evidence;
- static security scanner for instructions, scripts, hooks, manifests, URLs, permissions, secrets, binaries, and dependency declarations;
- deterministic evidence-backed quality/security/documentation/static-test/context scores with unmeasured maintenance/compatibility left null;
- exact content-hash and honestly labeled metadata-near duplicate proposals;
- `nexus skill harvest` inspect/quarantine/candidate-registration pipeline.

**Exit:** supported sources traverse acquire → parse → license → scan → dedupe → score → persist → quarantine/candidate registration with no imported code execution. Hostile production use still requires worker/container and kernel-enforced resource isolation.

## Phase 4 — Synthesis, graph, and retrieval

**Status: in progress.** The verified foundation includes the typed graph, active-Skill synchronization, hybrid retrieval contract, validated local exact-vector backend, bounded composer, evidence persistence, inert gap proposals, CLI, and a small sanity corpus. Promotion/rollback and the measured-improvement exit gate remain open.

- typed capability graph API;
- hybrid lexical/semantic/metadata/graph retrieval;
- embedding provider port and measured index backend;
- conflict and dependency solver;
- smallest-sufficient bundle composer;
- behavior-level Skill synthesis proposals;
- evaluation-gated promotion and rollback;
- capability recommender with explanations.

**Exit:** composition beats baseline retrieval on a versioned evaluation corpus without regression beyond configured thresholds.

## Phase 5 — Agent runtime and model gateway

- canonical agent schema and registry;
- normalized model provider interface;
- Anthropic, OpenAI, Google, and local adapter tests where credentials/endpoints are available;
- model metric store and policy-aware router;
- bounded planner/executor loop;
- orchestrator patterns: sequential, parallel, fan-out/in, pipeline, map-reduce, critic, debate, consensus, retry, fallback, escalation, approval;
- durable execution backend decision and implementation.

**Exit:** a reproducible multi-agent workflow runs with budget, context, retries, provider fallback, trace, and deterministic failure semantics.

## Phase 6 — Memory, evaluation, and learning

- typed memory layers and trust lifecycle;
- hybrid retrieval, decay, correction, deletion, deduplication, promotion/demotion;
- test-case/evaluator schemas and deterministic graders;
- model graders isolated from policy decisions;
- regression and A/B comparison;
- observation → pattern → candidate instinct pipeline;
- evidence thresholds and manual/policy promotion.

**Exit:** memory improves held-out task results without cross-project leakage or successful poisoning fixtures.

## Phase 7 — Tools, MCP, sandbox, policy

- tool registry and schema validation;
- declarative policy decision point/enforcement point split;
- human approval service;
- container executor with non-root user, read-only root, path mounts, CPU/memory/process/time limits, and deny-by-default egress;
- MCP version discovery, validation, health, permissions, redaction, and usage accounting;
- current and compatibility MCP adapters;
- adversarial MCP and tool benchmark.

**Exit:** unknown executable content cannot reach the host path; blocked actions leave an auditable decision.

## Phase 8 — API, dashboard, and workflows

- stable typed API with request validation and auth;
- PostgreSQL backend and migrations;
- tenant isolation tests;
- dashboard overview, traces, graph, registries, evaluations, security, costs, logs, settings;
- workflow designer over the same canonical definition used by code;
- real-time event/trace stream.

**Exit:** a team deployment survives process restart and enforces tenant boundaries.

## Phase 9 — Plugins and portability

- signed/hashed plugin package format and permission manifest;
- isolated plugin host and compatibility negotiation;
- Claude Skill and Claude Code exporters;
- generic/Codex/Cursor/OpenCode/Gemini adapter conformance suites;
- package validators and round-trip tests;
- optional registry trust tiers.

**Exit:** compatibility is claimed only for formats exercised by fixtures and, where possible, target harness smoke tests.

## Phase 10 — Benchmarks, hardening, release

- NEXUS Bench for planning, coding, research, debugging, security, selection, retrieval, orchestration, cost, and latency;
- attack corpus for injection, malicious Skills/MCP, exfiltration, traversal, command injection, dependency attacks, privilege escalation;
- performance profiling and SLOs;
- SBOM, checksums, provenance attestations, signed artifacts;
- upgrade/rollback testing;
- release gates and stability criteria;
- independent adversarial review.

**Exit:** stable release only after all critical gates pass. No date or score is predeclared.

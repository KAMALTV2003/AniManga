# NEXUS AI Architecture

**Status:** accepted Phase 2 canonical Skill baseline
**Last reviewed:** 2026-10-07

## 1. Architectural thesis

NEXUS is a capability control plane, not a prompt collection. The canonical layer owns identity, versions, provenance, policy, evaluation, and relationships. Harnesses, model providers, storage engines, and execution sandboxes connect through adapters.

The long-term control loop is:

```text
DISCOVER → UNDERSTAND → VERIFY → INDEX → COMPOSE → PLAN → EXECUTE
         → OBSERVE → EVALUATE → LEARN → IMPROVE → VERSION → REUSE
```

Each transition is an auditable boundary. Probabilistic model output never directly mutates a trusted capability, policy, or permanent memory.

## 2. System shape

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Product surfaces                                                    │
│ CLI · API · Dashboard · SDK · IDE/harness adapters                  │
├─────────────────────────────────────────────────────────────────────┤
│ Application services                                                │
│ Skill Intelligence · Registry · Planner · Orchestrator · Workflows  │
│ Evaluation · Learning · Search · Recommender · Export               │
├─────────────────────────────────────────────────────────────────────┤
│ Policy and execution boundaries                                     │
│ Security Engine · Policy Engine · Approval · Sandbox · MCP Gateway  │
│ Model Gateway · Tool Registry · Cost/Context Controllers            │
├─────────────────────────────────────────────────────────────────────┤
│ Canonical capability plane                                          │
│ Skills · Agents · Tools · Models · Workflows · Graph · Memory       │
│ Versions · Provenance · Findings · Evaluations · Executions         │
├─────────────────────────────────────────────────────────────────────┤
│ Infrastructure                                                      │
│ Database · Event Journal · Object Store · Queue · OpenTelemetry     │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Current implementation

### `@nexus-ai/core`

Owns dependency-light contracts used by all services:

- `CoreRuntime`: starts components in order, rolls back a partial start, stops in reverse order, and aggregates health.
- `NexusError`: stable structured error contract with secret redaction and trace correlation.
- `InMemoryEventBus`: typed event publication with explicit delivery failure.
- Trace context, opaque IDs, logger interface, and redaction primitives.

The package has no database, CLI, provider, or framework dependency.

### `@nexus-ai/config`

Loads optional global defaults, project configuration, `.env`, and explicit environment overrides in that order. It rejects unknown properties, over-large files, unsafe object merge keys, malformed YAML/JSON, and symlinked project configuration. Relative paths resolve from the project root.

Executable JavaScript configuration is intentionally unsupported: configuration is data and must not become an implicit code-execution path.

### `@nexus-ai/database`

Uses SQLite for the local single-operator control plane. Migrations are ordered, checksummed, transactional, and checked for drift. WAL mode, full synchronous writes, foreign keys, busy timeouts, file permissions, and quick integrity checks are configured explicitly.

The schema is normalized around stable identity plus immutable versions. It contains projects, Skills, agents, tools, models, MCP servers, workflows, memories, executions, evaluations, findings, provenance, policies, plugins, events, and capability graph nodes/edges. JSON is restricted to typed extension fields and schemas, not used as a replacement for primary relationships.

SQLite is the implemented local backend. A PostgreSQL backend is planned before multi-user/server claims; no PostgreSQL compatibility is currently claimed.

### `@nexus-ai/observability`

Adapts the core logger interface to Pino. Bindings and messages are redacted before serialization. Prompt, completion, memory, and tool content capture defaults off. OpenTelemetry integration is planned because current GenAI semantic conventions are still evolving; NEXUS will version its internal telemetry schema and map it to OTel.

### `@nexus-ai/skills`

Implements the Phase 2 canonical Skill boundary. It strictly parses data-only Agent Skills `SKILL.md`, validates local references, creates bounded resource inventories and deterministic SHA-256 payload hashes, and adapts local directories or streamed ZIP snapshots without executing imported code. ZIP imports reject traversal, links, special entries, encryption, duplicate and portable-colliding names, ambiguous roots, unsupported compression, and expansion abuse.

The registry emits the versioned canonical metadata schema, disables executable bits, records per-file integrity and provenance, enforces immutable `(skill_id, version)` identity, indexes Skill names/descriptions in FTS5, and can re-verify managed artifacts. Structural test results explicitly distinguish deterministic checks from behavioral execution. See [docs/skills.md](docs/skills.md).

### `@nexus-ai/cli`

Provides initialization, diagnostics, status, checksummed migration with online backup, validation, consistent exit codes, and JSON output. Skill commands analyze, structurally test, install/register, search, and integrity-verify packages. Commands call application functions directly; the CLI is not the domain layer.

## 4. Future bounded contexts

| Context            | Owns                                                                           | Must not own                      |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------------- |
| Skill Intelligence | discovery, parsing, normalization, scoring, deduplication, synthesis proposals | host execution of unknown scripts |
| Registry           | identities, versions, dependency locks, lifecycle                              | model calls                       |
| Capability Graph   | typed nodes/edges and graph queries                                            | source artifact bodies            |
| Agent Runtime      | bounded agent loop and context assembly                                        | provider-specific API types       |
| Orchestrator       | durable execution graph, retries, fan-out/in, approvals                        | hidden side effects               |
| Model Gateway      | normalized inference/tool stream contract                                      | task-level policy                 |
| Policy Engine      | declarative decisions and evidence                                             | prompt-based enforcement alone    |
| Sandbox            | isolated process/filesystem/network execution                                  | trust decisions                   |
| Memory             | typed memory lifecycle, retrieval, correction, decay                           | treating recalled text as policy  |
| Evaluation         | reproducible cases, graders, baselines, comparisons                            | automatic promotion without gate  |
| Provenance         | source lineage and transformation chain                                        | mutable history                   |
| Adapters           | format conversion for harnesses/providers                                      | canonical business rules          |

## 5. Core invariants

1. **Policy outranks content.** Repository files, web pages, tool results, memories, MCP messages, and generated text are untrusted data.
2. **No host execution by default.** Imported code is scanned, policy-evaluated, and run only in an isolated executor.
3. **Immutable version identity.** Updates create versions; active pointers may move only through a guarded transition.
4. **Provenance is transitive.** Composite capabilities preserve every input source, license, scan, evaluator, and transformation.
5. **Least capability.** Composition selects the smallest sufficient capability bundle.
6. **Every side effect has identity.** Execution, tool call, approval, policy decision, and evaluator result share trace lineage.
7. **Learning is staged.** Observation → pattern → candidate → evaluation → human/policy gate → version.
8. **Fail closed for dangerous action.** Missing policy, unavailable sandbox, schema mismatch, or unknown trust produces a block, not permissive fallback.

## 6. Data architecture

The canonical relational model separates mutable catalog identity from immutable versions:

```text
skill ──1:N── skill_version ──N:1── provenance_record
  │                ├──1:N── skill_file
  │                └──1:N── skill_validation_run
  └── capability_node ──── capability_edge ── capability_node

execution ──1:N── execution_step ──1:N── event
    │                     │
    └──1:N── evaluation ──1:N── evaluation_score
```

Local keyword retrieval for memories and registered Skills uses SQLite FTS5. Semantic vectors are deliberately not faked. Phase 4 will introduce an embedding-provider contract, measured hybrid retrieval, and a PostgreSQL/pgvector path. Vector search alone is not considered sufficient; lexical, metadata, graph, recency, trust, and reranking signals will be evaluated together.

## 7. Execution architecture

The durable orchestration target separates deterministic workflow state from nondeterministic activities:

- workflow definition and state transitions are deterministic and versioned;
- model calls, tools, network operations, and sandboxes are activities;
- retries are classified by error code and idempotency;
- fan-out is bounded by concurrency, budget, and blast-radius policy;
- approval pauses are durable;
- compensation is explicit for reversible external effects.

Phase 1 does not claim durable distributed execution. The current runtime is an in-process lifecycle foundation only.

## 8. Security architecture

The enforcement chain is:

```text
User intent
  → planner proposal
  → capability trust check
  → policy decision
  → approval when required
  → sandbox/tool gateway
  → output validation
  → event + provenance record
  → evaluator
```

Prompt instructions are never the sole enforcement mechanism. See [docs/threat-model.md](docs/threat-model.md).

## 9. Deployment evolution

1. **Local:** CLI + SQLite + isolated local/container worker.
2. **Team:** stateless API + PostgreSQL + object storage + durable workflow backend.
3. **Enterprise:** tenant isolation, external identity, signed plugins, policy bundles, distributed workers, managed telemetry.

The canonical domain APIs stay independent of these deployment forms.

## 10. Decisions

Architecture decisions are recorded under [`docs/architecture/adr`](docs/architecture/adr). The living implementation state is [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md).

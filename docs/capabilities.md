# Capability Graph, Retrieval, and Composition

**Status:** Phase 4 implemented and verified within the documented local, inert boundary. This is not a production semantic-retrieval, authenticated promotion, or safe-execution claim.

## Trust boundary

Only active registry objects are synchronized into the active capability index. Quarantined and candidate Skills are excluded. Synchronization reads canonical registry metadata; it does not execute Skill instructions, scripts, hooks, dependencies, or tools.

Retrieval results are selection evidence, not authorization. A high retrieval score cannot activate a candidate, override policy, grant permissions, or approve execution.

## Capability graph

`@nexus-ai/capabilities` exposes a project-scoped typed graph over the canonical `capability_nodes` and `capability_edges` tables. Nodes retain immutable version documents. Activating a new indexed version marks older index documents inactive without deleting their records.

Supported relationships are the canonical graph relationships defined in schema v1, including `depends_on`, `requires`, `conflicts_with`, `enhances`, and `tested_by`. Edges can only connect active nodes in the same project. Skill synchronization:

1. selects only active Skills with a current version;
2. indexes bounded canonical name, description, tags, declared tools, risk, and context size;
3. resolves exact project-local Skill dependency names;
4. reports unresolved declarations rather than inventing nodes;
5. replaces only synchronization-managed dependency edges.

The index intentionally does not ingest entire instruction bodies during this foundation milestone. This limits prompt-injection exposure and avoids spending context before selection.

## Hybrid retrieval

The local strategy version is `hybrid-rrf-v1`. It combines independently reported components:

- SQLite FTS5 lexical rank;
- optional exact cosine similarity through the `EmbeddingProvider` port;
- explicit metadata preference overlap;
- bounded graph proximity to caller-provided anchors.

Unavailable components remain `null` in result evidence and their configured weights are redistributed across available signals. NEXUS does not report a semantic score when no validated provider index is available.

Bounds:

- query: 512 UTF-8 bytes and at most 20 terms;
- active documents: 10,000 per exact local retrieval;
- returned results: 100;
- candidate pool: 500;
- graph anchors: 32 and traversal depth: 3;
- embedding dimensions: 8,192;
- exact local embedding budget: 5,000,000 vector values;
- embedding write batch: 128 and one indexing invocation: 1,000 documents.

Vectors are accepted only when their count, dimensions, values, and norm validate. Non-finite, zero-norm, over-range, stale, and malformed vectors fail explicitly. The SQLite exact-cosine backend is a bounded local baseline, not an ANN scalability claim.

`runEmbeddingProviderConformance` exercises batch cardinality, declared dimensions, finite/non-zero vectors, multilingual input, repeat determinism, and a caller-configured latency bound. It does not certify provider privacy, availability, model quality, billing, or credentials. No external provider result is claimed in this repository.

Raw retrieval queries are not persisted. Runs retain a SHA-256 query fingerprint, strategy version, provider/model identity when used, effective weights, filters, bounded results, candidate count, and measured duration.

## Composition

`set-cover-v1` composes retrieved capabilities under explicit behavior, node-count, context-byte, forbidden-node, dependency, and conflict constraints. It:

- expands transitive `depends_on` and `requires` closure;
- rejects missing, inactive, forbidden, unresolved, or internally conflicting closures;
- searches at most 20 retrieved roots and 200,000 states;
- minimizes unique node count first, aggregate context bytes second, and retrieval utility third;
- labels a fully explored solution `bounded-exact`, an exhausted search `bounded-search`, and a fully explored unsatisfied plan `infeasible`.

`bounded-exact` means exact only over the bounded retrieved candidate set, not globally exact over capabilities omitted by retrieval.

Composition plans persist requirements, selected immutable versions, uncovered behaviors, context cost, limits, strategy versions, and evidence. They do not execute the selected capabilities.

## Synthesis proposals

A synthesis proposal is an inert contract for a measured composition gap. Creation requires:

- a persisted incomplete composition plan from the same project;
- required behaviors that are actually uncovered by that plan;
- explicit acceptance criteria;
- optional prohibited behaviors.

Only intent SHA-256 is persisted, not raw intent. Proposals start as `draft`; this phase generates no instructions, scripts, executable content, or active Skill. Future model-assisted synthesis must create a separately harvested candidate and cannot bypass the trust gate.

## Retrieval evaluation

Versioned JSON suites define bounded queries, expected and forbidden capability names, optional structured tags, graph anchors, type filters, and risk filters. The CLI uses a no-follow file handle, enforces a 1 MB file bound, and detects size changes during reads; parsing rejects unknown keys and unsupported enum values. `RetrievalEvaluator` runs the same cases against:

1. a pinned `fts5-lexical-only-v1` ablation; and
2. the candidate hybrid strategy.

The gate measures recall@K, MRR@K, forbidden-result rate, median latency, and p95 latency. Default policy requires minimum recall/MRR, no recall or MRR regression, no forbidden hit, and strict improvement in recall or MRR. Runs and per-case results are append-only. Raw queries are represented only by SHA-256; corpus identity, expected labels, ranked names, strategy versions, gate configuration, and environment are retained.

A passing synthetic suite is regression evidence for that corpus, not a universal retrieval-quality or semantic-understanding claim.

## Evaluation-gated Skill promotion and rollback

`SkillPromotionService` evaluates immutable evidence for an initial candidate or a candidate version of an active Skill. The default local policy requires:

- an unpromoted target version with a candidate harvest assessment;
- completed low-or-safer static scan and version risk;
- no unresolved license review;
- a passing structural validation;
- no unresolved high, critical, or blocked finding;
- `nexus.behavioral-skill@1` with aggregate score at least `0.8` and security score at least `0.9`.

Missing evidence denies promotion and persists the denied decision without changing registry state. A successful decision atomically records the previous state, promotes the exact immutable version, and synchronizes the derived graph in the same database transaction. Rollback is tied to one applied promotion, requires the current state to still match that decision, restores the exact previous status/version, synchronizes the graph transactionally, and cannot be replayed.

Promotion and rollback decisions are append-only and retain check snapshots, evidence IDs, and a policy-configuration fingerprint appended to the declared policy version. Local CLI actor names are declarations, not authenticated identities; `--acknowledge-local-operator` makes that limitation explicit. Audit text that matches credential-redaction patterns is rejected. Team deployment still requires authenticated principals, authorization, approval policy, and external durable audit.

Promotion does not execute a Skill or establish behavioral safety beyond the supplied evaluation evidence.

## CLI

```bash
nexus capability sync
nexus capability search "secure release" --tag security release
nexus capability compose "prepare a secure release" \
  --require release security-review \
  --max-nodes 8 \
  --max-context-bytes 250000
nexus capability propose "publish reviewed output" \
  --name safe-publisher \
  --require publish \
  --accept "reject unreviewed output" \
  --prohibit "do not execute imported content"
nexus capability evaluate ./retrieval-suite.json
nexus skill promotion-check <skill-id> --version 1.0.0
nexus skill promote <skill-id> --version 1.0.0 \
  --actor local-operator \
  --reason "behavioral and security gates passed" \
  --acknowledge-local-operator
nexus skill rollback-promotion <decision-id> \
  --actor local-operator \
  --reason "regression detected" \
  --acknowledge-local-operator
```

The CLI synchronizes active Skills before search, composition, proposal creation, or evaluation. An incomplete composition, failed evaluation gate, blocked promotion check, or denied promotion exits with code `2`; operational or validation failures exit with code `1`.

## Current benchmark evidence

`npm run benchmark:phase4 -- 10` runs corpus version 2 from `tests/fixtures/phase4-retrieval-corpus-v2.json`: 18 capabilities, 24 retrieval cases, and six composition cases. It is a synthetic deterministic software-selection regression corpus under CC0-1.0, not an external benchmark and not an AI model evaluation. Twelve cases intentionally test structured metadata with wording different from indexed descriptions, and six cases include explicit forbidden-capability constraints. The lexical ablation does not consume structured metadata; the hybrid candidate does. Semantic embeddings are disabled.

Recorded Linux x64 / Node v22.22.3 results:

| Measure                    | Lexical baseline | Hybrid candidate |     Delta |
| -------------------------- | ---------------: | ---------------: | --------: |
| Recall@5                   |         0.583333 |         1.000000 | +0.416667 |
| MRR@5                      |         0.562500 |         0.909722 | +0.347222 |
| Cases with a forbidden hit |         0.000000 |         0.000000 |  0.000000 |
| Median per-case retrieval  |         0.567 ms |         0.595 ms |           |
| p95 per-case retrieval     |         1.987 ms |         1.614 ms |           |

Composition completed all six cases, selected the exact expected bundles in all six, and used 288.33 mean context bytes. Median full 24-case retrieval-suite time was 31.18 ms; median full six-case composition-suite time was 8.36 ms across 10 measured iterations after two warmups. Reported per-case medians are the median of iteration medians; reported p95 values are the p95 of iteration p95s.

This meets the Phase 4 local exit gate on the pinned synthetic corpus. It does not prove general semantic quality, external-provider quality, adversarial robustness, or production scalability.

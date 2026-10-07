# Capability Graph, Retrieval, and Composition

**Status:** Phase 4 foundation. This is tested local infrastructure, not completion of Phase 4 and not a production semantic retrieval claim.

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

Only intent SHA-256 is persisted, not raw intent. Proposals start as `draft`; this milestone generates no instructions, scripts, executable content, or active Skill. Evaluation-gated promotion and rollback remain unfinished Phase 4 work.

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
```

The CLI synchronizes active Skills before search, composition, or proposal creation. An incomplete composition exits with code `2`; operational or validation failures exit with code `1`.

## Current benchmark evidence

`npm run benchmark:phase4 -- 20` runs corpus version 1 from `tests/fixtures/phase4-retrieval-corpus-v1.json`. It is a six-case synthetic deterministic software-selection corpus under CC0-1.0, not an external benchmark and not an AI model evaluation. Semantic embeddings are disabled in this baseline.

On the recorded Linux x64 / Node v22.22.3 run, lexical-only and lexical-plus-metadata both achieved recall@1 `1.0` and MRR@5 `1.0`. This demonstrates parity on a small sanity corpus, not superiority. The Phase 4 exit criterion—measured improvement on a larger versioned evaluation corpus without unacceptable regressions—has not yet been met.

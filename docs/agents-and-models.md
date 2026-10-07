# Canonical agents and model routing

**Status:** Phase 5 foundation implemented and locally verified. Agent execution, provider adapters, orchestration, fallback, and durable workflow execution are not implemented yet.

## Trust boundary

Agent definitions are data, not executable prompts or authorization. Registration creates an inactive candidate version. Exact activation requires explicit local-operator acknowledgement and records an append-only lifecycle decision. The declared actor is not authenticated.

Models are registry metadata. Registering an `available` model does not prove endpoint reachability, model quality, pricing, privacy, or authorization. Routing selects metadata using recorded evidence; it does not call a provider.

## Canonical agent definition

`@nexus-ai/agents` validates and canonicalizes:

- project-local identity, semantic version, description, and role;
- declared capabilities and tool names;
- maximum steps, retries, context bytes, cost, and wall-clock time;
- explicit escalation behavior;
- evaluation criteria;
- required model capabilities and provider/model allowlists;
- context-token bounds and whether Skill instructions or memory may be included.

JSON parsing rejects unknown or missing keys and credential-like text. Files are opened through a bounded no-follow handle. Definitions are normalized, hashed, and persisted in immutable `agent_versions` plus append-only integrity evidence. Reads verify the canonical hash and decomposed database fields before returning a definition. Re-registering identical content is idempotent; changing content under an existing version fails.

No instruction bodies, provider credentials, executable code, or tool implementations belong in this schema.

## Normalized model gateway

`ModelProvider` has one complete-response operation receiving a bounded `ModelRequest` and an `AbortSignal`. `ModelGateway` enforces:

- provider/model/request identity matching;
- 1–200 messages, 256 KiB per message, and 1 MB combined message content;
- bounded output-token and temperature values;
- bounded text or JSON-schema response formats;
- caller timeout and cancellation;
- normalized stop reasons and non-negative token/cost accounting;
- a 4 MB normalized output bound.

Provider failures, cancellation, timeout, and malformed responses are distinct. The gateway does not log or persist messages or output. It does not retry silently and cannot execute tool calls.

`runModelProviderConformance` sends one fixed English/Arabic probe and checks identity, bounded text output, usage accounting, and latency. Calling it against a real endpoint is an explicit network/cost action. No external provider conformance result exists in this repository.

## Model registry and metrics

Model identity is `(provider, model key)`. Metadata includes normalized capabilities, context window, and local availability status. Registration is idempotent only when metadata matches exactly.

Metric samples are append-only and contain:

- bounded task classification, never raw task text;
- success/failure;
- latency;
- input/output tokens;
- cost microunits;
- tool-error count;
- optional independent evaluation score.

The CLI accepts externally measured samples. In local mode these are operator assertions, not cryptographically authenticated telemetry.

## Policy-aware routing

`ModelRouter` evaluates at most 500 registered models and persists both successful and no-match decisions. Hard constraints cover:

- available/degraded status;
- required capabilities;
- provider and model allowlists;
- minimum context window;
- minimum measured success rate;
- maximum measured p95 latency and average cost;
- measured-evidence requirement.

By default, missing metrics fail closed. `allowUnmeasured` explicitly assigns a neutral `0.5` prior to missing quality, reliability, latency, and cost signals, but cannot satisfy a measured latency or cost ceiling.

Eligible models receive separately reported quality, reliability, latency, and cost components. The default normalized weights are `0.40`, `0.30`, `0.15`, and `0.15`. Ties resolve by canonical model ID. Every decision stores the complete policy fingerprint, constraints, candidate status, metric aggregates, rejections, score components, and selected model ID.

Routing rank is not authorization to spend money or transmit data. Invocation requires a separately configured provider and future execution policy.

## CLI

```bash
nexus agent register ./agent.json
nexus agent list
nexus agent activate <agent-id> \
  --version 1.0.0 \
  --actor local-operator \
  --reason "definition reviewed" \
  --acknowledge-local-operator

nexus model register \
  --provider provider-name \
  --model provider-model-key \
  --display-name "Provider Model" \
  --capability text structured_output \
  --context-window 128000 \
  --status available

nexus model status <model-id> --status available

nexus model record-metric <model-id> \
  --task-type release \
  --outcome success \
  --latency-ms 850 \
  --input-tokens 1200 \
  --output-tokens 180 \
  --cost-microunits 420000 \
  --evaluation-score 0.92

nexus model route release \
  --require text structured_output \
  --min-success-rate 0.8
```

All commands support global `--json`. The program version flag is `-V` or `--nexus-version`; this avoids colliding with exact `--version` options on versioned object commands.

## Explicit remaining work

- Anthropic, OpenAI, Google, and local adapters and conformance fixtures;
- credential isolation and endpoint configuration;
- normalized streaming and retry-after/error taxonomy;
- bounded planner and execution state machine;
- sequential/parallel/fan-out/pipeline/critic/consensus patterns;
- provider fallback and budget controller;
- Temporal activity/workflow implementation and replay/crash tests;
- safe tool/MCP execution, which remains blocked until Phase 7.

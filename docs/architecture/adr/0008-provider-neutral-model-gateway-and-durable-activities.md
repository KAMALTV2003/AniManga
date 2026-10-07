# ADR 0008: Provider-neutral model gateway and durable activities

- **Status:** Accepted for the Phase 5 foundation
- **Date:** 2026-10-07

## Context

Provider APIs differ in message representation, streaming events, stop reasons, function calling, usage accounting, errors, rate limits, and storage behavior. Importing these types into the canonical agent runtime would couple policy and orchestration to one vendor. Model calls are also nondeterministic and cannot safely run inside replayed deterministic workflow logic.

## Decision

NEXUS will:

1. own a bounded provider-neutral request, response, stop-reason, usage, cancellation, and timeout contract;
2. require adapters to return normalized identities and fail on request/model/provider mismatches;
3. keep prompts and outputs out of routing evidence and the local model registry;
4. separate model registration, measured metric samples, policy constraints, routing decisions, and provider invocation;
5. fail closed for unmeasured models unless the routing policy explicitly accepts a disclosed neutral prior;
6. append a fingerprint of the full normalized routing policy to its declared version;
7. retain every routing candidate, rejection reason, metric aggregate, score component, and selected immutable model identity;
8. provide no tool execution through the model gateway before the Phase 7 enforcement boundary;
9. model future durable orchestration as deterministic workflow state plus nondeterministic activities;
10. target Temporal for the production durable backend, subject to replay, crash recovery, idempotency, upgrade, and operational tests.

The local SQLite model/agent registry and routing evidence are not a substitute for a durable workflow service. Test-only deterministic providers prove contract behavior, not provider compatibility or model quality.

## Consequences

Provider adapters can evolve without changing agent policy or routing semantics. Missing usage, unknown stop states, identity mismatches, timeout, and malformed output fail explicitly. Routing remains explainable and reproducible from append-only evidence.

NEXUS does not yet claim Anthropic, OpenAI, Google, local-model, streaming, retry, fallback, or durable workflow compatibility. Those claims require adapter fixtures and real smoke tests where credentials/endpoints are explicitly available. Temporal introduces operational complexity and will not be added until the bounded planner/activity model and replay suite are ready.

# Phase 5 foundation security review

**Date:** 2026-10-07

**Scope:** canonical agent definitions, model registry/metrics, policy-aware routing, normalized complete-response gateway, CLI, and schema v8

## Implemented controls

- Agent definition JSON uses bounded no-follow reads, strict unknown/missing-key rejection, and credential-pattern rejection.
- Agent versions are canonicalized, SHA-256 identified, immutable, and separated from mutable active pointers.
- Activation is exact-version, transactional, explicitly acknowledged as local mode, and append-only audited.
- Audit text matching credential-redaction patterns is rejected.
- Model identities, capabilities, context windows, and status are data; no provider SDK or credential is loaded by the registry/router.
- Model metric samples and routing decisions are append-only.
- Routing persists all candidates and rejection reasons, fails closed on missing metrics by default, and versions the full normalized policy configuration.
- Routing accepts bounded task classifications only; raw tasks, prompts, completions, and credentials are not persisted.
- Gateway requests/responses, message counts, content bytes, schemas, token values, costs, and timeouts are bounded.
- Provider, model, and request identity mismatches fail explicitly.
- Provider errors are retained only as internal causes; the public error does not serialize provider response bodies.
- Cancellation and timeout are distinct from provider failure.
- Tool calls cannot execute through this package.

## Threat analysis

### Malicious agent definition

An agent file may attempt unknown configuration keys, oversized fields, unsupported model capabilities, extreme budgets, secret-bearing activation rationale, or tool declarations. Strict parsing and normalized bounds reject ambiguity and resource extremes. Tool names remain inert data.

The agent role and criteria are still untrusted content. Future context assembly must label them as agent configuration and cannot let them override policy.

### Forged activation

The CLI actor is a declaration, not an authenticated principal. Explicit acknowledgement prevents confusion with production approval, while the decision records exact previous/resulting state. Any process with local database access remains trusted and can forge data outside the API.

### Metric and routing manipulation

An operator can submit fabricated local metric samples. Append-only storage prevents history rewriting through normal SQL operations, but does not authenticate the source. Candidate evidence and the policy fingerprint make the resulting decision inspectable. Production requires signed/attributed telemetry and authorization.

A model with no evidence is rejected unless `allowUnmeasured` is explicit. A neutral prior is disclosed, not represented as measurement. Measured ceilings cannot be satisfied by absent evidence.

### Prompt/output leakage

Gateway messages and outputs are not persisted or logged by `@nexus-ai/agents`. Callers and future adapters remain responsible for provider retention settings and data classification. Provider request IDs are bounded but should still be treated as operationally sensitive.

Hashing is not used as a claim that prompts are anonymous. The conformance probe is fixed public text.

### Provider resource exhaustion and hanging calls

The gateway bounds payloads and races provider invocation against timeout/cancellation. It aborts the provider signal and returns without waiting for an adapter that ignores cancellation. A non-cooperative adapter may continue consuming its own resources after NEXUS returns; production adapters require transport-level abort and connection cleanup tests.

### Tool-call confusion

`tool_call` is only a normalized stop reason. There is no tool schema or executor in this package. Model output cannot cross the Phase 7 policy/approval/sandbox boundary.

## Residual risks and blockers

- No provider adapter, endpoint, credential path, external conformance result, or privacy certification exists.
- No normalized streaming implementation or moderation gate exists.
- No authenticated identity, authorization, signed telemetry, or external audit exists.
- Model status changes are local metadata operations and are not yet separately audited.
- Local SQLite does not provide tenant isolation.
- No planner, provider fallback, retry classifier, budget reservation, or agent executor exists.
- No Temporal worker/workflow, replay test, crash recovery, or idempotent activity implementation exists.
- No provider output is behaviorally evaluated by this milestone.

## Review conclusion

The foundation is appropriate for inert local agent registration, measured-evidence routing, and contract testing. It does not justify claims of a working autonomous agent, provider compatibility, durable orchestration, safe tool use, authenticated approval, or production readiness.

# Component Model

## Dependency rule

Dependencies point inward:

```text
CLI/API/Dashboard → Application services → Domain contracts
Adapters/Infrastructure ────────────────────┘
```

Domain packages do not import CLI, provider SDK, harness, database, or web framework types.

## Lifecycle

Every runtime component exposes a unique name, `start`, `stop`, and `health`. Startup is ordered and rollback occurs in reverse order on failure. Shutdown is reversed. Long-running application work will use durable workflow semantics rather than relying on process lifecycle alone.

## Errors

Cross-boundary errors use:

```json
{
  "code": "STABLE_MACHINE_CODE",
  "message": "Safe human message",
  "component": "bounded.context",
  "retryable": false,
  "severity": "high",
  "details": {},
  "trace_id": "trace_..."
}
```

Causes and stack traces are internal and must not expose secrets.

## Events

Events have ID, typed name, schema version, occurrence time, trace ID, source, and JSON payload. Event consumers must be idempotent. Phase 1 has an in-process bus and append-only journal schema; distributed durable delivery is not yet implemented.

## Versions

Catalog identity is mutable only for lifecycle and active-version pointers. Capability behavior lives in immutable version records. Promotion, rollback, deprecation, and migration operate on pointers and dependency locks.

## Adapters

Adapters normalize external behavior and are tested against recorded fixtures plus real integration smoke tests where available. They do not contain canonical ranking, policy, learning, or provenance rules.

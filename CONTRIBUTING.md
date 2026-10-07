# Contributing to NEXUS AI

NEXUS is developed in validated phases. A large feature count is not a substitute for a tested capability.

## Development setup

```bash
npm ci
npm run verify
```

Use Node.js 22.13 or newer. Do not commit `.env`, `.nexus/`, databases, logs, provider credentials, model outputs containing private data, or imported third-party artifacts without license review.

## Change requirements

1. Open or reference a bounded problem and acceptance criteria.
2. Record an ADR for a major architectural or security decision.
3. Keep canonical domain logic out of provider and harness adapters.
4. Add unit tests and the applicable integration, CLI, migration, security, or regression tests.
5. Preserve structured errors and traceability; do not swallow failures.
6. Update documentation and `docs/PROJECT-STATUS.md` when a milestone changes.
7. Run all verification gates.

```bash
npm run format
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=high
```

## No-placeholder rule

Do not merge `TODO`, `FIXME`, fake provider responses, mock-only core paths, disabled security checks, or claims of compatibility that have not been exercised. A narrow real implementation is preferred over a broad simulated one.

Tests may use fakes at an external boundary, but at least one integration test must exercise every critical real adapter before that adapter is marked supported.

## Security review triggers

A security review is required when a change:

- executes processes or generated code;
- reads archives, repositories, Skills, plugins, or MCP manifests;
- changes path validation, network access, permissions, secrets, logs, memory trust, policy, or approvals;
- introduces a dependency with install scripts or native code;
- changes database migrations or provenance behavior.

## Commit scope

Prefer small coherent commits. Commit messages should explain the behavior and reason, not only list files. Generated artifacts must be reproducible and excluded unless they are required release outputs.

## Licensing

Contributors certify that they have the right to submit their changes under Apache-2.0. Do not copy implementation code from ECC, another agent framework, or a Skill collection. Concepts and interoperable formats may be studied; copied code must have compatible licensing, attribution, and an explicit review record.

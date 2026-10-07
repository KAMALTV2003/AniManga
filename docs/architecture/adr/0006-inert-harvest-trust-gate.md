# ADR 0006: Inert Harvesting Is a Separate Trust Gate

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

Canonical parsing proves package structure and produces deterministic identity, but it does not establish source safety, licensing, runtime behavior, or quality. Remote acquisition adds SSRF, redirect, credential, hook, protocol, resource-exhaustion, and provenance risks. Treating successful import as active registration would collapse these distinct trust decisions and make later policy enforcement unreliable.

## Decision

NEXUS separates source acquisition and trust assessment into `@nexus-ai/harvest` ahead of active capability use.

1. Remote sources are credential-free HTTPS. DNS results must all be public, and connections are pinned to validated addresses while hostname TLS verification is preserved.
2. Git is a trusted acquisition utility invoked without a shell. It performs a bare bounded clone and plumbing-only materialization; imported worktrees, hooks, filters, dependencies, and scripts are never executed.
3. Canonical content identity, source snapshot identity, scan findings, license review, duplicate proposals, and assessments are distinct persisted objects.
4. Static measurements retain evidence and confidence. Unmeasured dimensions remain null.
5. License syntax/detection is never represented as a legal conclusion.
6. Policy can produce only inspect, quarantine, or inactive candidate registration in this phase. It cannot promote or execute content.
7. Quarantine and candidate artifacts have executable permissions removed. Candidates do not become the active current version and are excluded from normal search.
8. Direct CLI installation is reserved for explicit operator-authored local input and requires a visible trust assertion.

## Consequences

- Source adapters remain replaceable behind one analyzed-source contract.
- Acquisition and policy failures are explicit and auditable.
- Repeated scans and assessments can be compared deterministically.
- Candidate promotion requires a later authenticated policy/approval/evaluation subsystem.
- Static false positives can quarantine content; this is preferred to implicit trust.
- The local CLI/process and sampled Git storage bounds are not sufficient for hostile multi-tenant production. A disposable worker with kernel-enforced limits remains required.

## Rejected alternatives

- **Activate every structurally valid import:** structure is not trust evidence and this creates an execution-path bypass.
- **Use ordinary `git clone` plus checkout:** checkout expands the hook/filter/worktree attack surface without being needed for static analysis.
- **Follow redirects after validating only the first URL:** later destinations can bypass SSRF policy.
- **Call all high-similarity items semantic duplicates:** metadata trigram similarity does not establish semantic or behavioral equivalence.
- **Fill unknown scores with zero:** zero is a measurement, not an unknown state.
- **Treat SPDX parsing as license verification:** syntax and identifier validation do not prove rights, notices, authorship, or obligations.

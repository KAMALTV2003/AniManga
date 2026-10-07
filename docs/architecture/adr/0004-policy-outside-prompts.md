# ADR 0004: Policy and Execution Enforcement Outside Prompts

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Models can misunderstand instructions and can be influenced by untrusted repository, web, tool, memory, or MCP content. Prompt text cannot reliably enforce destructive-operation, credential, network, filesystem, cost, or approval boundaries.

## Decision

Models propose plans and tool arguments. A deterministic policy decision point validates identity, intent, resource, action, risk, budget, and provenance. A policy enforcement point controls the sandbox/tool gateway. High-risk decisions pause for approval. Missing or malformed decisions fail closed.

## Consequences

- Security remains effective when the model is wrong or injected.
- Policies require versioning, tests, audit, and explainable decisions.
- The product cannot enable untrusted execution until Phase 7 implements this path.

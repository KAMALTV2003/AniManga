# NEXUS Evaluation Methodology

**Status:** methodology baseline; Phases 1–4 have deterministic software and local selection-regression tests, but no model benchmark results.

## Principles

1. Define success before changing a capability.
2. Preserve raw inputs, environment metadata, outputs, tool traces, grader versions, and costs.
3. Prefer deterministic graders where a machine-verifiable answer exists.
4. Calibrate model graders against human labels and isolate them from promotion authority.
5. Compare against a pinned baseline under identical conditions.
6. Report uncertainty, failures, exclusions, and regressions—not only averages.
7. Never publish a score that was not produced by a reproducible run.

## Evaluation object model

```text
suite@version
  └── case@version
        ├── input + trusted data fixtures
        ├── expected behavior / forbidden behavior
        ├── environment + model/tool limits
        ├── execution trace
        ├── deterministic assertions
        ├── grader results
        └── regression comparison
```

The Phase 1 schema already stores evaluation identity, target, suite/version, execution, model, aggregate score, regression status, and criterion scores/evidence. The runner is Phase 6 work.

## Required dimensions

- accuracy;
- completeness;
- instruction following;
- factuality and source support;
- tool selection/arguments/results handling;
- security and policy compliance;
- robustness and consistency;
- latency;
- token/context usage;
- cost.

A single weighted score is optional and never replaces per-dimension results.

## Test classes

For each Skill and agent:

- normal representative cases;
- edge and boundary cases;
- ambiguous intent cases;
- expected failure cases;
- tool/provider/network failure cases;
- adversarial and prompt-injection cases;
- unauthorized side-effect cases;
- context pressure/irrelevant retrieval cases;
- regression cases from real incidents.

## Grader hierarchy

1. **Deterministic:** schema, exact state, tests, static checks, citations, file diff, policy decision, resource limits.
2. **Reference-based:** structured similarity to accepted output/rubric with bounded tolerance.
3. **Model grader:** rubric-scored semantic qualities; grader model/version/prompt recorded.
4. **Human review:** required for calibrated samples, subjective critical outcomes, and high-impact promotion.

Model self-evaluation is diagnostic evidence, not independent verification.

## Comparison protocol

For an optimization or new version:

1. freeze suite, environment, model settings, tool set, and budgets;
2. run baseline and candidate with repeated trials where stochastic;
3. compare per-case paired deltas;
4. report pass rate, mean/median, dispersion or confidence interval, cost, latency, and failure taxonomy;
5. block promotion when critical security cases fail or configured quality regression is exceeded;
6. retain before/after artifacts and rollback pointer.

## NEXUS Bench design

Separate tracks will measure planning, coding, research, debugging, security, Skill/tool selection, memory retrieval, orchestration, cost efficiency, and latency. Each track compares:

- baseline without NEXUS capability;
- NEXUS with selection/composition optimization disabled;
- NEXUS with optimization enabled.

External benchmark use must document license, exact revision, contamination caveats, harness, limits, and whether scores are comparable. Public third-party numbers are not NEXUS results.

## Security benchmark

Critical cases have binary fail-closed assertions in addition to quality scoring. Categories include goal hijack, malicious Skill/plugin/MCP, secret exfiltration, traversal, command injection, unsafe URL, dependency compromise, tool misuse, privilege escalation, message replay, memory poisoning, cross-tenant access, and cascading resource exhaustion.

## Current evidence

Verification through Phase 4 covers deterministic software behavior: compiler, lint, migrations/integrity, redaction, inert harvesting, static trust evidence, capability graph isolation, vector validation, hybrid ranking, bounded composition, and CLI end-to-end execution.

The Phase 4 corpus v2 is a 24-case synthetic software-capability selection suite with six composition cases. Against the pinned lexical-only ablation, hybrid lexical-plus-structured-metadata retrieval scores recall@5 `1.0` versus `0.583333` and MRR@5 `0.909722` versus `0.562500`; all six expected composition bundles are selected exactly. These are reproducible local regression results for the disclosed synthetic corpus, not general semantic-quality results. No external embedding-provider, AI model, behavioral Skill execution, model-routing, orchestration, or production retrieval score exists yet.

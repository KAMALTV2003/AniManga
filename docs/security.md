# Security Architecture

The operational policy is [../SECURITY.md](../SECURITY.md), the complete design analysis is [threat-model.md](threat-model.md), and the latest implementation review is [security-review-phase3.md](security-review-phase3.md).

## Phase 1–3 summary

NEXUS protects configuration parsing, error/log/CLI output, local database integrity, migration history, local file permissions, event mutation, inert Skill import, and bounded Skill harvesting. Directory and ZIP adapters enforce quotas and path/type constraints, hash every payload file, remove executable permissions from managed artifacts, and preserve immutable version provenance. HTTPS/Git acquisition adds public-address enforcement, direct IP pinning with hostname TLS validation, disabled redirects/proxies/credentials/hooks, bare Git plumbing, object checks, and process/time/output/storage limits.

The Phase 3 static scanner normalizes instruction, script, secret, URL, manifest, hook, permission, dependency-declaration, and binary findings without persisting matched evidence. SPDX syntax/declaration and conservative license-file detections remain separate from legal conclusions. Deterministic static assessments can only quarantine or candidate-register; candidates remain inactive and imported code is never executed.

The execution sandbox, centralized policy decision service, authenticated approval flow, MCP security gateway, identity, tenant isolation, artifact signatures, specialized malware/dependency analyzers, and behavioral evaluation remain blocking roadmap work. A discovered, cleanly parsed, low-risk, or candidate-registered artifact is not trusted for execution.

## Enforcement direction

```text
untrusted input → bounded acquisition/parser → static scan → provenance/license
                → candidate/quarantine → policy → approval → isolated executor
                → validated output → trace/evaluation
```

Security decisions are deterministic and external to prompts. Missing policy or isolation fails closed.

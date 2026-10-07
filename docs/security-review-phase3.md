# Phase 3 Security Review: Harvesting and Trust

**Review date:** 2026-10-07
**Scope:** `@nexus-ai/harvest`, metadata schema v2, schema migration v5, candidate/quarantine persistence, and CLI harvest lifecycle
**Production approval:** Not granted

## Invariants reviewed

| Invariant                                  | Enforcement                                                                                                       | Verification                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Imported payload code is never run         | no checkout, no package installation, plumbing-only Git materialization, static readers only                      | hostile scripts and a Git blob fixture remained inert in integration/CLI tests |
| Network destination is public HTTPS        | URL policy, all-address DNS classification, IP-pinned TLS/Git connections, redirects/proxies/credentials disabled | loopback IPv4/IPv6 and query-bearing URLs rejected                             |
| Acquisition is bounded                     | download/blob/file/repository/output/time quotas and Git staging growth monitor                                   | output and workspace limit process tests; canonical archive limit suite        |
| Evidence does not disclose matched secrets | finding descriptions plus evidence hashes, core output redaction                                                  | hostile finding serialization checked for absence of matched URL payload       |
| Candidate does not become active           | candidate Skill status, no current-version update, active-only search                                             | database integration assertion                                                 |
| Quarantine does not preserve executability | inventory-verified atomic copy with mode `0400`                                                                   | hostile quarantine mode assertion                                              |
| Unknown measurements remain unknown        | nullable maintenance/compatibility fields and evidence-bearing measured dimensions                                | metadata integration assertion                                                 |
| License state is not a legal conclusion    | separate declaration/syntax/detection status and `legalConclusion: false` evidence                                | consistent/missing review integration cases                                    |
| Duplicate labels match their methods       | content SHA-256 exact matches; metadata trigram near proposals                                                    | exact duplicate regression test                                                |

## Findings fixed during review

1. **Candidate visibility/current-version exposure.** Candidate registration initially reused active registry pointer behavior. Registration now leaves candidate-only Skills without an active current version, preserves an existing active Skill when adding a candidate, and normal search filters to active status.
2. **Unbounded Git staging during clone.** The clone path initially checked repository bytes only after Git exited. It now monitors staging growth while the process runs, terminates the process group when the limit is crossed, and retains the strict post-clone check.
3. **Process termination classification.** The bounded runner now distinguishes timeout, output, workspace, external signal, and startup failures, sends group `SIGTERM`, escalates to `SIGKILL`, and prevents an in-flight monitor from signaling a process after settlement.
4. **DNS timeout gap.** DNS resolution now has an explicit timeout before any remote connection.
5. **Potential finding-evidence leakage.** Findings retain only rule metadata, location, fingerprints, and evidence hashes; matched content is not returned or persisted.
6. **Hook/binary scan ordering.** Hook paths are now classified before opaque binary skipping so extensionless hooks cannot avoid the hook rule.
7. **Direct CLI trust bypass.** `skill install` now requires the explicit `--trusted-local-authoring` assertion. Untrusted sources use the harvest gate.
8. **Near-duplicate overclaim risk.** The method is explicitly labeled metadata character-trigram Jaccard rather than semantic similarity.
9. **Assessment schema and reruns.** Deterministic assessments are separated from harvest links so repeated harvests can retain distinct policy outcomes, including exact-duplicate quarantine after an initial candidate registration.

## Residual risks and required later controls

### High-priority residuals

- ZIP parsing, static scanning, and license analysis still run in the CLI process. Quotas reduce denial-of-service exposure but do not contain a parser/runtime vulnerability. Move all hostile parsing into a disposable non-root worker with filesystem, process, memory, CPU, and syscall limits.
- Git clone directory monitoring is sampled, not a kernel-enforced hard quota. Production workers require a quota-limited filesystem/cgroup and an external wall-clock supervisor.
- Static rules are incomplete by nature and are not a malware verdict. Add specialized secret, binary, dependency, SBOM, and advisory engines behind the normalized finding interface.
- Candidate promotion is intentionally absent. A future policy service must require authenticated human approval, immutable audit evidence, and separation of duties before active use.
- SQLite is a local single-operator database. It does not provide tenant authorization, remote identity, row-level isolation, or durable external audit.

### Medium-priority residuals

- License text signatures cover a conservative subset of common licenses. Human/legal review remains required when evidence is absent, conflicting, custom, exceptional, or ambiguous.
- Nested archives remain inert and unexpanded, so embedded threats are not recursively inspected.
- HTTPS archive handling rejects redirects and query-bearing signed URLs. A future controlled redirect/signed-download mechanism must revalidate every hop and avoid persisting credentials.
- Git uses the operator-installed system binary. Release packaging must pin a supported Git version and verify its provenance.
- Remote Git acquisition has not been verified on Windows in this phase.
- Local source trees controlled concurrently by another process retain a race surface despite no-follow opens and digest rechecks. Worker-mounted immutable snapshots remain the stronger boundary.
- There is no artifact signature verification or transparency-log validation. `npm audit signatures` remains unclaimed because Sigstore TUF retrieval previously failed with `ECONNRESET`.

## Review conclusion

The Phase 3 implementation is suitable for continued local development and inert candidate intake under the documented constraints. It is not approved for hostile multi-tenant production use and does not authorize imported execution. The next security-critical milestone is policy-gated worker isolation and behavioral evaluation, not broader execution privileges.

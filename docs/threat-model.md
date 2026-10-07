# NEXUS AI Threat Model

**Version:** 0.4
**Reviewed:** 2026-10-07
**Scope:** planned full system, with implemented Phase 1–4 local controls called out explicitly

## 1. Security objectives

1. An untrusted artifact cannot redefine system policy.
2. Unknown code cannot execute on the host.
3. An agent cannot use a capability beyond user intent and declarative policy.
4. Secrets remain out of prompts, logs, errors, artifacts, and repositories unless a narrowly scoped tool needs them.
5. Tenant, project, user, agent, and execution data remain isolated.
6. Every privileged decision and side effect is attributable and auditable.
7. Poisoned memory or retrieval content cannot silently become trusted instruction.
8. Compromise is contained by identity, network, filesystem, process, cost, and concurrency boundaries.

## 2. Trust zones

| Zone                      | Examples                                        | Default trust                                    |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| System policy             | compiled invariants, signed organization policy | trusted after integrity verification             |
| User intent               | authenticated request and explicit approvals    | authoritative only for that user's allowed scope |
| Canonical registry        | accepted versions, locks, provenance            | trusted according to object trust state          |
| Model output              | plans, code, arguments, summaries, evaluations  | untrusted proposal                               |
| External content          | repositories, Markdown, web, docs, datasets     | untrusted data                                   |
| Skill/plugin/MCP metadata | manifests, tool descriptions, prompts           | untrusted claims                                 |
| Tool output               | shell/API/MCP/browser response                  | untrusted data with origin                       |
| Memory/retrieval          | observations and recalled records               | trust varies; never system policy                |
| Sandbox                   | isolated worker and staged filesystem           | hostile workload boundary                        |
| External systems          | GitHub, cloud, databases, CI, providers         | separately authenticated and scoped              |

## 3. Protected assets

- provider/API credentials and OAuth tokens;
- source repositories and unpublished artifacts;
- user and tenant data;
- policy definitions and approval records;
- registry identity/version pointers;
- provenance, evaluation, and audit history;
- model budgets and billing controls;
- signing keys and release artifacts;
- host filesystem/network/process privileges.

## 4. Adversaries

- malicious Skill/plugin/MCP publisher;
- attacker controlling repository/document/web content;
- compromised dependency or registry account;
- malicious or over-privileged user;
- external service returning poisoned tool output;
- compromised agent or model-induced unsafe behavior;
- tenant attempting cross-tenant access;
- accidental operator error and environmental failure.

## 5. Principal threats and controls

### Goal hijack and indirect prompt injection

**Path:** instructions embedded in repositories, Markdown, issues, tool results, MCP descriptions, or memory redirect the plan.

**Controls:** content-origin labels; policy not present in model-editable context; planner/executor split; tool allowlists; output schema validation; approval for side effects; injection scanner; adversarial evals.

### Tool misuse and confused deputy

**Path:** a low-trust agent induces a privileged tool/agent to perform an allowed operation for an unauthorized purpose.

**Controls:** execution identity; capability tokens scoped to action/resource/time; authorization at tool invocation; original user/tenant intent propagation; no ambient credentials; composition-level data-flow policy.

### Unexpected code execution

**Path:** generated command, archive, package install script, hook, plugin, or Skill script reaches the host.

**Controls:** no-execute discovery; traversal-safe extraction; static scan; container/non-root sandbox; read-only root; explicit writable mounts; seccomp/process/resource/time limits; deny-by-default egress; no host sockets; approval according to risk.

**Phase 2–3:** local-directory, ZIP, HTTPS ZIP, and HTTPS Git Skill inputs are handled as inert data. Archives are snapshotted, bounded, traversal/collision/link checked, and streamed into private staging. Git uses a bare clone and plumbing-only blob materialization with hooks, credentials, unsafe protocols, proxies, and redirects disabled. Static scanning, quarantine, and candidate registration remove executable bits and explicitly perform no behavioral execution. The actual sandbox is not implemented, so all imported execution remains blocked.

### Secret theft and exfiltration

**Path:** model reads credentials and sends them through logs, network tools, commits, MCP, or generated output.

**Controls:** secret references; per-tool injection; short-lived credentials; egress policy; prompt/content minimization; redaction; DLP scan; commit guards; secret-free examples.

### Supply-chain compromise

**Path:** typosquat, dependency takeover, malicious update, modified plugin, MCP server, model package, or CI action.

**Controls:** lockfiles; hashes/signatures; provenance/SBOM; license/advisory checks; install-script review; source pinning; trust tiers; quarantine; reproducible package validation; no popularity override.

### Memory and retrieval poisoning

**Path:** false or malicious observations are persisted, ranked, summarized, and later treated as truth.

**Controls:** scoped writes; immutable provenance; trust/confidence separate; candidate state; independent evidence; correction/tombstone; decay/expiry; retrieval origin shown; no automatic policy promotion; poisoning regression suite.

**Phase 4:** only active canonical Skill versions synchronize into project-scoped index documents; full instruction bodies are excluded; ranking components and strategy versions are retained as evidence; raw query text is not persisted; and ranking cannot promote or authorize a capability. Versioned evaluation compares against a pinned lexical ablation and stores append-only case evidence. This does not replace authenticated approval or adversarial poisoning evaluation.

### Malformed embeddings and retrieval resource exhaustion

**Path:** a provider returns malformed or adversarial vectors, or a request forces excessive exact-vector, graph, or composition work.

**Controls:** provider/model identity; exact count/dimension/finite-value/non-zero-norm validation; stale-vector rejection; document/vector-value/query/candidate/graph/state/context limits; explicit bounded-search labels; measured scalable-backend conformance before replacement.

### Insecure inter-agent communication

**Path:** spoofed, replayed, or cross-tenant task/result messages influence another agent.

**Controls:** authenticated service identity; signed/integrity-protected messages; nonce/idempotency; trace/execution binding; tenant checks; schema validation; replay window; least-privilege queues.

### Cascading failure and resource exhaustion

**Path:** bad upstream output fans out, loops, retries, spends budget, or corrupts many workflows.

**Controls:** bounded depth/concurrency/turns/retries; budgets; circuit breakers; typed state; independent verifier; checkpoint and cancel; blast-radius policy; idempotency and compensation.

### Human approval manipulation

**Path:** fluent agent explanation persuades a reviewer without independent evidence.

**Controls:** approval UI shows exact operation, diff, scope, source evidence, policy reason, uncertainty, and irreversible effects; explanation is labeled model-generated; high-risk actions require independent verification.

**Phase 4 local control:** Skill promotion is denied unless immutable trust, license, structural, finding, and named behavioral-suite score gates pass. Decisions snapshot checks/evidence and exact prior state; rollback rejects replay and state divergence. The CLI actor remains an unauthenticated declaration and therefore is not a production human-approval service.

### Audit tampering

**Path:** attacker updates/deletes traces, provenance, findings, or approvals.

**Controls:** append-only event model; immutable versions; database authorization; external/WORM export for enterprise; hashes and signatures; restricted retention changes.

## 6. Dangerous action classes

Always blocked or approval-gated according to policy:

- destructive filesystem/database/cloud actions;
- production deployment or configuration mutation;
- credential creation, reading, rotation, or transmission;
- financial/contractual actions;
- public publishing and external messaging;
- dependency installation or unknown executable code;
- writes outside explicitly mounted project paths;
- network to unapproved domains;
- trust promotion, policy mutation, release signing, or stable release marking.

## 7. Implemented controls and gaps

Implemented through Phase 4: strict data-only config; symlink/size/unknown-key rejection; unsafe merge-key rejection; secret redaction; migration checksums and backup-aware upgrades; database integrity; local file modes; append-only event triggers; strict Agent Skills parsing; bounded directory, ZIP, HTTPS ZIP, and bare-Git adapters; public-address and destination-pinning controls; portable path-collision rejection; deterministic payload/file/source hashes; immutable Skill versions; provenance; static security/license/duplicate assessments; quarantine; inactive candidate registration; installed-artifact re-verification; project-scoped active capability indexing; validated bounded embedding storage and provider conformance harness; evidence-backed hybrid retrieval; dependency/conflict-aware bounded composition; query/intent hashing; inert gap proposals; append-only retrieval regression evidence; fail-closed local promotion gates; and exact state-matched rollback.

ZIP parsing and scanning still run in the CLI process, and local source trees can be exposed to concurrent mutation by another local process. Snapshotting, no-follow opens, inode/size/containment checks, post-copy hashes, process limits, and sampled Git staging limits reduce risk, but process, mount, syscall, and kernel-enforced storage isolation are required before hostile multi-user operation.

Not implemented: authenticated identity, authorization, production approval service, execution sandbox, runtime network policy, specialized malware/dependency advisory engines, DLP certification, tenant isolation, signatures, SBOM, or durable external audit. Local candidate promotion requires explicit acknowledgement but is not authenticated approval. These are explicit blockers, not accepted residual production risks.

## 8. Verification plan

Every security fix adds a regression test. The security benchmark will include prompt injection, malicious Skill/ZIP/plugin/MCP, traversal, command injection, secret leakage, unsafe URL, dependency attack, tool abuse, identity escalation, replay, memory poisoning, cross-tenant retrieval, budget loops, and sandbox escape attempts.

A clean scanner result never upgrades unknown code directly to trusted execution.

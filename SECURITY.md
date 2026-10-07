# Security Policy

## Current security posture

NEXUS AI is pre-release software. Phases 1 and 2 include secure defaults for configuration, local database permissions, migration integrity, append-only events, structured errors, log redaction, and inert bounded Skill import. It does **not** yet include the production sandbox, complete policy engine, deep static/malware Skill scanner, MCP gateway, authentication, or tenant isolation required for untrusted execution or multi-user deployment.

Do not run imported Skills, plugins, repositories, scripts, or MCP servers merely because NEXUS discovered them. Discovery is not trust.

## Report a vulnerability

Use the repository's GitHub **Security → Report a vulnerability** private advisory flow. Do not open a public issue containing exploit details, credentials, sensitive traces, or affected user data.

Include:

- affected commit/version;
- reproduction steps and required privileges;
- expected and observed impact;
- whether secrets or external side effects were involved;
- suggested mitigation, if known.

No response-time SLA is promised before the first stable release.

## Security invariants

- External content is data, never system policy.
- Unknown code does not execute on the host.
- Credentials must come from environment/secret providers, not tracked configuration.
- Logs and errors must redact known secret fields.
- Dangerous operations require an explicit policy decision.
- Security controls fail closed when their result is missing or invalid.
- Version and provenance records are not silently overwritten.
- Memory candidates cannot promote themselves to trusted rules.

## Implemented controls

| Control                                                  | Status                              | Evidence                    |
| -------------------------------------------------------- | ----------------------------------- | --------------------------- |
| Strict config schema and unknown-key rejection           | Implemented                         | config unit tests           |
| Config file size cap and symlink rejection               | Implemented                         | config unit tests           |
| Project path containment and database symlink rejection  | Implemented                         | config/database tests       |
| Prototype-pollution merge key rejection                  | Implemented                         | loader implementation       |
| Secret redaction in errors and logs                      | Implemented                         | redaction/logger tests      |
| Database migration checksum verification                 | Implemented                         | database drift test         |
| SQLite foreign keys, WAL, FULL synchronous writes        | Implemented                         | database initialization     |
| Local data directory/database permissions                | Implemented where POSIX modes exist | doctor + CLI E2E            |
| Append-only event mutation guards                        | Implemented                         | database test               |
| Strict data-only `SKILL.md` parsing                      | Implemented                         | Skill analyzer tests        |
| Bounded ZIP snapshot, traversal/link/collision rejection | Implemented                         | malicious archive tests     |
| Deterministic payload and per-file integrity hashes      | Implemented                         | Skill registry tests        |
| Immutable Skill versions and provenance                  | Implemented                         | registry/database tests     |
| Imported-script execution during import/test/search      | Prohibited and regression-tested    | Skill CLI E2E               |
| Host sandbox and egress isolation                        | Not implemented                     | Phase 7 blocker             |
| MCP validation/permission gateway                        | Not implemented                     | Phase 7 blocker             |
| Authentication and tenant isolation                      | Not implemented                     | API/team deployment blocker |

## Supported security checks

```bash
npm audit --audit-level=high
npm run lint
npm run typecheck
npm run test:coverage
npm run nexus -- doctor
npm run nexus -- validate
```

`npm audit` is a dependency advisory check, not a complete supply-chain review. Release engineering will add SBOM, provenance attestations, and signature verification before a stable release; CI actions are already pinned by commit SHA.

## Phase 2 residual risks

- Structural Skill tests do not establish behavioral correctness or safety. No behavioral score is produced.
- ZIP parsing is bounded and operates on an immutable private snapshot, but the parser still shares the CLI process. A later import worker/process boundary will reduce the impact of parser-level denial-of-service defects.
- Local-directory reads use no-follow file opens, inode/size checks, containment checks, and digest verification. Operators must still prevent an adversarial process from concurrently mutating the source tree during import; a future isolated importer will provide a stronger filesystem boundary.
- Declared author, license, compatibility, dependencies, and tools are unverified source claims. Risk remains `unknown` and scores remain null until dedicated scanning and evaluation stages run.
- Installed scripts have executable bits removed, but managed artifacts are not an execution sandbox. They must never be invoked directly.

## Secrets

NEXUS configuration intentionally has no API-key fields. Provider adapters will consume secret references or injected environment variables. Examples must use names only and must never contain plausible live key values. Prompt/completion and tool body logging defaults off because content may include credentials or personal data.

## Dependency policy

Dependencies must be necessary, pinned by the lockfile, license-compatible with Apache-2.0, and covered by automated advisory checks. New execution, parsing, archive, network, or authentication dependencies require threat analysis.

For the full system threat model, see [docs/threat-model.md](docs/threat-model.md).

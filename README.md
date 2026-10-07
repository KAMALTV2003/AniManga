# NEXUS AI

> **Current maturity: Phase 4 capability selection (`0.1.0-dev.1`).** Phases 1–4 are implemented and verified within documented local/inert boundaries. NEXUS is under active development and must not be represented as production-ready.

NEXUS AI is a capability operating system for AI agents. Its goal is to discover, verify, compose, execute, evaluate, and continuously improve reusable capabilities without trusting arbitrary code or loading an entire capability catalog into model context.

The product thesis is:

> An intelligent operating system for AI agents that discovers capabilities, evaluates them, composes them dynamically, executes them safely, learns from outcomes, and continuously improves its capability graph.

## What is implemented now

Phases 1–4 provide tested infrastructure, an inert canonical Skill registry, bounded harvesting/trust, and evidence-backed capability selection rather than simulated agent behavior:

- TypeScript monorepo with strict compiler settings and explicit package boundaries.
- Core lifecycle runtime with ordered startup, rollback, health aggregation, and structured failures.
- Typed in-process event bus with explicit subscriber failure handling.
- Structured errors carrying code, component, retryability, severity, details, and trace ID.
- Layered JSON/YAML configuration with strict schema validation, `.env` loading, global/project/env precedence, size limits, and symlink rejection.
- Secret-redacting structured logging in JSON or developer-readable form.
- SQLite local control-plane database with checksummed migrations, backup-aware upgrades, integrity validation, append-only events, full-text memory and Skill indexing, and normalized tables for every planned major object family.
- Strict data-only Agent Skills parsing, bounded directory/ZIP/HTTPS/Git adapters, deterministic inventories and source snapshots, canonical metadata, provenance, and immutable versions.
- SPDX-aware license review, normalized static findings, deterministic evidence-backed static scores, honest exact/metadata-near duplicate proposals, quarantine, and candidate registration.
- Structural Skill tests and installed-artifact integrity verification that never execute imported scripts.
- Project-scoped typed capability graph with immutable index documents and active-Skill synchronization.
- Bounded hybrid lexical/optional-semantic/metadata/graph retrieval with validated embedding-provider contracts and evidence persistence.
- Dependency- and conflict-aware smallest-sufficient bundle composition plus inert synthesis contracts for measured gaps.
- Versioned append-only retrieval evaluation against a pinned baseline, with measured local improvement on the disclosed synthetic corpus.
- Fail-closed local Skill promotion gates and exact, state-matched rollback with append-only evidence decisions.
- CLI commands for initialization, migration, diagnostics, status, validation, Skill lifecycle, capability selection/evaluation, and local promotion/rollback, all with `--json` output.
- Unit, integration, database, malicious-archive, hostile-harvest, security-behavior, and CLI end-to-end tests.

Sandboxed Skill execution and a behavioral evaluation runner, plus the agent runtime, model gateway, MCP gateway, dashboard, and exporters, remain roadmap work and are clearly marked in [PROJECT-STATUS.md](docs/PROJECT-STATUS.md).

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- Linux, macOS, or Windows

## Install and verify

```bash
npm ci
npm run verify
```

For repository development, build and inspect this initialized NEXUS workspace:

```bash
npm run build
npm run nexus -- doctor
npm run nexus -- status
npm run nexus -- validate
npm run nexus -- skill analyze ./path/to/my-skill --json
npm run nexus -- skill test ./path/to/my-skill --json
npm run nexus -- skill harvest ./path/to/untrusted-skill --inspect-only --json
npm run nexus -- skill harvest ./path/to/untrusted-skill --register --json
npm run nexus -- skill install ./path/to/operator-authored-skill --trusted-local-authoring --version 1.0.0 --json
npm run nexus -- skill search "my capability" --json
npm run nexus -- capability sync --json
npm run nexus -- capability search "secure release" --tag security release --json
npm run nexus -- capability compose "prepare a secure release" --require release security-review --json
npm run nexus -- capability evaluate ./retrieval-suite.json --json
npm run nexus -- skill promotion-check <skill-id> --version 1.0.0 --json
```

Initialize a different existing directory:

```bash
node /path/to/NEXUS/apps/cli/dist/main.js init /path/to/project
```

`init` refuses to overwrite an existing NEXUS configuration. It creates `nexus.config.yaml`, a permission-restricted `.nexus/` directory, and a migrated local database. `.nexus/` must remain ignored by Git.

Machine-readable output is available on every implemented command:

```bash
npm run nexus -- status --json
```

## Repository map

```text
apps/
  cli/                 Professional command-line surface
packages/
  core/                Lifecycle, event, trace, ID, and error contracts
  config/              Layered validated configuration
  database/            SQLite runtime, migrations, repositories
  observability/       Structured secret-safe logging
  skills/              Inert Skill adapters, canonical schema, registry
  harvest/             Bounded acquisition, static trust analysis, quarantine
  capabilities/        Typed graph, hybrid retrieval, embedding index, composition
docs/
  architecture/        Architecture decisions and component design
  research/            Dated ecosystem research
  PROJECT-STATUS.md    Evidence-backed living delivery status
tests/                 Unit, integration, database, and CLI E2E tests
```

## Design priorities

NEXUS optimizes for:

**Capability × Reliability × Security × Extensibility × Evaluation × Automation × Context efficiency × Developer experience × Interoperability**

This means:

1. Canonical capability data is independent of any one model provider or harness.
2. Instructions, untrusted data, tool output, and policy are distinct security domains.
3. Every meaningful object and action is versioned, attributable, and auditable.
4. Retrieval and progressive disclosure replace bulk prompt loading.
5. Promotion requires evidence; observations never become permanent rules automatically.
6. Explicit failures are preferred over silent fallback or corrupted state.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Canonical Skill system](docs/skills.md)
- [Harvesting and trust](docs/harvesting.md)
- [Capability graph, retrieval, and composition](docs/capabilities.md)
- [Phase 3 security review](docs/security-review-phase3.md)
- [Phase 4 security review](docs/security-review-phase4-foundation.md)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Competitive research](docs/research/competitive-analysis.md)
- [Threat model](docs/threat-model.md)
- [Evaluation methodology](docs/evaluation-methodology.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).

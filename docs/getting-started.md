# Getting Started

NEXUS is currently a development workspace, not a published stable package.

## Prerequisites

- Node.js 22.13+
- npm 10+
- Git

## Build from source

```bash
git clone <your-nexus-repository-url>
cd NEXUS
npm ci
npm run build
npm test
```

## Initialize a project

From this repository, initialize an existing directory that does not already contain a NEXUS configuration:

```bash
node apps/cli/dist/main.js init /path/to/project
```

The command creates:

- `nexus.config.yaml` — non-secret validated project configuration;
- `.nexus/nexus.db` — local control-plane state;
- `.nexus/` entry in `.gitignore` when missing.

It refuses to overwrite an existing `nexus.config.yaml`, `.yml`, or `.json` file.

## Inspect health

Run from the initialized project:

```bash
node /path/to/NEXUS/apps/cli/dist/main.js doctor
node /path/to/NEXUS/apps/cli/dist/main.js status
node /path/to/NEXUS/apps/cli/dist/main.js validate
```

After updating NEXUS, apply pending checksummed migrations explicitly. The command creates an online backup before changing an existing schema:

```bash
node /path/to/NEXUS/apps/cli/dist/main.js migrate
```

Append `--json` for automation. An unhealthy doctor/validation result exits non-zero.

## Configuration precedence

Lowest to highest:

1. optional global `~/.config/nexus/config.yaml|yml|json` (or `$XDG_CONFIG_HOME/nexus/`);
2. project `nexus.config.yaml|yml|json` discovered upward from the current directory;
3. project `.env` for supported `NEXUS_*` variables;
4. process environment.

Supported overrides:

- `NEXUS_CONFIG`
- `NEXUS_ENVIRONMENT`
- `NEXUS_DATA_DIR`
- `NEXUS_DATABASE_PATH`
- `NEXUS_LOG_LEVEL`
- `NEXUS_LOG_FORMAT`
- `NEXUS_LOG_DESTINATION`

Provider credentials are intentionally absent from tracked configuration. Use a secret manager or injected environment only when provider adapters are implemented.

## Analyze and harvest a Skill

Run from an initialized project:

```bash
node /path/to/NEXUS/apps/cli/dist/main.js skill analyze ./my-skill --json
node /path/to/NEXUS/apps/cli/dist/main.js skill test ./my-skill --json
node /path/to/NEXUS/apps/cli/dist/main.js skill harvest ./my-skill --inspect-only --json
node /path/to/NEXUS/apps/cli/dist/main.js skill harvest ./my-skill --register --json
node /path/to/NEXUS/apps/cli/dist/main.js skill search "capability description" --json
```

Harvest supports local directories/ZIPs and controlled HTTPS ZIP/Git sources. It treats imported content as inert data, records static trust evidence, and either inspects, quarantines, or candidate-registers according to policy. It never executes imported scripts. Direct `skill install` is only for explicit operator-authored local input and requires `--trusted-local-authoring`. See [skills.md](skills.md) and [harvesting.md](harvesting.md) for source limits, hashing, trust states, and remaining boundaries.

## Development gates

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=high
```

See [PROJECT-STATUS.md](PROJECT-STATUS.md) before depending on a capability.

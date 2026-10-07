# Configuration

NEXUS Phase 1 supports JSON and YAML project/global configuration. Configuration is strictly validated data; executable JavaScript configuration is intentionally unsupported.

## Project file

`nexus.config.yaml`, `nexus.config.yml`, or `nexus.config.json`:

```yaml
version: 1
environment: development
project:
  id: prj_<generated-id>
  name: example
runtime:
  dataDir: .nexus
  shutdownTimeoutMs: 10000
database:
  provider: sqlite
  path: .nexus/nexus.db
  busyTimeoutMs: 5000
logging:
  level: info
  format: pretty
  destination: stdout
  captureContent: false
  extraRedactKeys: []
security:
  failClosed: true
```

Use `nexus init`; do not hand-invent the project ID.

## Security behavior

- Unknown keys fail validation.
- Project configuration symlinks are rejected.
- Files over 1 MiB are rejected.
- YAML aliases are bounded.
- Unsafe merge keys are rejected.
- Relative paths resolve from the project root; local data/database/log paths cannot escape it, including through an existing symlink ancestor.
- API keys and provider credentials are not part of this schema.

See [getting-started.md](getting-started.md) for precedence and environment overrides.

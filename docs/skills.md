# Canonical Skill System

## Scope

Phase 2 treats every imported Skill as untrusted data. Discovery, analysis, testing, installation, hashing, indexing, and search **never execute imported scripts or instructions**. Behavioral execution belongs to a later sandboxed runtime and must pass policy approval.

NEXUS accepts local directories and ZIP files through the canonical source adapter. Phase 3 additionally acquires HTTPS ZIP and HTTPS Git sources through the separate [harvest trust boundary](harvesting.md) before they can reach quarantine or candidate registration.

Local canonical sources are:

- a directory whose basename equals its declared Skill name; or
- a ZIP containing either a root `SKILL.md` or exactly one top-level Skill directory.

The source adapter produces one normalized package for the registry. Source-specific behavior does not leak into the canonical registry API.

## Source contract

`SKILL.md` follows the current Agent Skills specification:

```markdown
---
name: release-notes
description: Create release notes. Use when preparing a software release.
license: Apache-2.0
compatibility: Requires Git history.
metadata:
  version: 1.0.0
  author: Example Author
allowed-tools: Read Grep
---

# Instructions

Read the repository history and follow [the style guide](references/style.md).
```

NEXUS enforces:

- frontmatter at byte zero, with no byte-order mark;
- unique YAML keys and no aliases;
- only `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools` at the frontmatter root;
- a lowercase hyphenated name of at most 64 characters;
- a plain-text description of at most 1,024 characters;
- parent-directory/name equality for directory and directory-wrapped ZIP sources;
- non-empty instructions;
- in-package, traversal-free local Markdown references; and
- bounded metadata, manifest, file count, file size, path depth, and total package size.

`allowed-tools` is recorded as an untrusted declaration. It never grants a permission.

## Canonical package

A registered artifact has this shape:

```text
<managed-data>/skills/<skill-id>/<version>/<name>/
├── SKILL.md
├── metadata.json
├── scripts/
├── references/
├── assets/
├── tests/
└── examples/
```

Only directories that exist in the source are materialized. Metadata-v1 remains readable for compatibility. New registrations emit trust-aware metadata v2 conforming to [`packages/skills/schema/nexus-skill-v2.schema.json`](../packages/skills/schema/nexus-skill-v2.schema.json).

Canonical metadata includes:

- stable Skill and version identity;
- canonical SemVer;
- source type, locator, optional commit, and archive hash;
- deterministic payload hash and byte count;
- declared author and license status;
- compatibility, tags, dependencies, and declared tools;
- complete resource inventory with individual SHA-256 hashes;
- provenance identity;
- risk status;
- nullable quality, security, efficiency, compatibility, test, duplication, maintenance, and documentation scores; and
- optional linked security-scan and assessment identities in metadata v2.

A score of `null` means **not measured**. NEXUS never converts an unknown score to zero. Direct trusted-local registrations begin with `risk: "unknown"`, unverified or missing license status, and null scores. Harvest candidate registrations may carry measured static values and linked evidence, but those values are not behavioral success or legal-verification claims.

## Deterministic hashing

The payload digest is SHA-256 over a framed, UTF-8-byte-sorted sequence of:

1. normalized relative path;
2. exact byte length; and
3. each file's SHA-256 digest.

The generated root `metadata.json` is excluded from the payload digest to avoid a circular hash. It is independently schema-validated and must exactly match the payload digest, byte count, and resource inventory. Path, size, and digest framing prevents ambiguous concatenation.

## ZIP safety boundary

ZIP processing uses lazy streaming into a fresh private staging directory. NEXUS rejects before registration:

- absolute, drive-qualified, backslash, traversal, empty-component, control-character, reserved version-control-directory, and non-portable paths;
- exact duplicates plus case-folded and Unicode-normalized collisions;
- symbolic links and other special filesystem entries;
- encrypted entries and compression methods other than stored or deflated;
- multiple Skill roots or files outside the single root;
- excessive archive size, entries, depth, path length, per-file expansion, total expansion, or compression ratio; and
- malformed parser output or declared/actual size mismatch.

The adapter first copies the archive through a no-follow file descriptor into private staging while hashing it. Parsing therefore operates on the exact immutable byte snapshot identified by provenance.

Nested archives are inert assets; NEXUS does not recursively expand them.

## Immutable installation

A registration writes a fresh staged artifact, disables all executable bits, emits canonical metadata, and publishes under a per-version installation lock. The database transaction records the Skill, version, files, provenance, validation result, and current-version pointer.

`(skill_id, version)` is immutable:

- same version and same payload/metadata is idempotent;
- same version with changed payload fails with `SKILL_VERSION_IMMUTABLE`;
- same version with changed identity metadata fails with `SKILL_VERSION_METADATA_IMMUTABLE`; and
- a pre-existing artifact without a matching row fails closed as an orphan instead of being overwritten.

A failed database transaction removes only the artifact created by that attempt. Interrupted installs remain explicit and require operator inspection rather than silent replacement.

## Structural tests versus behavioral evaluations

`nexus skill test` checks frontmatter, naming, inventory, local references, canonical metadata consistency, and non-empty instructions. It reports expected and actual results and explicitly records:

```json
{
  "behavioralExecution": "not-performed",
  "importedCodeExecuted": false
}
```

This is not a claim that the Skill succeeds at its intended task. Phase 3 adds static security scanning, evidence-backed static scoring, and duplicate proposals during harvest. Sandboxed behavioral evaluation and synthesis remain later governed stages.

## CLI

```bash
nexus skill analyze ./skills/release-notes --json
nexus skill test ./skills/release-notes --json
nexus skill harvest ./skills/release-notes --inspect-only --json
nexus skill harvest ./skills/release-notes --register --json
nexus skill install ./skills/operator-authored --trusted-local-authoring --version 1.0.0 --json
nexus skill search "release notes" --json
nexus skill verify skill_0123456789abcdef0123456789abcdef --version 1.0.0 --json
```

A package may declare `metadata.version`; otherwise registration requires `--version`. Direct `skill install` bypasses harvest only for explicitly asserted operator-authored local input and requires `--trusted-local-authoring`. Use `nexus migrate` to create a private online backup and apply pending checksummed schema migrations.

## Normative and security references

- [Agent Skills specification](https://agentskills.io/specification)
- [Anthropic Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Anthropic Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic Agent SDK secure deployment](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)

NEXUS's canonical metadata and archive restrictions are additional controls; they are not represented as requirements of the open Agent Skills specification.

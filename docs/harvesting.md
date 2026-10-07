# Harvesting and Trust

## Security contract

Phase 3 treats every harvested Skill, repository, archive, manifest, instruction, script, hook, binary, URL, and declaration as untrusted data. Harvesting performs acquisition, parsing, hashing, static analysis, evidence recording, quarantine, and candidate registration. It does **not** run imported scripts, install imported dependencies, invoke package lifecycle hooks, evaluate Skill behavior, or promote a candidate to active trust.

The implemented path is:

```text
source request
  → bounded local/HTTPS/Git acquisition
  → canonical Skill analysis and content hash
  → static security scan + SPDX-aware license review
  → exact/near duplicate proposals
  → deterministic evidence-backed assessment
  → inspect only | quarantine | candidate registration
```

A successful parse, low static risk, valid SPDX expression, or candidate registration is not a safety, legal, quality, or production-readiness certification.

## Source adapters

### Local directory and ZIP

The Phase 2 no-follow directory and bounded ZIP adapters remain the local acquisition boundary. Every later scanner, license, quarantine, and registration read rechecks expected file type, byte count, and SHA-256 against the analyzed inventory.

### HTTPS ZIP

HTTPS acquisition:

- accepts credential-free `https:` URLs on port 443 only;
- rejects URL queries and fragments so credentials are not persisted through signed/query URLs;
- supports an exact hostname allowlist;
- resolves all destination addresses and rejects the destination if any address is not public unicast;
- connects to one validated IP directly while retaining the original hostname for TLS SNI, certificate validation, and the HTTP `Host` header;
- does not use an HTTP proxy;
- rejects redirects, content encodings, non-ZIP media types, non-200 responses, and declared or streamed bytes above the configured limit; and
- hashes the private archive snapshot before the existing hostile-ZIP parser analyzes it.

The default archive download limit is 30 MiB and the default DNS/socket timeout is 30 seconds in the harvest service.

### HTTPS Git

Git acquisition accepts HTTPS only and validates/pins the destination using the same public-address policy. NEXUS invokes the trusted system Git binary without a shell and uses:

- a bare, depth-one, single-branch, no-tag clone;
- an empty template and `/dev/null` hook path;
- disabled credentials, terminal prompts, proxies, redirects, and non-HTTPS Git protocols;
- `http.curloptResolve` to pin Git/libcurl to the previously validated address set;
- fetch/transfer object checking followed by strict `git fsck`;
- bounded process time, output, and monitored staging-directory growth; and
- `rev-parse`, `ls-tree`, and `cat-file` plumbing only.

NEXUS never checks out the imported tree. It rejects submodules, symlinks, special modes, unsafe paths, oversized blobs, excessive file counts, and ambiguous repositories containing multiple `SKILL.md` roots unless `--skill-path` selects one. Selected regular blobs are materialized with non-executable permissions and then passed through canonical analysis.

The directory-growth monitor samples during clone and performs a strict post-clone size check. A filesystem quota remains necessary for a hard hostile-storage boundary in a future worker deployment. Remote Git acquisition has not been certified on Windows; the verified environment is Linux.

## Static security scan

`nexus.static-skill@1` reads only inventory-verified bytes and emits normalized findings with stable fingerprints and SHA-256 evidence hashes rather than matched secret values. Current rule families cover:

- private-key, cloud-key, token, and credential-assignment shapes;
- policy override and secret-exfiltration instructions;
- remote-content-to-shell, destructive deletion, privilege escalation, dynamic evaluation, network shell, and host credential paths;
- insecure, loopback, local, and metadata-service URLs;
- package lifecycle scripts, non-registry dependency sources, floating/ranged versions, and excessive dependency surfaces;
- hook paths, powerful tool declarations, executable source permissions, native executable magic, opaque binaries, and large encoded payloads.

This is deterministic static analysis, not an antivirus engine, dependency advisory resolver, malware sandbox, DLP certification, or proof of absence. Imported dependencies are never installed during harvest. Unknown binary formats are labeled for review; native ELF/PE/Mach-O images produce critical findings.

## License review

The license stage separately records:

1. the bounded declaration from `SKILL.md`;
2. whether `spdx-expression-parse` accepts its SPDX expression syntax and identifier set;
3. conservative text-signature detections in conventional license files;
4. evidence file names and hashes; and
5. whether human review remains required.

Statuses are `missing`, `spdx-syntax-valid`, `detected`, `consistent`, `conflict`, or `needs-review`. `consistent` means only that a parsed declaration and detected evidence agree. Signature-only or compound-expression matches remain review-required; only a supported exact normalized template match can clear automatic review (currently the canonical MIT body with a variable copyright line). Every review records `legalConclusion: false`; NEXUS does not provide legal advice or claim that rights, authorship, notices, exceptions, or obligations were legally verified. A syntactically valid declaration without matching file evidence remains review-required.

## Assessment and scores

`nexus.harvest-policy@1` deterministically derives a candidate or quarantine disposition. Critical/high static risk, review-required license state, or exact-content duplication blocks candidate registration.

Measured score dimensions carry a 0–100 value, confidence, method-specific evidence, and description:

- security: scanner version, risk, findings, and coverage;
- quality: declared description/instruction completeness and static package structure;
- documentation: headings, examples, constraints, and references;
- tests: static test/fixture presence, explicitly recording that tests were not run; and
- context efficiency: deterministic byte-based token estimate and package shape.

Maintenance remains `null` because harvest does not yet have a reliable, source-independent maintenance signal. Compatibility also remains null in canonical registry metadata. Registry metadata converts measured values to 0–1. Null means unmeasured, never zero. These static scores do not measure behavioral task success.

## Duplicate proposals

Exact duplicates use canonical payload SHA-256 and are labeled `exact-content-sha256`. Near-duplicate proposals use character-trigram Jaccard similarity over normalized name, description, and candidate tags versus existing name/description metadata. They are labeled `near-metadata-character-trigram-jaccard-v1`; they are not represented as semantic or content-equivalent matches. Comparison fails explicitly above 10,000 project versions and returns at most the 100 highest-ranked proposals, prioritizing exact matches.

## Disposition and persistence

- **Inspect only:** records the harvest, scan, license review, assessment, and duplicate proposals, then deletes acquisition staging.
- **Quarantine:** atomically copies inventory-verified bytes under the managed quarantine directory, writes a data-only quarantine record, and removes every executable bit. Quarantined content is not registered.
- **Candidate registration:** emits metadata schema v2, links scan/assessment/license provenance, and registers the version with Skill status `candidate`. Candidate versions do not become the current active version and normal Skill search excludes them.

Trust evidence is persisted in schema v5 tables for harvest runs, scans, reviews, deterministic assessments, and duplicate proposals. Database evidence writes are transactional; Skill and quarantine filesystem publication use private staging and atomic rename. This local SQLite implementation is still single-operator and is not a multi-tenant production trust service.

## CLI

```bash
# Inspect a local source without retaining its payload
nexus skill harvest ./path/to/skill --inspect-only --json

# Download and assess an HTTPS ZIP from an exact allowed host
nexus skill harvest https://downloads.example.org/skill.zip \
  --type https-archive --allow-host downloads.example.org --inspect-only --json

# Select one Skill from a pinned HTTPS Git branch and retain according to policy
nexus skill harvest https://github.com/example/repository.git \
  --type git-repository --ref v1.2.3 --skill-path skills/reviewer \
  --allow-host github.com --register --json
```

`--register` never overrides quarantine policy. A retained quarantine returns CLI exit code 2; command or validation failures return 1. `--inspect-only` and `--register` are mutually exclusive. The older direct `skill install` path is reserved for explicit operator-authored local input and now requires `--trusted-local-authoring`; untrusted input belongs in `skill harvest`.

## Remaining gates

NEXUS still blocks imported execution. Promotion, centralized policy/approval, sandboxed behavioral evaluation, dependency resolution/advisory analysis, SBOM generation, artifact signatures, malware detonation, worker/container isolation, tenant authorization, and durable external audit remain future gates. Registry-signature verification is also not claimed when the Sigstore TUF endpoint is unavailable.

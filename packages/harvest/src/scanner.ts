import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { deterministicId, NexusError } from '@nexus-ai/core';
import type { SkillAnalysis, SkillInventoryEntry } from '@nexus-ai/skills';

import {
  DEFAULT_HARVEST_LIMITS,
  type HarvestLimits,
  type StaticFinding,
  type StaticScanResult,
  validateHarvestLimits,
} from './types.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

interface TextRule {
  readonly id: string;
  readonly severity: StaticFinding['severity'];
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
  readonly pattern: RegExp;
  readonly kinds?: readonly SkillInventoryEntry['kind'][];
}

const TEXT_RULES: readonly TextRule[] = [
  {
    id: 'secret.private-key',
    severity: 'critical',
    title: 'Private key material detected',
    description: 'A file contains a private-key boundary marker.',
    remediation: 'Remove the key and rotate any credential that may have been exposed.',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
  },
  {
    id: 'secret.aws-access-key',
    severity: 'critical',
    title: 'AWS access-key-shaped value detected',
    description: 'A file contains a value shaped like an AWS access key identifier.',
    remediation: 'Remove the credential and rotate it through the provider.',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    id: 'secret.github-token',
    severity: 'critical',
    title: 'GitHub-token-shaped value detected',
    description: 'A file contains a value shaped like a GitHub access token.',
    remediation: 'Remove the credential and revoke it through GitHub.',
    pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,255}\b/gu,
  },
  {
    id: 'secret.assignment',
    severity: 'high',
    title: 'Credential assignment detected',
    description: 'A file contains a credential-like assignment with a substantial value.',
    remediation: 'Replace embedded credentials with a secret reference.',
    pattern:
      /\b(?:api[_-]?key|password|private[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9+/_.=-]{12,}/giu,
  },
  {
    id: 'instruction.policy-override',
    severity: 'high',
    title: 'Policy-override instruction detected',
    description: 'Instructions attempt to override prior, system, developer, or security policy.',
    remediation: 'Remove authority-escalation language and express only task-local behavior.',
    pattern:
      /\b(?:ignore|disregard|override|bypass)\s+(?:all\s+)?(?:previous|prior|system|developer|security|policy)\b/giu,
    kinds: ['instructions', 'reference'],
  },
  {
    id: 'instruction.secret-exfiltration',
    severity: 'critical',
    title: 'Secret-exfiltration instruction detected',
    description: 'Instructions request credential discovery or transmission.',
    remediation: 'Remove credential access and exfiltration behavior.',
    pattern:
      /\b(?:exfiltrat\w*|steal|send|upload)\b.{0,80}\b(?:credential|secret|token|password|private key)\b/giu,
    kinds: ['instructions', 'reference', 'script'],
  },
  {
    id: 'script.remote-pipe-shell',
    severity: 'critical',
    title: 'Remote content piped to a shell',
    description: 'A script downloads remote content and sends it directly to a shell.',
    remediation: 'Pin, verify, and inspect downloaded artifacts before any governed execution.',
    pattern: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:ba|z|k)?sh\b/giu,
    kinds: ['script'],
  },
  {
    id: 'script.destructive-delete',
    severity: 'high',
    title: 'Broad destructive deletion detected',
    description: 'A script contains recursive forced deletion of a broad path.',
    remediation: 'Constrain deletion to an explicit sandbox path with precondition checks.',
    pattern: /\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-rf|-fr)\s+(?:\/|~|\$HOME|\.\.)/gu,
    kinds: ['script'],
  },
  {
    id: 'script.privilege-escalation',
    severity: 'high',
    title: 'Privilege escalation command detected',
    description: 'A script requests elevated host privileges.',
    remediation:
      'Remove host privilege escalation; execution must remain inside policy-controlled isolation.',
    pattern: /\b(?:sudo|doas)\b/gu,
    kinds: ['script'],
  },
  {
    id: 'script.dynamic-evaluation',
    severity: 'medium',
    title: 'Dynamic command evaluation detected',
    description: 'A script uses a dynamic evaluation primitive.',
    remediation: 'Replace dynamic evaluation with parsed, allowlisted arguments.',
    pattern: /\b(?:eval|exec)\s+["'$`]/gu,
    kinds: ['script'],
  },
  {
    id: 'script.network-shell',
    severity: 'critical',
    title: 'Network shell behavior detected',
    description: 'A script contains a reverse-shell or raw network-shell primitive.',
    remediation: 'Remove network shell behavior.',
    pattern: /(?:\/dev\/tcp\/|\bnc\s+[^\n]{0,100}\s-e\b|\bnetcat\b[^\n]{0,100}\s-e\b)/gu,
    kinds: ['script'],
  },
  {
    id: 'script.credential-path',
    severity: 'high',
    title: 'Credential filesystem path detected',
    description: 'A script references a common host credential location.',
    remediation: 'Use an explicit, narrowly scoped secret reference supplied by policy.',
    pattern: /(?:~\/\.ssh|\/\.aws\/credentials|\/\.config\/gcloud|\/etc\/shadow|\.netrc)\b/gu,
    kinds: ['script'],
  },
  {
    id: 'content.obfuscated-payload',
    severity: 'medium',
    title: 'Large encoded payload detected',
    description: 'A file contains a long encoded sequence that reduces reviewability.',
    remediation: 'Replace opaque payloads with attributable source or documented assets.',
    pattern: /(?:[A-Za-z0-9+/]{400,}={0,2}|\b[0-9a-f]{600,}\b)/gu,
  },
  {
    id: 'network.insecure-url',
    severity: 'medium',
    title: 'Insecure remote URL detected',
    description: 'Content references an unencrypted HTTP endpoint.',
    remediation: 'Use an authenticated HTTPS endpoint and pin the expected source.',
    pattern: /\bhttp:\/\/[^\s<>"')]+/giu,
  },
  {
    id: 'network.local-target',
    severity: 'high',
    title: 'Local or metadata-service target detected',
    description: 'Content references a loopback, local, or cloud metadata destination.',
    remediation: 'Remove internal destinations; network access must be policy allowlisted.',
    pattern:
      /\b(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|169\.254\.169\.254|metadata\.google\.internal)\b/giu,
  },
];

export async function scanSkill(
  root: string,
  analysis: SkillAnalysis,
  limits: Readonly<HarvestLimits> = DEFAULT_HARVEST_LIMITS,
): Promise<StaticScanResult> {
  validateHarvestLimits(limits);
  const findings: StaticFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedBinaryFiles = 0;

  for (const resource of analysis.inventory) {
    const content = await readVerifiedFile(root, resource);
    if (/(?:^|\/)(?:hooks?|\.githooks)(?:\/|$)/iu.test(resource.path)) {
      findings.push(
        directFinding(
          'manifest.hook-file',
          'high',
          'Executable hook surface detected',
          'The package includes a hook file that could execute outside the Skill runtime.',
          resource.path,
          null,
          resource.sha256,
          'Remove hooks or model the behavior as an explicit governed tool.',
        ),
      );
    }
    const magicFinding = inspectBinaryMagic(resource, content);
    if (magicFinding !== null) findings.push(magicFinding);
    if (resource.executableInSource) {
      findings.push(
        directFinding(
          'permission.executable-source',
          resource.kind === 'script' ? 'low' : 'high',
          'Executable source permission detected',
          'The source marks a package file as executable.',
          resource.path,
          null,
          resource.sha256,
          'Keep imported files non-executable and require governed execution policy.',
        ),
      );
    }
    if (!isTextResource(resource, content)) {
      skippedBinaryFiles += 1;
      if (magicFinding === null) {
        findings.push(
          directFinding(
            'binary.opaque-content',
            resource.kind === 'script' ? 'high' : 'low',
            'Opaque binary content detected',
            'A non-text package file could not be statically inspected as instructions or code.',
            resource.path,
            null,
            resource.sha256,
            'Provide attributable source or subject the artifact to a dedicated binary analyzer.',
          ),
        );
      }
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      skippedBinaryFiles += 1;
      findings.push(
        directFinding(
          'content.invalid-utf8',
          resource.kind === 'script' ? 'high' : 'medium',
          'Invalid UTF-8 text resource detected',
          'A resource declared as text cannot be decoded as strict UTF-8.',
          resource.path,
          null,
          resource.sha256,
          'Replace the resource with valid UTF-8 or classify it as an attributable binary asset.',
        ),
      );
      continue;
    }
    scannedFiles += 1;
    scannedBytes += content.byteLength;
    if (scannedBytes > limits.maxScannedTextBytes) {
      throw scannerError('HARVEST_SCAN_LIMIT', 'Text scanning exceeded its total byte limit');
    }
    const lineStarts = indexLineStarts(text);
    for (const rule of TEXT_RULES) {
      if (rule.kinds !== undefined && !rule.kinds.includes(resource.kind)) continue;
      rule.pattern.lastIndex = 0;
      for (const match of text.matchAll(rule.pattern)) {
        const matched = match[0];
        const offset = match.index;
        findings.push(createFinding(rule, resource.path, lineAt(lineStarts, offset), matched));
        if (findings.length >= 500) {
          throw scannerError('HARVEST_FINDING_LIMIT', 'Static scan produced too many findings');
        }
      }
    }
    if (path.posix.basename(resource.path) === 'package.json') {
      findings.push(...inspectPackageManifest(resource.path, text));
    }
  }

  if (findings.length > 500) {
    throw scannerError('HARVEST_FINDING_LIMIT', 'Static scan produced too many findings');
  }
  const declaredTools = analysis.frontmatter?.['allowed-tools'] ?? '';
  for (const tool of declaredTools.split(/\s+/u).filter(Boolean)) {
    if (/^(?:bash|shell|exec|write|edit|computer)/iu.test(tool)) {
      findings.push(
        directFinding(
          'permission.powerful-tool',
          'medium',
          'Powerful tool declaration detected',
          'The Skill declares a tool capable of execution, mutation, or broad computer control.',
          'SKILL.md',
          null,
          createHash('sha256').update(tool).digest('hex'),
          'Constrain the declaration and enforce permissions through policy at runtime.',
        ),
      );
    }
  }

  if (findings.length > 500) {
    throw scannerError('HARVEST_FINDING_LIMIT', 'Static scan produced too many findings');
  }
  const deduplicated = [
    ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
  ].sort((left, right) =>
    left.path === right.path
      ? (left.line ?? 0) - (right.line ?? 0) || left.ruleId.localeCompare(right.ruleId)
      : Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return {
    scannerVersion: 'nexus.static-skill@1',
    risk: riskFromFindings(deduplicated),
    findings: deduplicated,
    scannedFiles,
    scannedBytes,
    skippedBinaryFiles,
  };
}

async function readVerifiedFile(root: string, resource: SkillInventoryEntry): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path.join(root, ...resource.path.split('/')),
      fsConstants.O_RDONLY | O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== resource.bytes) {
      throw scannerError('HARVEST_SOURCE_CHANGED', `Source changed before scan: ${resource.path}`);
    }
    const content = await handle.readFile();
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== resource.bytes || digest !== resource.sha256) {
      throw scannerError('HARVEST_SOURCE_CHANGED', `Source changed during scan: ${resource.path}`);
    }
    return content;
  } finally {
    await handle?.close();
  }
}

function inspectBinaryMagic(resource: SkillInventoryEntry, content: Buffer): StaticFinding | null {
  const elf = content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const pe = content.subarray(0, 2).equals(Buffer.from('MZ'));
  const macho = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']).has(
    content.subarray(0, 4).toString('hex'),
  );
  if (!elf && !pe && !macho) return null;
  return directFinding(
    'binary.native-executable',
    'critical',
    'Native executable detected',
    'The package contains a native executable image.',
    resource.path,
    null,
    resource.sha256,
    'Remove native executables or submit attributable source for isolated review.',
  );
}

function isTextResource(resource: SkillInventoryEntry, content: Buffer): boolean {
  if (
    resource.mediaType.startsWith('text/') ||
    resource.mediaType === 'application/json' ||
    resource.mediaType === 'application/yaml' ||
    resource.mediaType === 'application/xml'
  ) {
    return !content.subarray(0, Math.min(content.length, 8_192)).includes(0);
  }
  return false;
}

function inspectPackageManifest(relativePath: string, text: string): readonly StaticFinding[] {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return [
      directFinding(
        'manifest.invalid-json',
        'medium',
        'Invalid package manifest',
        'package.json is not valid JSON.',
        relativePath,
        null,
        createHash('sha256').update(text).digest('hex'),
        'Replace it with strict valid JSON.',
      ),
    ];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const manifest = value as Record<string, unknown>;
  const findings: StaticFinding[] = [];
  const scripts = manifest['scripts'];
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
    const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'];
    const keys = Object.keys(scripts);
    if (keys.length > 0) {
      findings.push(
        directFinding(
          'manifest.lifecycle-scripts',
          keys.some((key) => lifecycle.includes(key)) ? 'high' : 'medium',
          'Package lifecycle scripts declared',
          'A package manifest declares commands that package tooling can execute.',
          relativePath,
          null,
          createHash('sha256').update(keys.sort().join('\0')).digest('hex'),
          'Do not install dependencies during harvesting; review scripts before sandboxed use.',
        ),
      );
    }
  }
  const dependencySections = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ];
  const dependencyEntries: [string, string][] = [];
  for (const section of dependencySections) {
    const dependencies = manifest[section];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, specification] of Object.entries(dependencies)) {
      if (typeof specification === 'string') dependencyEntries.push([name, specification]);
    }
  }
  if (dependencyEntries.length > 500) {
    findings.push(
      directFinding(
        'dependency.excessive-count',
        'high',
        'Excessive dependency surface detected',
        'The package manifest declares more than 500 dependency entries.',
        relativePath,
        null,
        createHash('sha256').update(String(dependencyEntries.length)).digest('hex'),
        'Reduce the dependency surface and provide a reviewed lockfile.',
      ),
    );
  }
  const remoteDependencies = dependencyEntries.filter(([, specification]) =>
    /^(?:https?:|git(?:\+|:)|github:|file:|link:)/iu.test(specification),
  );
  if (remoteDependencies.length > 0) {
    findings.push(
      directFinding(
        'dependency.non-registry-source',
        'high',
        'Non-registry dependency source detected',
        'Dependencies reference Git, URL, file, or link sources with separate trust boundaries.',
        relativePath,
        null,
        createHash('sha256')
          .update(
            remoteDependencies
              .map(([name]) => name)
              .sort()
              .join('\0'),
          )
          .digest('hex'),
        'Use immutable registry versions with lockfile integrity and provenance review.',
      ),
    );
  }
  const floatingDependencies = dependencyEntries.filter(([, specification]) =>
    /^(?:\*|latest|next|workspace:\*)$/iu.test(specification),
  );
  if (floatingDependencies.length > 0) {
    findings.push(
      directFinding(
        'dependency.floating-version',
        'medium',
        'Floating dependency version detected',
        'Dependencies include floating versions that do not identify reproducible artifacts.',
        relativePath,
        null,
        createHash('sha256')
          .update(
            floatingDependencies
              .map(([name]) => name)
              .sort()
              .join('\0'),
          )
          .digest('hex'),
        'Pin immutable versions and commit a lockfile with integrity hashes.',
      ),
    );
  }
  const rangedDependencies = dependencyEntries.filter(([, specification]) =>
    /(?:^[~^]|[<>=|])/u.test(specification),
  );
  if (rangedDependencies.length > 0) {
    findings.push(
      directFinding(
        'dependency.unpinned-range',
        'low',
        'Dependency version range detected',
        'Dependencies include ranges; static harvesting did not resolve or install them.',
        relativePath,
        null,
        createHash('sha256')
          .update(
            rangedDependencies
              .map(([name]) => name)
              .sort()
              .join('\0'),
          )
          .digest('hex'),
        'Use a reviewed lockfile and verify registry integrity before sandboxed installation.',
      ),
    );
  }
  return findings;
}

function createFinding(
  rule: TextRule,
  relativePath: string,
  line: number,
  matched: string,
): StaticFinding {
  const evidence = rule.id.startsWith('secret.')
    ? [rule.id, relativePath, String(line)].join('\0')
    : matched;
  return directFinding(
    rule.id,
    rule.severity,
    rule.title,
    rule.description,
    relativePath,
    line,
    createHash('sha256').update(evidence).digest('hex'),
    rule.remediation,
  );
}

function directFinding(
  ruleId: string,
  severity: StaticFinding['severity'],
  title: string,
  description: string,
  relativePath: string,
  line: number | null,
  evidenceSha256: string,
  remediation: string,
): StaticFinding {
  const fingerprint = createHash('sha256')
    .update([ruleId, relativePath, String(line ?? 0), evidenceSha256].join('\0'))
    .digest('hex');
  return {
    id: deterministicId('finding', fingerprint),
    ruleId,
    severity,
    title,
    description,
    path: relativePath,
    line,
    evidenceSha256,
    remediation,
    fingerprint,
  };
}

function indexLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function riskFromFindings(findings: readonly StaticFinding[]): StaticScanResult['risk'] {
  if (findings.some((finding) => finding.severity === 'critical')) return 'critical';
  if (findings.some((finding) => finding.severity === 'high')) return 'high';
  if (findings.some((finding) => finding.severity === 'medium')) return 'medium';
  return 'low';
}

function scannerError(code: string, message: string): NexusError {
  return new NexusError({ code, component: 'harvest.scanner', severity: 'high', message });
}

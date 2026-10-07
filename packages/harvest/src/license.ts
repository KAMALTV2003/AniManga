import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { NexusError } from '@nexus-ai/core';
import type { SkillAnalysis, SkillInventoryEntry } from '@nexus-ai/skills';
import parseSpdx from 'spdx-expression-parse';

import {
  DEFAULT_HARVEST_LIMITS,
  validateHarvestLimits,
  type HarvestLimits,
  type LicenseReview,
} from './types.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW;
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:\.[A-Za-z0-9._-]+)?$/iu;

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const LICENSE_SIGNATURES: readonly {
  readonly id: string;
  readonly required: readonly string[];
  readonly excluded?: readonly string[];
}[] = [
  {
    id: 'Apache-2.0',
    required: [
      'apache license',
      'version 2.0, january 2004',
      'http://www.apache.org/licenses/',
      'terms and conditions for use, reproduction, and distribution',
      'grant of copyright license',
      'grant of patent license',
      'submission of contributions',
      'trademarks. this license does not grant permission',
      'disclaimer of warranty',
      'limitation of liability',
    ],
  },
  {
    id: 'MIT',
    required: [
      'permission is hereby granted, free of charge, to any person obtaining a copy',
      'to deal in the software without restriction',
      'the above copyright notice and this permission notice',
      'the software is provided "as is", without warranty of any kind',
      'in no event shall the authors or copyright holders be liable',
    ],
  },
  {
    id: 'ISC',
    required: [
      'permission to use, copy, modify, and/or distribute this software for any purpose',
      'the software is provided "as is"',
    ],
    excluded: ['permission is hereby granted, free of charge'],
  },
  {
    id: 'BSD-3-Clause',
    required: [
      'redistribution and use in source and binary forms',
      'neither the name of the copyright holder nor the names of its contributors',
    ],
  },
  {
    id: 'BSD-2-Clause',
    required: [
      'redistribution and use in source and binary forms',
      'this software is provided by the copyright holders and contributors "as is"',
    ],
    excluded: ['neither the name of the copyright holder'],
  },
  {
    id: 'MPL-2.0',
    required: ['mozilla public license version 2.0', 'http://mozilla.org/MPL/2.0/'],
  },
  {
    id: 'GPL-3.0-only',
    required: ['gnu general public license', 'version 3, 29 june 2007'],
  },
];

export async function reviewSkillLicense(
  root: string,
  analysis: SkillAnalysis,
  limits: Readonly<HarvestLimits> = DEFAULT_HARVEST_LIMITS,
): Promise<LicenseReview> {
  validateHarvestLimits(limits);
  const declaration = analysis.frontmatter?.license?.trim() || null;
  const spdx = parseExpression(declaration);
  const licenseResources = analysis.inventory.filter((resource) =>
    LICENSE_FILE.test(path.posix.basename(resource.path)),
  );
  const detected = new Set<string>();
  const strongDetected = new Set<string>();
  const evidenceFiles: string[] = [];
  const evidenceHashes: Record<string, string> = {};
  for (const resource of licenseResources) {
    if (resource.bytes > limits.maxLicenseFileBytes) continue;
    const content = await readVerified(root, resource);
    if (content.includes(0)) continue;
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      continue;
    }
    const text = decoded.toLowerCase().replace(/\s+/gu, ' ');
    if (isCanonicalMitLicense(decoded)) strongDetected.add('MIT');
    for (const signature of LICENSE_SIGNATURES) {
      if (
        signature.required.every((fragment) => text.includes(fragment.toLowerCase())) &&
        !(signature.excluded ?? []).some((fragment) => text.includes(fragment.toLowerCase()))
      ) {
        detected.add(signature.id);
      }
    }
    evidenceFiles.push(resource.path);
    evidenceHashes[resource.path] = resource.sha256;
  }

  const detectedIds = [...detected].sort();
  const declaredIds = spdx === null ? [] : collectLicenseIds(spdx.parsed);
  const referencedFile = resolveDeclaredLicenseFile(declaration, licenseResources);
  let status: LicenseReview['status'];
  let reviewRequired: boolean;
  if (declaration === null && detectedIds.length === 0) {
    status = 'missing';
    reviewRequired = true;
  } else if (spdx !== null && detectedIds.some((id) => !declaredIds.includes(id))) {
    status = 'conflict';
    reviewRequired = true;
  } else if (spdx !== null && detectedIds.some((id) => declaredIds.includes(id))) {
    status = 'consistent';
    reviewRequired = !(
      declaredIds.length === 1 &&
      detectedIds.length === 1 &&
      strongDetected.has(declaredIds[0] ?? '')
    );
  } else if (referencedFile !== null && detectedIds.length === 1) {
    status = 'consistent';
    reviewRequired = !strongDetected.has(detectedIds[0] ?? '');
  } else if (spdx !== null) {
    status = 'spdx-syntax-valid';
    reviewRequired = true;
  } else if (detectedIds.length > 0) {
    status = 'detected';
    reviewRequired = true;
  } else {
    status = 'needs-review';
    reviewRequired = true;
  }

  const spdxExpression = spdx?.expression ?? null;
  return {
    declaration,
    spdxExpression,
    detectedIds,
    evidenceFiles: evidenceFiles.sort(),
    status,
    reviewRequired,
    evidence: {
      declarationSyntaxValid: spdx !== null,
      declaredIds,
      referencedFile,
      evidenceHashes,
      exactTemplateMatches: [...strongDetected].sort(),
      detectionMethod: 'nexus.license-signatures-and-exact-templates@1',
      legalConclusion: false,
    },
    canonical: {
      declaration,
      status,
      spdxExpression,
      detectedIds,
      reviewRequired,
    },
  };
}

function isCanonicalMitLicense(input: string): boolean {
  const lines = input
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines[0]?.toLowerCase() !== 'mit license') return false;
  if (!/^copyright\s+\(c\)\s+.+/iu.test(lines[1] ?? '')) return false;
  const body = lines.slice(2).join(' ').replace(/\s+/gu, ' ').toLowerCase();
  return body === MIT_BODY.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function parseExpression(declaration: string | null): {
  readonly expression: string;
  readonly parsed: ReturnType<typeof parseSpdx>;
} | null {
  if (declaration === null || declaration.length > 512) return null;
  try {
    return { expression: declaration, parsed: parseSpdx(declaration) };
  } catch {
    return null;
  }
}

function collectLicenseIds(node: ReturnType<typeof parseSpdx>): readonly string[] {
  if ('license' in node) return [node.license];
  return [...new Set([...collectLicenseIds(node.left), ...collectLicenseIds(node.right)])].sort();
}

function resolveDeclaredLicenseFile(
  declaration: string | null,
  resources: readonly SkillInventoryEntry[],
): string | null {
  if (declaration === null) return null;
  const candidate = declaration
    .replace(/^see\s+/iu, '')
    .replace(/^file:/iu, '')
    .trim();
  return (
    resources.find((resource) => resource.path.toLowerCase() === candidate.toLowerCase())?.path ??
    null
  );
}

async function readVerified(root: string, resource: SkillInventoryEntry): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path.join(root, ...resource.path.split('/')),
      fsConstants.O_RDONLY | O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== resource.bytes) {
      throw licenseError(
        'HARVEST_LICENSE_SOURCE_CHANGED',
        `License file changed: ${resource.path}`,
      );
    }
    const content = await handle.readFile();
    if (createHash('sha256').update(content).digest('hex') !== resource.sha256) {
      throw licenseError(
        'HARVEST_LICENSE_SOURCE_CHANGED',
        `License file changed: ${resource.path}`,
      );
    }
    return content;
  } finally {
    await handle?.close();
  }
}

function licenseError(code: string, message: string): NexusError {
  return new NexusError({ code, component: 'harvest.license', severity: 'high', message });
}

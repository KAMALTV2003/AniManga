import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NexusSkillMetadataV1Schema, NexusSkillMetadataV2Schema } from '@nexus-ai/skills';
import { describe, expect, it } from 'vitest';

interface JsonSchemaDocument {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

describe('canonical Skill metadata schema', () => {
  it('ships a strict JSON Schema synchronized with the runtime field set', async () => {
    const value = JSON.parse(
      await readFile(path.resolve('packages/skills/schema/nexus-skill-v1.schema.json'), 'utf8'),
    ) as JsonSchemaDocument;
    const runtimeKeys = Object.keys(NexusSkillMetadataV1Schema.shape).sort();

    expect(value.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(value.$id).toBe('https://nexus-ai.dev/schemas/skill-metadata-v1.schema.json');
    expect(value.type).toBe('object');
    expect(value.additionalProperties).toBe(false);
    expect(Object.keys(value.properties ?? {}).sort()).toEqual(runtimeKeys);
    expect([...(value.required ?? [])].sort()).toEqual(runtimeKeys);
  });

  it('ships the strict trust-aware v2 JSON Schema synchronized with runtime fields', async () => {
    const value = JSON.parse(
      await readFile(path.resolve('packages/skills/schema/nexus-skill-v2.schema.json'), 'utf8'),
    ) as JsonSchemaDocument;
    const runtimeKeys = Object.keys(NexusSkillMetadataV2Schema.shape).sort();

    expect(value.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(value.$id).toBe('https://nexus-ai.dev/schemas/skill-metadata-v2.schema.json');
    expect(value.type).toBe('object');
    expect(value.additionalProperties).toBe(false);
    expect(Object.keys(value.properties ?? {}).sort()).toEqual(runtimeKeys);
    expect([...(value.required ?? [])].sort()).toEqual(runtimeKeys);
  });
});

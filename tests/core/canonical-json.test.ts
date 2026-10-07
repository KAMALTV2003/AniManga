import { stableStringify } from '@nexus-ai/core';
import { describe, expect, it } from 'vitest';

describe('canonical JSON', () => {
  it('sorts UTF-8 object keys recursively and normalizes negative zero', () => {
    expect(stableStringify({ z: -0, a: { y: 2, x: 1 }, list: [true, null, 'text'] })).toBe(
      '{"a":{"x":1,"y":2},"list":[true,null,"text"],"z":0}',
    );
  });

  it('rejects values that cannot produce deterministic JSON', () => {
    expect(() => stableStringify({ missing: undefined })).toThrow(/cannot encode undefined/u);
    expect(() => stableStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/u);
    expect(() => stableStringify(new Date())).toThrow(/plain objects/u);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/cyclic/u);
  });
});

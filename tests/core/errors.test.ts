import { describe, expect, it } from 'vitest';

import { NexusError, asNexusError, runWithTrace } from '@nexus-ai/core';

describe('NexusError', () => {
  it('serializes the required stable error contract and redacts secrets', () => {
    const serialized = runWithTrace({ traceId: 'trace_test' }, () =>
      new NexusError({
        code: 'TEST_FAILURE',
        message: 'request failed token=super-secret',
        component: 'test.component',
        severity: 'high',
        details: { apiKey: 'abc', nested: { password: 'def', safe: true } },
      }).toJSON(),
    );

    expect(serialized).toEqual({
      code: 'TEST_FAILURE',
      message: 'request failed token=[REDACTED]',
      component: 'test.component',
      retryable: false,
      severity: 'high',
      details: { apiKey: '[REDACTED]', nested: { password: '[REDACTED]', safe: true } },
      trace_id: 'trace_test',
    });
  });

  it('rejects malformed error codes', () => {
    expect(() => new NexusError({ code: 'bad', message: 'bad', component: 'test' })).toThrow(
      TypeError,
    );
  });

  it('preserves an existing NexusError through conversion', () => {
    const original = new NexusError({ code: 'EXISTING_ERROR', message: 'x', component: 'test' });
    expect(asNexusError(original, { code: 'FALLBACK_ERROR', component: 'fallback' })).toBe(
      original,
    );
  });
});

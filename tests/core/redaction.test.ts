import { describe, expect, it } from 'vitest';

import { redactText, redactValue } from '@nexus-ai/core';

describe('redaction', () => {
  it('redacts nested sensitive keys without mutating the source', () => {
    const source = {
      safe: 'value',
      note: 'password=not-a-real-secret',
      auth: { authorization: 'Bearer abc' },
      custom: 'secret-value',
    };
    const result = redactValue(source, ['custom']);
    expect(result).toEqual({
      safe: 'value',
      note: 'password=[REDACTED]',
      auth: { authorization: '[REDACTED]' },
      custom: '[REDACTED]',
    });
    expect(source.auth.authorization).toBe('Bearer abc');
  });

  it('redacts bearer credentials, assignment forms, and known token shapes in text', () => {
    expect(redactText('Authorization: Bearer abc.def token=xyz')).toBe(
      'Authorization: Bearer [REDACTED] token=[REDACTED]',
    );
    const providerToken = `sk-${'a'.repeat(24)}`;
    const githubToken = `ghp_${'b'.repeat(24)}`;
    expect(redactText(`provider=${providerToken} source=${githubToken}`)).toBe(
      'provider=[REDACTED] source=[REDACTED]',
    );
  });
});

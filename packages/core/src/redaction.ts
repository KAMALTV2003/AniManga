const DEFAULT_SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'credential',
  'password',
  'private_key',
  'privatekey',
  'secret',
  'token',
  'api_key',
  'apikey',
] as const;

const REDACTED = '[REDACTED]';

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

function isSensitiveKey(key: string, extraKeys: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  return [...DEFAULT_SENSITIVE_KEYS, ...extraKeys].some((candidate) =>
    normalized.includes(normalizeKey(candidate)),
  );
}

export function redactValue(value: unknown, extraKeys: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return redactText(current);
    }
    if (current === null || typeof current !== 'object') {
      return current;
    }

    if (seen.has(current)) {
      return '[CIRCULAR]';
    }
    seen.add(current);

    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
      };
    }

    if (Array.isArray(current)) {
      return current.map((item) => visit(item));
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      output[key] = isSensitiveKey(key, extraKeys) ? REDACTED : visit(nested);
    }
    return output;
  };

  return visit(value);
}

export function redactText(input: string): string {
  return input
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${REDACTED}`)
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, REDACTED)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    .replace(
      /\b(api[_-]?key|password|private[_-]?key|secret|token)\s*[:=]\s*([^\s,;]+)/giu,
      `$1=${REDACTED}`,
    );
}

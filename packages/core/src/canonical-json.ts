export type JSONPrimitive = string | number | boolean | null;
export type JSONValue =
  JSONPrimitive | readonly JSONValue[] | { readonly [key: string]: JSONValue };

export function stableStringify(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot encode cyclic values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON can only encode plain objects and arrays');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    );
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

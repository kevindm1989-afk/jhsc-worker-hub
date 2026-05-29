// Canonical JSON serializer used for chain hashing.
//
// Inspired by RFC 8785 (JSON Canonicalization Scheme). We do NOT
// implement the full RFC — that's overkill for our payload shape.
// We need:
//   - Deterministic key order (lexicographic by codepoint).
//   - No whitespace.
//   - Booleans/null literal.
//   - Numbers as JSON.stringify produces (integers + finite floats).
//   - Strings JSON.stringify'd (the rules for \u escapes are JSON's).
//   - Arrays preserve order.
//
// Payloads in this codebase are typed via @jhsc/shared-types
// AuditPayload — only plain objects, arrays, strings, finite numbers,
// booleans, and null. Date, BigInt, undefined, NaN, Infinity all throw
// (forcing the caller to pre-serialize timestamps to ISO strings, etc.).

export function canonicalJsonStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical-json: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => {
      const v = obj[k];
      if (v === undefined) {
        // RFC 8785 drops undefined-valued keys. Our payloads avoid
        // undefined; if a caller passes one, fail loud rather than
        // silently truncate.
        throw new Error(`canonical-json: undefined value at key "${k}"`);
      }
      return `${JSON.stringify(k)}:${stringify(v)}`;
    });
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonical-json: unsupported value type ${typeof value}`);
}

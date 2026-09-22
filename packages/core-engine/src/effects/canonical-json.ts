/**
 * @file RFC 8785 (JCS) subset canonical JSON — the byte form behind every deterministic digest in
 * the engine: `effect_key` / `request_fingerprint` (implement/04 §3.2.3) and the evidence
 * `payload_sha256` chain (§7).
 *
 * Canonical form: object keys sorted by UTF-16 code unit order, no insignificant whitespace, array
 * order preserved. The serializer is total-or-fail: a value with no canonical form raises
 * `CANONICAL_JSON_UNSUPPORTED` instead of degrading to `{}`, `undefined` or `null`, because
 * identity is keyed on the digest — two different payloads that canonicalized to the same bytes
 * would collapse into one external effect (BR-005).
 */

import { OrchestratorError } from '../contracts/types.js';

/**
 * Serializes a JSON value into its canonical byte string.
 *
 * @param value A value built from `null`, booleans, finite numbers, strings, arrays and plain
 *   objects (`Object.create(null)` is accepted alongside object literals).
 * @returns The canonical form: object keys sorted lexicographically, arrays in place, no
 *   insignificant whitespace. Independent of key insertion order.
 * @throws {OrchestratorError} `CANONICAL_JSON_UNSUPPORTED` for `undefined`, functions, symbols,
 *   bigint, non-finite numbers, non-plain objects (`Date`, `Map`, `Set`, class instances) and
 *   circular references.
 */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw unsupported(`the non-finite number ${String(value)}`);
      }
      // ECMAScript Number::toString is the shortest round-trip form RFC 8785 prescribes.
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (value === null) {
        return 'null';
      }
      return serializeObject(value, ancestors);
    default:
      // undefined, function, symbol, bigint.
      throw unsupported(`a value of type ${typeof value}`);
  }
}

function serializeObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw unsupported('a circular reference');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw unsupported(`the non-plain object ${Object.prototype.toString.call(value)}`);
    }
    const record = value as Record<string, unknown>;
    const pairs = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
    return `{${pairs.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function unsupported(detail: string): OrchestratorError {
  return new OrchestratorError(
    'CANONICAL_JSON_UNSUPPORTED',
    `${detail} has no canonical JSON form; only null, boolean, finite number, string, array and plain object are representable.`,
  );
}

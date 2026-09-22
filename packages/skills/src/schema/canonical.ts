/**
 * @file Canonical JSON for value comparison inside the schema validator.
 *
 * `enum`, `const` and `uniqueItems` compare by canonical form — object keys sorted, arrays in place,
 * no insignificant whitespace — so a member is compared by what it *is*, never by object identity,
 * and the result does not depend on property insertion order.
 */

/**
 * Serializes a value to its canonical JSON form.
 *
 * @param value A value built from `null`, booleans, finite numbers, strings, arrays and plain
 *   objects. A non-representable value (`undefined`, a function, a symbol, a non-finite number,
 *   a class instance) is named by its type instead of being coerced, so it can never compare equal
 *   to a real JSON member.
 * @returns The canonical string form.
 */
export function stableJson(value: unknown): string {
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : `["<non-finite number>"]`;
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (value === null) {
        return 'null';
      }
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(',')}]`;
      }
      return serializeObject(value);
    default:
      return `["<${typeof value}>"]`;
  }
}

/** Serializes a non-array object with its keys sorted, falling back to a type marker. */
function serializeObject(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return `["<non-plain object>"]`;
  }

  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${pairs.join(',')}}`;
}

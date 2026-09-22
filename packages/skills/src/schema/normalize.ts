/**
 * @file Payload normalization (implement/05 §6.3 "schema validation and normalization", §8
 * scenario 10).
 *
 * Normalization is what makes a refused payload and an accepted payload differ by contract rather
 * than by accident: a declared `default` is supplied from the schema, an undeclared member is
 * dropped only where the schema says `additionalProperties: false`, and nothing is ever coerced.
 * A value that still breaks the schema after that raises `SCHEMA_VALIDATION_ERROR` — zero adapter
 * calls follow.
 */

import { SkillError } from '../contracts/index.js';
import { describeViolations, validateAgainstSchema } from './validate.js';

/** Reports whether a value is a plain JSON object. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies a JSON value so a shared `default` can never be mutated through a normalized payload. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as unknown as T;
  }
  if (isJsonObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = cloneJson(value[key]);
    }
    return copy as unknown as T;
  }
  return value;
}

/** Reads the declared members of a node, or `undefined` when the node declares none. */
function declaredProperties(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  return isJsonObject(schema['properties']) ? (schema['properties'] as Record<string, unknown>) : undefined;
}

/** Normalizes one object node: strip what the schema rejects and supply what it declares. */
function normalizeObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const properties = declaredProperties(schema);
  const additional = schema['additionalProperties'];
  const normalized: Record<string, unknown> = {};

  for (const member of Object.keys(value)) {
    const subschema = properties === undefined ? undefined : properties[member];
    if (isJsonObject(subschema)) {
      // Registration guarantees every declared member maps to a schema object.
      normalized[member] = normalizeNode(subschema, value[member]);
      continue;
    }
    if (additional === false) {
      continue;
    }
    normalized[member] = isJsonObject(additional)
      ? normalizeNode(additional, value[member])
      : cloneJson(value[member]);
  }

  if (properties !== undefined) {
    for (const member of Object.keys(properties)) {
      if (Object.hasOwn(normalized, member) || Object.hasOwn(value, member)) {
        continue;
      }
      const subschema = properties[member];
      if (isJsonObject(subschema) && Object.hasOwn(subschema, 'default')) {
        normalized[member] = cloneJson(subschema['default']);
      }
    }
  }

  return normalized;
}

/** Normalizes one array node by recursing into `prefixItems` and `items`. */
function normalizeArray(schema: Record<string, unknown>, value: readonly unknown[]): readonly unknown[] {
  const prefixItems = schema['prefixItems'];
  const items = schema['items'];

  if (!Array.isArray(prefixItems) && !isJsonObject(items)) {
    return value;
  }

  return value.map((item, index) => {
    if (Array.isArray(prefixItems) && index < prefixItems.length) {
      const subschema = prefixItems[index];
      return isJsonObject(subschema) ? normalizeNode(subschema, item) : item;
    }
    return isJsonObject(items) ? normalizeNode(items, item) : item;
  });
}

/** Normalizes a value against one schema node, leaving anything the node does not describe alone. */
function normalizeNode(schema: Record<string, unknown>, value: unknown): unknown {
  if (isJsonObject(value)) {
    return normalizeObject(schema, value);
  }
  if (Array.isArray(value)) {
    return normalizeArray(schema, value);
  }
  return value;
}

/**
 * Normalizes a payload against a row's declared schema and refuses a non-conforming result.
 *
 * @param skill_id The row whose schema is being applied.
 * @param schema The declared `input_schema` or `output_schema`.
 * @param value The payload as received.
 * @returns The normalized payload, typed as the row's declared input or output.
 * @throws {SkillError} `SCHEMA_VALIDATION_ERROR`, listing every violation with its path.
 */
export function normalizeAgainstSchema<T>(
  skill_id: string,
  schema: Record<string, unknown>,
  value: unknown,
): T {
  const normalized = normalizeNode(schema, value);
  const violations = validateAgainstSchema(schema, normalized);

  if (violations.length > 0) {
    throw new SkillError(
      'SCHEMA_VALIDATION_ERROR',
      `payload does not satisfy the declared schema: ${describeViolations(violations)}`,
      skill_id,
    );
  }

  return normalized as T;
}

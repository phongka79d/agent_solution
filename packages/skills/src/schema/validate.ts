/**
 * @file Deterministic JSON Schema validation (implement/05 §2 `Input Validator`, §6.3 step "schema
 * validation and normalization", §8 scenario 10).
 *
 * `validateAgainstSchema` reports every violation and never throws, so a caller can either refuse
 * with the full list or use the empty result as a pass. The schema it is handed has already passed
 * {@link assertSupportedSchema} at registration, which is what makes the permissiveness safe: there
 * is no keyword here that would have to be ignored.
 */

import { stableJson } from './canonical.js';
import { matchesFormat } from './formats.js';

/** One failed constraint, located by path so a caller can point at the payload. */
export interface SchemaViolation {
  /** Path of the failing node: `$` for the root, then `.member`, then `[index]`. */
  readonly path: string;
  /** The JSON Schema keyword that failed. */
  readonly keyword: string;
  /** Human-readable detail; carries no contract. */
  readonly message: string;
}

/** Reports whether a value is a JSON object (never `null`, never an array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The declared `type` names of a node, or `undefined` when the keyword is absent. */
function declaredTypes(schema: Record<string, unknown>): readonly string[] | undefined {
  const declared = schema['type'];
  if (typeof declared === 'string') {
    return [declared];
  }
  return Array.isArray(declared) ? (declared as readonly string[]) : undefined;
}

/** Whether a value satisfies one JSON type name. Booleans are not numbers; `null` is its own type. */
function matchesType(name: string, value: unknown): boolean {
  switch (name) {
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isSafeInteger(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Names a received value for a violation message. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** Reads a numeric keyword, or `undefined` when it is absent or not a finite number. */
function readNumber(schema: Record<string, unknown>, keyword: string): number | undefined {
  const value = schema[keyword];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Appends one violation. */
function push(
  out: SchemaViolation[],
  path: string,
  keyword: string,
  message: string,
): void {
  out.push({ path, keyword, message });
}

/** Checks the numeric keyword family. */
function checkNumeric(schema: Record<string, unknown>, value: number, path: string, out: SchemaViolation[]): void {
  const minimum = readNumber(schema, 'minimum');
  if (minimum !== undefined && value < minimum) {
    push(out, path, 'minimum', `${value} is below the inclusive minimum ${minimum}`);
  }
  const maximum = readNumber(schema, 'maximum');
  if (maximum !== undefined && value > maximum) {
    push(out, path, 'maximum', `${value} is above the inclusive maximum ${maximum}`);
  }
  const exclusiveMinimum = readNumber(schema, 'exclusiveMinimum');
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    push(out, path, 'exclusiveMinimum', `${value} is not above the exclusive minimum ${exclusiveMinimum}`);
  }
  const exclusiveMaximum = readNumber(schema, 'exclusiveMaximum');
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
    push(out, path, 'exclusiveMaximum', `${value} is not below the exclusive maximum ${exclusiveMaximum}`);
  }
  const multipleOf = readNumber(schema, 'multipleOf');
  if (multipleOf !== undefined && multipleOf > 0 && Math.abs(value / multipleOf - Math.round(value / multipleOf)) > 1e-9) {
    push(out, path, 'multipleOf', `${value} is not a multiple of ${multipleOf}`);
  }
}

/** Checks the string keyword family. */
function checkString(schema: Record<string, unknown>, value: string, path: string, out: SchemaViolation[]): void {
  const minLength = readNumber(schema, 'minLength');
  if (minLength !== undefined && value.length < minLength) {
    push(out, path, 'minLength', `length ${value.length} is below minLength ${minLength}`);
  }
  const maxLength = readNumber(schema, 'maxLength');
  if (maxLength !== undefined && value.length > maxLength) {
    push(out, path, 'maxLength', `length ${value.length} exceeds maxLength ${maxLength}`);
  }
  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
    push(out, path, 'pattern', `value does not match ${pattern}`);
  }
  const format = schema['format'];
  if (typeof format === 'string' && !matchesFormat(format, value)) {
    push(out, path, 'format', `value is not a valid ${format}`);
  }
}

/** Checks the array keyword family, recursing into `prefixItems` and `items`. */
function checkArray(schema: Record<string, unknown>, value: readonly unknown[], path: string, out: SchemaViolation[]): void {
  const minItems = readNumber(schema, 'minItems');
  if (minItems !== undefined && value.length < minItems) {
    push(out, path, 'minItems', `${value.length} items is below minItems ${minItems}`);
  }
  const maxItems = readNumber(schema, 'maxItems');
  if (maxItems !== undefined && value.length > maxItems) {
    push(out, path, 'maxItems', `${value.length} items exceeds maxItems ${maxItems}`);
  }
  if (schema['uniqueItems'] === true) {
    const seen = new Set<string>();
    for (const item of value) {
      const form = stableJson(item);
      if (seen.has(form)) {
        push(out, path, 'uniqueItems', 'the array repeats an identical member');
        break;
      }
      seen.add(form);
    }
  }

  const prefixItems = schema['prefixItems'];
  if (Array.isArray(prefixItems)) {
    prefixItems.forEach((subschema, index) => {
      if (index < value.length && isJsonObject(subschema)) {
        collect(subschema, value[index], `${path}[${index}]`, out);
      }
    });
  }
  const items = schema['items'];
  if (isJsonObject(items)) {
    const from = Array.isArray(prefixItems) ? prefixItems.length : 0;
    for (let index = from; index < value.length; index += 1) {
      collect(items, value[index], `${path}[${index}]`, out);
    }
  }
}

/** Checks the object keyword family, recursing into `properties` and `additionalProperties`. */
function checkObject(schema: Record<string, unknown>, value: Record<string, unknown>, path: string, out: SchemaViolation[]): void {
  const properties = isJsonObject(schema['properties'])
    ? (schema['properties'] as Record<string, unknown>)
    : undefined;
  const declared = properties === undefined ? [] : Object.keys(properties);

  const minProperties = readNumber(schema, 'minProperties');
  if (minProperties !== undefined && Object.keys(value).length < minProperties) {
    push(out, path, 'minProperties', `${Object.keys(value).length} members is below minProperties ${minProperties}`);
  }
  const maxProperties = readNumber(schema, 'maxProperties');
  if (maxProperties !== undefined && Object.keys(value).length > maxProperties) {
    push(out, path, 'maxProperties', `${Object.keys(value).length} members exceeds maxProperties ${maxProperties}`);
  }

  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const member of [...(required as readonly string[])].sort()) {
      if (!Object.hasOwn(value, member)) {
        push(out, path, 'required', `required member '${member}' is absent`);
      }
    }
  }

  if (properties !== undefined) {
    for (const member of [...declared].sort()) {
      if (!Object.hasOwn(value, member)) {
        continue;
      }
      const subschema = properties[member];
      if (isJsonObject(subschema)) {
        collect(subschema, value[member], `${path}.${member}`, out);
      }
    }
  }

  const additional = schema['additionalProperties'];
  if (additional === false) {
    for (const member of Object.keys(value).sort()) {
      if (!declared.includes(member)) {
        push(out, path, 'additionalProperties', `member '${member}' is not declared by this schema`);
      }
    }
  } else if (isJsonObject(additional)) {
    for (const member of Object.keys(value).sort()) {
      if (!declared.includes(member)) {
        collect(additional, value[member], `${path}.${member}`, out);
      }
    }
  }
}

/** Checks the composition keyword family. */
function checkComposition(schema: Record<string, unknown>, value: unknown, path: string, out: SchemaViolation[]): void {
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    const passing = branches.filter((branch) => {
      const failures: SchemaViolation[] = [];
      if (isJsonObject(branch)) {
        collect(branch, value, path, failures);
      }
      return failures.length === 0;
    }).length;

    if (keyword === 'allOf' && passing !== branches.length) {
      push(out, path, 'allOf', 'the value does not satisfy every branch');
    }
    if (keyword === 'anyOf' && passing === 0) {
      push(out, path, 'anyOf', 'the value satisfies none of the branches');
    }
    if (keyword === 'oneOf' && passing !== 1) {
      push(out, path, 'oneOf', `the value satisfies ${passing} branch(es), exactly one is required`);
    }
  }

  const negated = schema['not'];
  if (isJsonObject(negated)) {
    const failures: SchemaViolation[] = [];
    collect(negated, value, path, failures);
    if (failures.length === 0) {
      push(out, path, 'not', 'the value satisfies a schema it must not satisfy');
    }
  }
}

/** Collects every violation of one node, in a deterministic order. */
function collect(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  out: SchemaViolation[],
): void {
  const types = declaredTypes(schema);
  if (types !== undefined && !types.some((name) => matchesType(name, value))) {
    push(out, path, 'type', `expected ${types.join(' or ')}, received ${describe(value)}`);
    return;
  }

  if (Object.hasOwn(schema, 'const') && stableJson(value) !== stableJson(schema['const'])) {
    push(out, path, 'const', 'the value differs from the declared constant');
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((member) => stableJson(member) === stableJson(value))) {
    push(out, path, 'enum', 'the value is not one of the declared members');
  }

  if (typeof value === 'number') {
    checkNumeric(schema, value, path, out);
  }
  if (typeof value === 'string') {
    checkString(schema, value, path, out);
  }
  if (Array.isArray(value)) {
    checkArray(schema, value, path, out);
  }
  if (isJsonObject(value)) {
    checkObject(schema, value, path, out);
  }

  checkComposition(schema, value, path, out);
}

/**
 * Validates a value against a schema that has already been asserted.
 *
 * @param schema A schema accepted by `assertSupportedSchema`.
 * @param value The value to check.
 * @returns Every violation, in deterministic order; an empty array means the value conforms.
 */
export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): readonly SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  collect(schema, value, '$', violations);
  return violations;
}

/** Formats violations as the single message a refusal carries, so no detail is lost. */
export function describeViolations(violations: readonly SchemaViolation[]): string {
  return violations
    .map((violation) => `${violation.path}: ${violation.keyword} ${violation.message}`)
    .join('; ');
}

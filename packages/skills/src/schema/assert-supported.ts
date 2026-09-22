/**
 * @file Registration-time capability gate for a declared schema (implement/05 §2, §6.1).
 *
 * This is where the fail-closed property is established: a schema is walked once, at registration,
 * and refused if it uses any construct the validator cannot enforce. Runtime validation may then
 * assume that every keyword it meets is one it understands, so a declared constraint is never
 * silently skipped — an unsupported construct can never reach a dispatched row.
 */

import { SkillError } from '../contracts/index.js';
import {
  SUBSCHEMA_KEYWORDS,
  SUBSCHEMA_LIST_KEYWORDS,
  SUBSCHEMA_MAP_KEYWORDS,
  SUPPORTED_FORMATS,
  SUPPORTED_SCHEMA_KEYWORDS,
  SUPPORTED_TYPE_NAMES,
} from './keywords.js';

/** Keywords whose value must be a string. */
const STRING_KEYWORDS: readonly string[] = Object.freeze(['$id', '$schema', 'description', 'title']);

/** Keywords whose value must be a boolean. */
const BOOLEAN_KEYWORDS: readonly string[] = Object.freeze(['deprecated', 'uniqueItems']);

/** Keywords whose value must be a finite number. */
const FINITE_NUMBER_KEYWORDS: readonly string[] = Object.freeze([
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maximum',
  'minimum',
]);

/** Keywords whose value must be a strictly positive finite number. */
const POSITIVE_NUMBER_KEYWORDS: readonly string[] = Object.freeze(['multipleOf']);

/** Keywords whose value must be a non-negative safe integer. */
const COUNT_KEYWORDS: readonly string[] = Object.freeze([
  'maxItems',
  'maxLength',
  'maxProperties',
  'minItems',
  'minLength',
  'minProperties',
]);

/** Keywords whose value must be an array of strings. */
const STRING_LIST_KEYWORDS: readonly string[] = Object.freeze(['examples', 'required']);

/** Keywords whose value must be a non-empty array. */
const NON_EMPTY_ARRAY_KEYWORDS: readonly string[] = Object.freeze(['enum']);

/** Throws the one registration refusal this module can produce. */
function refuse(skill_id: string, detail: string): never {
  throw new SkillError(
    'INVALID_SCHEMA',
    `${detail}; the deterministic validator refuses a schema it could not fully enforce`,
    skill_id,
  );
}

/** Walks a schema node, refusing any construct outside the supported vocabulary. */
function assertNode(node: unknown, path: string, skill_id: string): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    refuse(skill_id, `${path} is not a schema object`);
  }

  const record = node as Record<string, unknown>;
  for (const keyword of Object.keys(record).sort()) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.includes(keyword)) {
      refuse(skill_id, `${path}.${keyword} is a keyword the validator cannot enforce`);
    }
    assertKeyword(keyword, record[keyword], `${path}.${keyword}`, skill_id);
  }
}

/** Validates one keyword's value and recurses into the schema nodes it carries. */
function assertKeyword(
  keyword: string,
  value: unknown,
  path: string,
  skill_id: string,
): void {
  if (STRING_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'string') {
      refuse(skill_id, `${path} must be a string`);
    }
    return;
  }

  if (BOOLEAN_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'boolean') {
      refuse(skill_id, `${path} must be a boolean`);
    }
    return;
  }

  if (FINITE_NUMBER_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      refuse(skill_id, `${path} must be a finite number`);
    }
    return;
  }

  if (POSITIVE_NUMBER_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      refuse(skill_id, `${path} must be a strictly positive finite number`);
    }
    return;
  }

  if (COUNT_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      refuse(skill_id, `${path} must be a non-negative safe integer`);
    }
    return;
  }

  if (STRING_LIST_KEYWORDS.includes(keyword)) {
    if (!isStringArray(value, keyword === 'required')) {
      refuse(skill_id, `${path} must be an array of ${keyword === 'required' ? 'non-empty ' : ''}strings`);
    }
    return;
  }

  if (NON_EMPTY_ARRAY_KEYWORDS.includes(keyword)) {
    if (!Array.isArray(value) || value.length === 0) {
      refuse(skill_id, `${path} must be a non-empty array`);
    }
    return;
  }

  if (keyword === 'type') {
    assertTypeKeyword(value, path, skill_id);
    return;
  }

  if (keyword === 'format') {
    if (typeof value !== 'string' || !SUPPORTED_FORMATS.includes(value)) {
      refuse(skill_id, `${path} names a format with no deterministic check`);
    }
    return;
  }

  if (keyword === 'pattern') {
    if (typeof value !== 'string') {
      refuse(skill_id, `${path} must be a string`);
    }
    try {
      new RegExp(value);
    } catch {
      refuse(skill_id, `${path} is not a compilable regular expression`);
    }
    return;
  }

  if (SUBSCHEMA_KEYWORDS.includes(keyword)) {
    if (keyword === 'additionalProperties' && typeof value === 'boolean') {
      return;
    }
    assertNode(value, path, skill_id);
    return;
  }

  if (SUBSCHEMA_LIST_KEYWORDS.includes(keyword)) {
    if (!Array.isArray(value) || value.length === 0) {
      refuse(skill_id, `${path} must be a non-empty array of schema objects`);
    }
    value.forEach((item, index) => {
      assertNode(item, `${path}[${index}]`, skill_id);
    });
    return;
  }

  if (SUBSCHEMA_MAP_KEYWORDS.includes(keyword)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      refuse(skill_id, `${path} must be an object of schema objects`);
    }
    for (const member of Object.keys(value).sort()) {
      assertNode((value as Record<string, unknown>)[member], `${path}.${member}`, skill_id);
    }
    return;
  }

  // `const`, `default` and any other supported annotation: its value is a JSON value, not a schema.
}

/** `type` accepts one name or a non-empty list of distinct names from the supported set. */
function assertTypeKeyword(value: unknown, path: string, skill_id: string): void {
  const names = Array.isArray(value) ? value : [value];

  if (names.length === 0) {
    refuse(skill_id, `${path} must name at least one type`);
  }
  for (const name of names) {
    if (typeof name !== 'string' || !SUPPORTED_TYPE_NAMES.includes(name)) {
      refuse(skill_id, `${path} names a type outside ${SUPPORTED_TYPE_NAMES.join('/')}`);
    }
  }
  if (new Set(names).size !== names.length) {
    refuse(skill_id, `${path} repeats a type name`);
  }
}

/** Reports whether a value is an array of strings, optionally requiring each to be non-empty. */
function isStringArray(value: unknown, nonEmptyMembers: boolean): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item) => typeof item === 'string' && (!nonEmptyMembers || item.length > 0),
  );
}

/**
 * Refuses a schema the validator cannot fully enforce.
 *
 * @param skill_id The row the schema belongs to.
 * @param schema The declared `input_schema` or `output_schema`.
 * @throws {SkillError} `INVALID_SCHEMA`, naming the first offending path.
 */
export function assertSupportedSchema(skill_id: string, schema: Record<string, unknown>): void {
  assertNode(schema, '$', skill_id);
}

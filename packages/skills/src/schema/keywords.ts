/**
 * @file The frozen JSON Schema vocabulary this package can actually enforce (implement/05 §2
 * "JSON Schema / Type Guard", §3 `input_schema` / `output_schema`).
 *
 * The vocabulary is closed on purpose. A registration declares its schema against this list, and
 * anything outside it is refused there — so runtime validation can never meet a keyword it would
 * have to ignore, and a declared constraint can never be silently dropped.
 */

/** Every keyword the validator understands, sorted for a deterministic walk. */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  '$id',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'deprecated',
  'description',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'prefixItems',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
]);

/** Every `format` value with a deterministic, clock-free and locale-free check. */
export const SUPPORTED_FORMATS: readonly string[] = Object.freeze([
  'date',
  'date-time',
  'email',
  'time',
  'uri',
  'uuid',
]);

/** Every JSON type name a `type` keyword may use. */
export const SUPPORTED_TYPE_NAMES: readonly string[] = Object.freeze([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

/** Keywords whose value is a schema node, and which therefore have to be walked recursively. */
export const SUBSCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  'additionalProperties',
  'items',
  'not',
]);

/** Keywords whose value is an array of schema nodes. */
export const SUBSCHEMA_LIST_KEYWORDS: readonly string[] = Object.freeze([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/** Keywords whose value is an object of schema nodes. */
export const SUBSCHEMA_MAP_KEYWORDS: readonly string[] = Object.freeze(['properties']);

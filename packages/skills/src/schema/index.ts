/**
 * @file The schema surface of the skill layer: the registration-time capability gate, deterministic
 * validation, and normalization (implement/05 §2, §3, §6.3).
 *
 * Registration calls `assertSupportedSchema`; dispatch calls `normalizeAgainstSchema` on the input
 * and `validateAgainstSchema` on the adapter response. Nothing here reaches a tool, a clock or a
 * random source, so the same payload always produces the same verdict.
 */

export { assertSupportedSchema } from './assert-supported.js';
export { stableJson } from './canonical.js';
export { matchesFormat } from './formats.js';
export {
  SUPPORTED_FORMATS,
  SUPPORTED_SCHEMA_KEYWORDS,
  SUPPORTED_TYPE_NAMES,
} from './keywords.js';
export { normalizeAgainstSchema } from './normalize.js';
export {
  describeViolations,
  validateAgainstSchema,
  type SchemaViolation,
} from './validate.js';

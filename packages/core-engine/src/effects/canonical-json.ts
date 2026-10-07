/**
 * Compatibility export for effect callers.
 *
 * Canonical JSON has one serializer in `durability/canonical-json.ts`; this boundary preserves the
 * historical effect-layer refusal code without carrying a second serializer implementation.
 */
import { OrchestratorError } from '../contracts/types.js';
import { canonicalizeJson as canonicalizeDurableJson } from '../durability/canonical-json.js';

export function canonicalizeJson(value: unknown): string {
  try {
    return canonicalizeDurableJson(value);
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.replace(/^CANONICAL_JSON_INVALID:\s*/, '')
      : String(error);
    throw new OrchestratorError('CANONICAL_JSON_UNSUPPORTED', detail);
  }
}

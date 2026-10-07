/**
 * @file BR-005 canonical effect identity (implement/04 §3.2.3).
 *
 *   effect_key = hex(SHA-256(RFC8785({ tenant_id, skill_id, step_index, action_revision,
 *                                       request_id })))
 *
 * `request_id` is the immutable inbound identity (signal_id / webhook delivery id / message id).
 * `run_id`, retry counters, timestamps and random UUIDs are NEVER inputs: a new run — worker crash,
 * redelivered webhook, operator retry — that replays the same inbound request reproduces the same
 * key and therefore cannot duplicate the external effect.
 *
 * `request_fingerprint` is hashed from the drafted payload and stored beside the key so that a
 * replayed key carrying a different payload is detected as a conflict instead of being merged.
 */

import { sha256Hex } from '../durability/canonical-json.js';
import { OrchestratorError } from '../contracts/types.js';
import { canonicalizeJson } from './canonical-json.js';
/** Immutable inbound request identity bound into an `effect_key`. */
export interface EffectKeyInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly request_id: string;
}

/**
 * Derives the deterministic idempotency key of one action.
 *
 * The canonical object is built field by field: no caller-supplied property (a stray `run_id`,
 * a retry counter, a timestamp) can reach the digest.
 *
 * @param input The five bound identity fields.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function computeEffectKey(input: EffectKeyInput): string {
  if (input.tenant_id.trim().length === 0) {
    throw new OrchestratorError(
      'TENANT_CONTEXT_REQUIRED',
      'effect_key cannot be derived without a tenant identity (NFR-006).',
    );
  }
  if (input.skill_id.trim().length === 0) {
    throw new OrchestratorError(
      'SKILL_ID_REQUIRED',
      'effect_key cannot be derived without the registry skill id bound to the action (BR-005).',
    );
  }
  if (input.request_id.trim().length === 0) {
    throw new OrchestratorError(
      'REQUEST_ID_REQUIRED',
      'effect_key is derived from the immutable inbound request identity (BR-005).',
    );
  }
  if (!Number.isInteger(input.step_index) || input.step_index < 0) {
    throw new OrchestratorError(
      'STEP_INDEX_INVALID',
      `effect_key requires a non-negative integer step_index (received ${String(input.step_index)}).`,
    );
  }
  if (!Number.isInteger(input.action_revision) || input.action_revision < 0) {
    throw new OrchestratorError(
      'ACTION_REVISION_INVALID',
      `effect_key requires a non-negative integer action_revision (received ${String(input.action_revision)}).`,
    );
  }

  return sha256Hex(canonicalizeJson({
    tenant_id: input.tenant_id,
    skill_id: input.skill_id,
    step_index: input.step_index,
    action_revision: input.action_revision,
    request_id: input.request_id,
  }));
}

/**
 * Hashes a drafted payload into the replay-detection fingerprint stored with a reservation.
 *
 * @param payload The payload that will be dispatched under the effect key.
 * @returns 64-character lowercase hex SHA-256 digest of the canonical payload.
 */
export function computeRequestFingerprint(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalizeJson(payload));
}

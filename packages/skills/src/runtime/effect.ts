/**
 * @file Deterministic effect identity of one dispatch (BR-005, implement/05 §2, §6.3).
 *
 * The runtime **derives** the key and never adopts a caller-supplied one: the inputs are the
 * immutable inbound identity, so a redelivered request that starts a new run reproduces the same
 * key and cannot duplicate the external effect. `run_id`, a retry counter, a timestamp and a random
 * UUID are not inputs, so a key built from any of them can never pass the check — a locally invented
 * key is refused instead of being reserved under a second external effect.
 */

import {
  SkillError,
  type EffectKeyFn,
  type SkillDispatchRequest,
} from '../contracts/index.js';

/** A non-empty textual identity field; an empty or absent one is not an identity. */
function requireIdentity(value: unknown, field: string, skill_id: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SkillError(
      'MISSING_DISPATCH_CONTEXT',
      `${field} is required to derive the effect key from the immutable inbound request (BR-005)`,
      skill_id,
    );
  }
  return value;
}

/** A non-negative integer plan coordinate; a fractional or negative one is not a position. */
function requireCoordinate(value: unknown, field: string, skill_id: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SkillError(
      'MISSING_DISPATCH_CONTEXT',
      `${field} must be a non-negative safe integer to derive the effect key (BR-005)`,
      skill_id,
    );
  }
  return value;
}

/**
 * Derives the canonical effect key of one dispatch and refuses a foreign key.
 *
 * @param request The dispatch envelope; its identity fields are server-resolved.
 * @param deriveEffectKey The injected canonical BR-005 derivation.
 * @returns The canonical 64-character hex effect key of this dispatch.
 * @throws {SkillError} `MISSING_DISPATCH_CONTEXT` when an identity field is unusable, or
 *   `EFFECT_KEY_NOT_DETERMINISTIC` when a supplied key is not this dispatch's derivation.
 */
export function resolveDispatchEffectKey(
  request: SkillDispatchRequest,
  deriveEffectKey: EffectKeyFn,
): string {
  const skill_id = request.skill_id;
  const derived = deriveEffectKey({
    tenant_id: requireIdentity(request.tenant_id, 'tenant_id', skill_id),
    skill_id: requireIdentity(skill_id, 'skill_id', skill_id),
    step_index: requireCoordinate(request.step_index, 'step_index', skill_id),
    action_revision: requireCoordinate(request.action_revision, 'action_revision', skill_id),
    request_id: requireIdentity(request.request_id, 'request_id', skill_id),
  });

  if (request.effect_key !== undefined && request.effect_key !== derived) {
    throw new SkillError(
      'EFFECT_KEY_NOT_DETERMINISTIC',
      'the supplied effect_key is not the canonical BR-005 derivation of this dispatch identity; a key taken from a clock, a run id or a random UUID is refused rather than reserved (BR-005)',
      skill_id,
    );
  }

  return derived;
}

/**
 * @file Route-level idempotency for the `/api/v1` gateway (implement/06 §8.0, §8.3 C-6; `04` §4.4,
 * BR-005/BR-006).
 *
 * Idempotency is not a gateway-owned table. Every mutating delivery claims its slot through the
 * canonical effect guard (`GatewayRuntime.effects`, the `IEffectGuard` of `04` §3.2.3): the
 * BR-005 `effect_key` is derived from the immutable inbound identity, the canonical payload is
 * fingerprinted, and the guard's reservation table — never a second table and never a second
 * fingerprint — decides what may happen next.
 *
 * | guard outcome        | gateway outcome       | transport                                        |
 * |----------------------|-----------------------|--------------------------------------------------|
 * | `RESERVED`           | `PROCEED`             | the route dispatches the effect exactly once      |
 * | `REPLAY`             | `REPLAY` + receipt    | `2xx` with the stored receipt, no re-dispatch     |
 * | `IN_FLIGHT`          | `IN_FLIGHT`           | the first delivery still holds the slot           |
 * | `RECONCILE_REQUIRED` | `RECONCILE_REQUIRED`  | reconciled by `effect_key` (R18), never blind-retried |
 * | `CONFLICT`           | `fail(IDEMPOTENCY_CONFLICT)` | `409`                                      |
 *
 * Only a `CONFLICT` is a `409`: a byte-identical replay returns the cached receipt, and a key that
 * arrives carrying different bytes is the one case the caller can fix by choosing another key.
 *
 * An indeterminate outcome — a provider timeout, a dropped connection, an effect that may or may
 * not have landed — is NEVER a settlement. The reservation is left `RESERVED` and reconciled by
 * `effect_key`, so a re-delivery cannot duplicate an effect whose outcome nobody confirmed
 * (`04` §4.4 step 4, BR-006); {@link settleIdempotentEffect} therefore never passes `FAILED`.
 */

import type { GatewayRuntime } from './ports.js';
import { fail } from './http.js';

/**
 * What the caller of {@link claimIdempotentEffect} may do next. Every member other than `PROCEED`
 * means the effect is not dispatched again under this key.
 */
export type IdempotencyOutcome =
  | { readonly kind: 'PROCEED'; readonly effect_key: string; readonly request_fingerprint: string }
  | { readonly kind: 'REPLAY'; readonly receipt: Record<string, unknown> }
  | { readonly kind: 'IN_FLIGHT' }
  | { readonly kind: 'RECONCILE_REQUIRED' };

/**
 * Guards a value that can be returned as a JSON response body: a plain JSON object, never an
 * array, a `null` receipt or a live object graph.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Claims the single dispatch slot of one effect, deriving both the key and the fingerprint through
 * the canonical guard.
 *
 * @param input The immutable inbound identity (`request_id`), the run it belongs to, and the
 *   drafted payload whose canonical bytes are fingerprinted.
 * @returns `PROCEED` when this delivery owns the slot; otherwise the outcome the guard recorded.
 * @throws {GatewayFailureError} `IDEMPOTENCY_CONFLICT` when the same key arrives with a different
 *   canonical payload, and `INTERNAL_ERROR` when a stored `REPLAY` receipt is not a plain object —
 *   a malformed receipt is refused rather than returned as a response body.
 */
export async function claimIdempotentEffect(input: {
  readonly runtime: GatewayRuntime;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly payload: Record<string, unknown>;
}): Promise<IdempotencyOutcome> {
  const effect_key = input.runtime.effects.computeEffectKey({
    tenant_id: input.tenant_id,
    skill_id: input.skill_id,
    step_index: input.step_index,
    action_revision: input.action_revision,
    request_id: input.request_id,
  });
  const request_fingerprint = input.runtime.effects.computeRequestFingerprint(input.payload);

  const outcome = await input.runtime.effects.reserve({
    tenant_id: input.tenant_id,
    run_id: input.run_id,
    request_id: input.request_id,
    effect_key,
    request_fingerprint,
    skill_id: input.skill_id,
    step_index: input.step_index,
    action_revision: input.action_revision,
  });

  if (outcome.kind === 'RESERVED') {
    return { kind: 'PROCEED', effect_key, request_fingerprint };
  }

  if (outcome.kind === 'REPLAY') {
    if (!isPlainObject(outcome.receipt)) {
      fail(
        'INTERNAL_ERROR',
        'the receipt stored for this effect_key is not a JSON object, so it cannot be returned as a response body',
      );
    }
    return { kind: 'REPLAY', receipt: outcome.receipt };
  }

  if (outcome.kind === 'IN_FLIGHT') {
    return { kind: 'IN_FLIGHT' };
  }

  if (outcome.kind === 'RECONCILE_REQUIRED') {
    return { kind: 'RECONCILE_REQUIRED' };
  }

  // The same key with different canonical bytes: the sole idempotency refusal, mapped to `409`.
  fail(
    'IDEMPOTENCY_CONFLICT',
    'this request identifier was already claimed with a different payload; the effect is not dispatched again under a key that already carries other bytes',
  );
}

/**
 * Settles a claimed effect that the provider confirmed as succeeded, storing the receipt beside
 * the key so an identical replay can be answered without a second dispatch.
 *
 * A call is valid only for a CONFIRMED outcome. An indeterminate one is deliberately not a
 * settlement: the reservation stays `RESERVED` — the only canonical way to say "the effect may or
 * may not have landed" — and is reconciled by `effect_key` (R18), so this path never resolves
 * `FAILED` and never reopens a slot for a blind retry.
 *
 * @throws {OrchestratorError} `RESERVATION_NOT_FOUND` when nothing was reserved under the key: a
 *   settlement may not create the reservation the guard never observed.
 */
export async function settleIdempotentEffect(input: {
  readonly runtime: GatewayRuntime;
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly receipt: Record<string, unknown>;
}): Promise<void> {
  await input.runtime.effects.resolve({
    tenant_id: input.tenant_id,
    effect_key: input.effect_key,
    status: 'SUCCEEDED',
    receipt: input.receipt,
  });
}

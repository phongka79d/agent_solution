/**
 * @file EffectGuard — the only decider of idempotency (implement/04 §3.2.2, §3.2.3, §4.4).
 *
 * The guard owns the *decision*; the durable fact behind it lives in `agentos.effect_reservations`
 * and reaches this class only through the injected `EffectReservationRepository`. Nothing here
 * keeps a process-local map and nothing consults a cache: a Redis mirror may only ever degrade
 * latency, never safety, so an unavailable cache cannot turn a replay into a second dispatch.
 *
 * Guarantees this class enforces:
 *   * `effect_key` is SHA-256 over the canonical JSON of
 *     `{tenant_id, skill_id, step_index, action_revision, request_id}` — never `run_id`, a retry
 *     counter, a timestamp or a random UUID — so a redelivered request that starts a new run
 *     reproduces the same key (§3.2.3, TC-ORC-010);
 *   * the key presented to `reserve()` must be that canonical derivation, otherwise the call fails
 *     closed instead of reserving a key that some other identity would also produce;
 *   * exactly one caller can hold a fresh reservation, because the primary key
 *     `(tenant_id, effect_key)` arbitrates concurrent claims (§3.2.3);
 *   * an unconfirmed outcome is never settled and never re-dispatched: the row stays `RESERVED`
 *     and the step is parked until the provider is reconciled by `effect_key` (§3.2.4, §4.4).
 */

import {
  type EffectReservationRecord,
  type EffectReservationRepository,
  type IEffectGuard,
  OrchestratorError,
  type ReservationOutcome,
} from '../contracts/types.js';
import { isSha256Hex, sha256CanonicalJson } from './canonical-json.js';

/**
 * The 72-hour idempotency window of §03 §3: `expires_at` bounds how long an unproven effect is
 * waited on before the escalation path (§4.4 step 4) hands it to a human.
 */
export const EFFECT_RESERVATION_TTL_MS = 72 * 60 * 60 * 1000;

/** Runtime bindings of the guard; every one of them is injected, none is read from the ambient process. */
export interface EffectGuardOptions {
  /** Durable authority: the `agentos.effect_reservations` port (§03 §1 DOMAIN 5). */
  readonly repository: EffectReservationRepository;
  /** Reservation window; defaults to {@link EFFECT_RESERVATION_TTL_MS}. */
  readonly reservationTtlMs?: number;
  /** Injected clock; defaults to the system clock so tests can pin the window. */
  readonly now?: () => Date;
}

/**
 * Durable-first effect guard (§3.2.3). Mutating dispatches only: a read-only action has no external
 * effect to deduplicate, is never reserved, and stays freely retryable under its declared policy.
 */
export class EffectGuard implements IEffectGuard {
  private readonly repository: EffectReservationRepository;
  private readonly reservationTtlMs: number;
  private readonly now: () => Date;

  constructor(options: EffectGuardOptions) {
    this.repository = options.repository;
    this.reservationTtlMs = options.reservationTtlMs ?? EFFECT_RESERVATION_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Derives the deterministic `effect_key` of one action (§3.2.3, BR-005).
   *
   * @param input - The immutable request identity of the step.
   * @returns SHA-256 over the RFC 8785 canonical object, as 64 lower-case hexadecimal characters.
   * @throws OrchestratorError `TENANT_CONTEXT_REQUIRED`, `SKILL_ID_REQUIRED`, `REQUEST_ID_REQUIRED`,
   *   `STEP_INDEX_INVALID` or `ACTION_REVISION_INVALID` when a component that is part of the
   *   canonical key is missing. An absent identity component would otherwise collapse distinct
   *   requests onto one key, which is exactly the duplicate-effect failure BR-005 forbids.
   */
  computeEffectKey(input: {
    tenant_id: string;
    skill_id: string;
    step_index: number;
    action_revision: number;
    request_id: string;
  }): string {
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
        'effect_key is derived from the immutable inbound request identity (signal_id / message_id / '
          + 'webhook delivery id); run_id, timestamps and random UUIDs are never inputs (BR-005).',
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

    return sha256CanonicalJson({
      tenant_id: input.tenant_id,
      skill_id: input.skill_id,
      step_index: input.step_index,
      action_revision: input.action_revision,
      request_id: input.request_id,
    });
  }

  /**
   * Digests an action payload so a replayed key carrying different bytes is detected as a conflict
   * rather than merged (§3.2.3).
   *
   * @param payload - Action payload to digest.
   * @returns SHA-256 over the RFC 8785 canonical payload, as 64 lower-case hexadecimal characters.
   * @throws OrchestratorError `CANONICAL_JSON_INVALID` when the payload is not canonicalizable.
   */
  computeRequestFingerprint(payload: Record<string, unknown>): string {
    return sha256CanonicalJson(payload);
  }

  /**
   * Reserves an effect key durably before every mutating dispatch (§3.2.3).
   *
   * @param input - Reservation request; `effect_key` must be the canonical derivation of the
   *   identity fields, and `request_fingerprint` the digest of the payload about to be dispatched.
   * @returns The reservation decision of the §3.2.3 table.
   * @throws OrchestratorError `EFFECT_KEY_MISMATCH` when the presented key is not the canonical
   *   derivation, `REQUEST_FINGERPRINT_INVALID` when the fingerprint is not a SHA-256 digest, or
   *   `RESERVATION_NOT_DURABLE` when a refused insert cannot be read back.
   */
  async reserve(input: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    effect_key: string;
    request_fingerprint: string;
    skill_id: string;
    step_index: number;
    action_revision: number;
  }): Promise<ReservationOutcome> {
    const canonicalKey = this.computeEffectKey({
      tenant_id: input.tenant_id,
      skill_id: input.skill_id,
      step_index: input.step_index,
      action_revision: input.action_revision,
      request_id: input.request_id,
    });

    if (canonicalKey !== input.effect_key) {
      throw new OrchestratorError(
        'EFFECT_KEY_MISMATCH',
        `the presented effect_key ${input.effect_key} is not the canonical derivation for `
          + '(tenant_id, skill_id, step_index, action_revision, request_id); refusing to reserve a '
          + 'key another identity could also produce (BR-005).',
      );
    }

    if (!isSha256Hex(input.request_fingerprint)) {
      throw new OrchestratorError(
        'REQUEST_FINGERPRINT_INVALID',
        'request_fingerprint must be the 64-character lower-case SHA-256 digest of the canonical payload.',
      );
    }

    const expiresAt = new Date(this.now().getTime() + this.reservationTtlMs).toISOString();
    const claimed = await this.repository.insertReservation({
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      request_id: input.request_id,
      effect_key: input.effect_key,
      request_fingerprint: input.request_fingerprint,
      skill_id: input.skill_id,
      step_index: input.step_index,
      expires_at: expiresAt,
    });

    if (claimed !== null) {
      return { kind: 'RESERVED' };
    }

    // The insert was refused: a row already exists for (tenant_id, effect_key), so this caller lost
    // the arbitration and the durable row decides the outcome.
    const existing = await this.repository.getReservation(input.tenant_id, input.effect_key);

    if (existing === null) {
      throw new OrchestratorError(
        'RESERVATION_NOT_DURABLE',
        `effect_key ${input.effect_key} could not be claimed for tenant ${input.tenant_id}: the insert `
          + 'was refused by a reservation that cannot be read back, so the effect state is unknown.',
      );
    }

    return this.decide(input.request_fingerprint, existing);
  }

  /**
   * Settles a reservation: `SUCCEEDED` with the verified receipt, or `FAILED` for a
   * provider-confirmed absence (§4.4).
   *
   * @param input - Settlement request. An indeterminate outcome is deliberately unrepresentable.
   * @returns Nothing once the durable row is settled.
   * @throws OrchestratorError `RESERVATION_NOT_SETTLEABLE` when no `RESERVED` row was settled —
   *   already settled, reopened by recovery, or expired — because silently reporting success for an
   *   unsettled effect is exactly the fabrication NFR-002 forbids.
   */
  async resolve(input: {
    tenant_id: string;
    effect_key: string;
    status: 'SUCCEEDED' | 'FAILED';
    receipt?: unknown;
  }): Promise<void> {
    const settled = await this.repository.settleReservation({
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      status: input.status,
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    });

    if (settled) {
      return;
    }

    const current = await this.repository.getReservation(input.tenant_id, input.effect_key);

    // A worker may crash after durable settlement but before its task resume event is consumed.
    // Matching status is the durable outcome already established by the first attempt; keep the
    // stored receipt and let the retry finish event consumption instead of treating the replay as a
    // conflicting second settlement.
    if (current?.status === input.status) {
      return;
    }

    throw new OrchestratorError(
      'RESERVATION_NOT_SETTLEABLE',
      `effect_key ${input.effect_key} was not settled as ${input.status}: the durable row is `
        + `${current === null ? 'absent' : `${current.status}`} for tenant ${input.tenant_id}. `
        + 'Reconcile the effect by key before recording any outcome (NFR-002, §4.4).',
    );
  }

  /**
   * Reports what the durable store knows about an unsettled effect (§4.4). The provider query
   * belongs to the dispatch port; this method never dispatches and never synthesizes a receipt.
   *
   * @param input - Effect identity to reconcile.
   * @returns `SUCCEEDED` with the stored receipt verbatim, `FAILED` for a provider-confirmed
   *   absence, or `INDETERMINATE` while the effect may have landed (row `RESERVED`/`EXPIRED`, or no
   *   row at all: a missing row is not evidence of absence).
   * @throws OrchestratorError `EFFECT_SKILL_MISMATCH` when the stored reservation belongs to a
   *   different skill than the caller claims, so a wrong connector is never asked about the effect.
   */
  async reconcile(input: {
    tenant_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<{ outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown }> {
    const reservation = await this.repository.getReservation(input.tenant_id, input.effect_key);

    if (reservation === null) {
      return { outcome: 'INDETERMINATE' };
    }

    if (reservation.skill_id !== input.skill_id) {
      throw new OrchestratorError(
        'EFFECT_SKILL_MISMATCH',
        `effect_key ${input.effect_key} is bound to skill ${reservation.skill_id}, not `
          + `${input.skill_id}; refusing to reconcile an effect through the wrong connector.`,
      );
    }

    switch (reservation.status) {
      case 'SUCCEEDED':
        return { outcome: 'SUCCEEDED', receipt: reservation.response_receipt };
      case 'FAILED':
        return { outcome: 'FAILED' };
      case 'RESERVED':
      case 'EXPIRED':
        return { outcome: 'INDETERMINATE' };
      default:
        throw new OrchestratorError(
          'RESERVATION_STATE_UNRECOGNISED',
          `effect_reservations.status ${String(reservation.status)} is outside `
            + 'RESERVED | SUCCEEDED | FAILED | EXPIRED (§03 DOMAIN 5); refusing to report an outcome for it.',
        );
    }
  }

  /**
   * Returns a FAILED reservation to RESERVED with a fresh window (implement/04 §4.4 step 3).
   * A provider-confirmed absence is the only condition that clears the way for one more dispatch
   * under the SAME effect key.
   */
  async reopenForRetry(input: {
    tenant_id: string;
    effect_key: string;
  }): Promise<boolean> {
    const expiresAt = new Date(this.now().getTime() + this.reservationTtlMs).toISOString();
    return await this.repository.reopenReservation({
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      expires_at: expiresAt,
    });
  }

  /**
   * Applies the §3.2.3 decision table to the durable row.
   *
   * @param requestFingerprint - Fingerprint of the payload about to be dispatched.
   * @param existing - The durable reservation that won the arbitration.
   * @returns The reservation outcome.
   * @throws OrchestratorError `RESERVATION_STATE_UNRECOGNISED` for a status outside the four
   *   canonical values.
   */
  private decide(requestFingerprint: string, existing: EffectReservationRecord): ReservationOutcome {
    if (existing.request_fingerprint !== requestFingerprint) {
      // Same key, different bytes: a conflict is terminal (IDEMPOTENCY_CONFLICT), never a merge.
      return { kind: 'CONFLICT' };
    }

    switch (existing.status) {
      case 'SUCCEEDED':
        return { kind: 'REPLAY', receipt: existing.response_receipt };
      case 'RESERVED': {
        const expiresAtMs = Date.parse(existing.expires_at);

        // An unparsable `expires_at` (NaN) is not a licence to dispatch: it fails the comparison and
        // parks the step as IN_FLIGHT, which is the safe side of "the effect may have landed".
        return expiresAtMs <= this.now().getTime() ? { kind: 'RECONCILE_REQUIRED' } : { kind: 'IN_FLIGHT' };
      }
      case 'FAILED':
      case 'EXPIRED':
        return { kind: 'RECONCILE_REQUIRED' };
      default:
        throw new OrchestratorError(
          'RESERVATION_STATE_UNRECOGNISED',
          `effect_reservations.status ${String(existing.status)} is outside `
            + 'RESERVED | SUCCEEDED | FAILED | EXPIRED (§03 DOMAIN 5); refusing to guess whether the effect landed.',
        );
    }
  }
}

/**
 * @file In-memory `IEffectGuard` (implement/04 §3.2.3) — the durable `effect_reservations`
 * decision table, held in process memory for tests and for single-process runs.
 *
 * The guard owns exactly one question: may this mutating effect be dispatched now? It never calls
 * an adapter (§3.3 `acquireEffectSlot` dispatches; §4.4 reconciles), so a reservation whose
 * outcome was never confirmed stays `RESERVED` — the only canonical way to say "the effect may or
 * may not have landed" — and is reconciled by key instead of retried blindly.
 *
 * Decision table, keyed by `(tenant_id, effect_key)`:
 *
 * | stored state                                       | outcome            |
 * |----------------------------------------------------|--------------------|
 * | no row                                             | `RESERVED`         |
 * | same fingerprint, `SUCCEEDED`                      | `REPLAY` + receipt |
 * | same fingerprint, `RESERVED`, unexpired            | `IN_FLIGHT`        |
 * | same fingerprint, `RESERVED` expired / `FAILED`    | `RECONCILE_REQUIRED` |
 * | different fingerprint                              | `CONFLICT`         |
 */

import type { IEffectGuard, ReservationOutcome } from '../contracts/ports.js';
import { OrchestratorError } from '../contracts/types.js';
import { type EffectKeyInput, computeEffectKey, computeRequestFingerprint } from './effect-key.js';

/**
 * The spec's provisional reservation window (72 h, §4.4 step 4): how long an unconfirmed effect
 * may wait before the engine escalates to a human. It bounds the wait; it is not an approval TTL.
 */
export const EFFECT_RESERVATION_WINDOW_MS = 72 * 60 * 60 * 1000;

/** `effect_reservations.status` accepts these three states — there is no "unknown" status. */
export type EffectReservationStatus = 'RESERVED' | 'SUCCEEDED' | 'FAILED';

export interface EffectReservationRow {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly effect_key: string;
  /** Fingerprint of the canonical payload; a mismatch is an idempotency conflict (BR-005). */
  readonly request_fingerprint: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly status: EffectReservationStatus;
  readonly reserved_at: string;
  readonly expires_at: string;
  readonly receipt: unknown;
}

export interface MemoryEffectGuardOptions {
  /** Injectable clock; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Reservation window in milliseconds; defaults to {@link EFFECT_RESERVATION_WINDOW_MS}. */
  readonly reservation_window_ms?: number;
}

/** Mirrors `IEffectGuard.reconcile`'s result shape. */
type ReconciliationResult = { outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown };

export class MemoryEffectGuard implements IEffectGuard {
  private readonly rows = new Map<string, EffectReservationRow>();
  private readonly now: () => Date;
  private readonly reservationWindowMs: number;

  constructor(options: MemoryEffectGuardOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
    this.reservationWindowMs = options.reservation_window_ms ?? EFFECT_RESERVATION_WINDOW_MS;
  }

  /** @inheritdoc */
  public computeEffectKey(input: EffectKeyInput): string {
    return computeEffectKey(input);
  }

  /** @inheritdoc */
  public computeRequestFingerprint(payload: Record<string, unknown>): string {
    return computeRequestFingerprint(payload);
  }

  /**
   * Durable-first reservation, called before every mutating dispatch and never for a read-only
   * action. The first delivery inserts the row and admits exactly one dispatch slot; every later
   * call resolves against the table above and never re-opens that slot.
   */
  public async reserve(input: {
    tenant_id: string;
    run_id: string;
    request_id: string;
    effect_key: string;
    request_fingerprint: string;
    skill_id: string;
    step_index: number;
    action_revision: number;
  }): Promise<ReservationOutcome> {
    const key = rowKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);

    if (row === undefined) {
      const reservedAt = this.now();
      const reserved: EffectReservationRow = {
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        request_id: input.request_id,
        effect_key: input.effect_key,
        request_fingerprint: input.request_fingerprint,
        skill_id: input.skill_id,
        step_index: input.step_index,
        action_revision: input.action_revision,
        status: 'RESERVED',
        reserved_at: reservedAt.toISOString(),
        expires_at: new Date(reservedAt.getTime() + this.reservationWindowMs).toISOString(),
        receipt: undefined,
      };
      this.rows.set(key, Object.freeze(reserved));
      return { kind: 'RESERVED' };
    }

    // The payload is checked before the state: a key reused with different bytes is a conflict
    // whether the stored effect is open, settled or failed (BR-005).
    if (row.request_fingerprint !== input.request_fingerprint) {
      return { kind: 'CONFLICT' };
    }
    if (row.status === 'SUCCEEDED') {
      // Verbatim stored receipt: this process never synthesizes a response for a call it did not
      // make, and the provider is never called a second time under the same key.
      return { kind: 'REPLAY', receipt: row.receipt };
    }
    if (row.status === 'FAILED') {
      return { kind: 'RECONCILE_REQUIRED' };
    }
    return Date.parse(row.expires_at) <= this.now().getTime()
      ? { kind: 'RECONCILE_REQUIRED' }
      : { kind: 'IN_FLIGHT' };
  }

  /**
   * Settles a reservation with a provider-confirmed outcome.
   *
   * `SUCCEEDED` stores the receipt; `FAILED` records a provider-confirmed absence. An
   * indeterminate outcome is deliberately not a settlement — the caller leaves the row `RESERVED`
   * and reconciles by key (§3.2.3, §4.4).
   *
   * @throws {OrchestratorError} `INVALID_RESERVATION_SETTLEMENT` for any status other than
   *   `SUCCEEDED | FAILED`, `RESERVATION_NOT_FOUND` when nothing was reserved under the key — a
   *   settlement may not invent a reservation the guard never observed.
   */
  public async resolve(input: {
    tenant_id: string;
    effect_key: string;
    status: 'SUCCEEDED' | 'FAILED';
    receipt?: unknown;
  }): Promise<void> {
    if (input.status !== 'SUCCEEDED' && input.status !== 'FAILED') {
      throw new OrchestratorError(
        'INVALID_RESERVATION_SETTLEMENT',
        `'${String(input.status)}' is not a settlement: effect_reservations accepts only SUCCEEDED or FAILED, and an indeterminate outcome leaves the row RESERVED (§3.2.3, BR-006).`,
      );
    }
    const key = rowKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);

    if (row === undefined) {
      throw new OrchestratorError(
        'RESERVATION_NOT_FOUND',
        `no reservation exists for effect_key ${input.effect_key}; a settlement may not create one (BR-006).`,
      );
    }
    const settled: EffectReservationRow = { ...row, status: input.status, receipt: input.receipt };
    this.rows.set(key, Object.freeze(settled));
  }

  /**
   * Provider-side reconciliation of an unsettled effect. The guard performs no provider call
   * itself: it reports what the reservation already proves — a stored `SUCCEEDED` receipt is
   * returned verbatim, a provider-confirmed `FAILED` absence is reported as failed, and anything
   * still open is `INDETERMINATE` (the caller escalates at `expires_at`, §4.4 step 4). No
   * re-dispatch ever happens here.
   */
  public async reconcile(input: {
    tenant_id: string;
    effect_key: string;
    skill_id: string;
  }): Promise<ReconciliationResult> {
    const row = this.rows.get(rowKey(input.tenant_id, input.effect_key));

    if (row?.status === 'SUCCEEDED') {
      return row.receipt === undefined
        ? { outcome: 'SUCCEEDED' }
        : { outcome: 'SUCCEEDED', receipt: row.receipt };
    }
    if (row?.status === 'FAILED') {
      return { outcome: 'FAILED' };
    }
    return { outcome: 'INDETERMINATE' };
  }

  public async reopenForRetry(input: {
    tenant_id: string;
    effect_key: string;
  }): Promise<boolean> {
    const key = rowKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);
    if (row === undefined || row.status !== 'FAILED') {
      return false;
    }
    const expiresAt = new Date(this.now().getTime() + this.reservationWindowMs).toISOString();
    this.rows.set(key, Object.freeze({
      ...row,
      status: 'RESERVED',
      expires_at: expiresAt,
    }));
    return true;
  }

  /**
   * Read-only view of the stored row, mirroring the durable `effect_reservations` read path. Rows
   * are frozen, so inspecting them cannot change a reservation.
   */
  public peek(tenant_id: string, effect_key: string): EffectReservationRow | null {
    return this.rows.get(rowKey(tenant_id, effect_key)) ?? null;
  }
}

function rowKey(tenant_id: string, effect_key: string): string {
  return `${tenant_id}|${effect_key}`;
}

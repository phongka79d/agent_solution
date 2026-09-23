/**
 * @file Customer Care turn admission on PostgreSQL (implement/03 §1 DOMAIN 5, implement/04 §3.2.3, §4.1).
 *
 * Invariant: Exactly one reservation row in `agentos.effect_reservations` arbitrates admission of a
 * conversational turn. On winning the race (first insert), exactly one durable task in
 * `agentos.platform_durable_tasks` is created in the SAME transaction at current_step = 0,
 * state = 'queued', state_payload = { signal }.
 *
 * Why a refusal exists:
 * If an effect key was already claimed for a different payload fingerprint, admission is refused
 * as CONFLICT (IDEMPOTENCY_CONFLICT). If an unexpired reservation is in flight, the existing run_id
 * is returned (IN_FLIGHT) to prevent duplicate runs. If the effect settled, REPLAY returns the
 * stored receipt. If the reservation expired or failed without resolution, RECONCILE_REQUIRED is returned.
 */

import type { PoolClient } from 'pg';
import type { EffectReservationRecord } from '../contracts/index.js';
import { withTenantContext } from '../rls.js';
import {
  type DurableTaskRecord,
  insertDurableTask,
} from './durable-workflows.js';
import {
  type TenantTransactionRunner,
  insertReservationRow,
  lockReservationRow,
} from './effect-reservations.js';

export const CONVERSATION_TURN_SKILL = 'conversation.turn';

export interface AdmitCareTurnInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly signal: Record<string, unknown>;
  readonly skill_id?: string;
  readonly step_index?: number;
  /**
   * Length of the durable idempotency/reconciliation window, in milliseconds. Required: the
   * window is a platform policy owned by the effect guard (`EFFECT_RESERVATION_TTL_MS` in
   * `packages/core-engine`), and `packages/database` must not restate that number as its own
   * default — a second copy would silently diverge from the guard that reads the row.
   */
  readonly reservation_ttl_ms: number;
  readonly expires_at?: Date | string;
  readonly now?: () => Date;
}

export type AdmissionOutcome =
  | {
      readonly kind: 'ADMITTED';
      readonly run_id: string;
      readonly task: DurableTaskRecord;
      readonly reservation: EffectReservationRecord;
    }
  | {
      readonly kind: 'REPLAY';
      readonly run_id: string;
      readonly receipt: Record<string, unknown> | null;
    }
  | {
      readonly kind: 'IN_FLIGHT';
      readonly run_id: string;
    }
  | {
      readonly kind: 'CONFLICT';
    }
  | {
      readonly kind: 'RECONCILE_REQUIRED';
    };

/**
 * Executes admission of a Customer Care turn within a single tenant transaction.
 *
 * (a) Inserts the reservation into `agentos.effect_reservations` with caller-minted run_id and TTL window.
 * (b) On successful insert: writes the durable task with state='queued', current_step=0, state_payload={ signal }.
 * (c) On conflict: selects the existing reservation FOR UPDATE and evaluates the decision table.
 */
export async function admitCareTurn(
  input: AdmitCareTurnInput,
  runner: TenantTransactionRunner = withTenantContext,
): Promise<AdmissionOutcome> {
  const nowFn = input.now ?? (() => new Date());
  const now = nowFn();
  const skill_id = input.skill_id ?? CONVERSATION_TURN_SKILL;
  const step_index = input.step_index ?? 0;

  if (!Number.isInteger(input.reservation_ttl_ms) || input.reservation_ttl_ms <= 0) {
    throw new Error(
      'ADMISSION_WINDOW_INVALID: reservation_ttl_ms must be a positive integer number of ' +
        'milliseconds; the durable idempotency window is supplied by the effect guard and is never ' +
        'guessed here (implement/04 §3.2.3).',
    );
  }

  const expiresAt =
    input.expires_at instanceof Date
      ? input.expires_at.toISOString()
      : typeof input.expires_at === 'string'
        ? input.expires_at
        : new Date(now.getTime() + input.reservation_ttl_ms).toISOString();

  return runner(input.tenant_id, async (client: PoolClient): Promise<AdmissionOutcome> => {
    // Step 1: Arbiter insert with ON CONFLICT DO NOTHING
    const insertedReservation = await insertReservationRow(client, {
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      request_id: input.request_id,
      request_fingerprint: input.request_fingerprint,
      run_id: input.run_id,
      step_index,
      skill_id,
      expires_at: expiresAt,
    });

    if (insertedReservation !== null) {
      // Won the race: write the durable task in the same transaction
      const task = await insertDurableTask(client, {
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        correlation_id: input.correlation_id,
        state: 'queued',
        current_step: 0,
        state_payload: { signal: input.signal },
      });

      return {
        kind: 'ADMITTED',
        run_id: input.run_id,
        task,
        reservation: insertedReservation,
      };
    }

    // Step 2: Race lost -> read existing row FOR UPDATE
    const existing = await lockReservationRow(client, input.tenant_id, input.effect_key);
    if (existing === null) {
      throw new Error(
        `EFFECT_RESERVATION_UNSTABLE: effect_key ${input.effect_key} reported collision but row not found under lock.`,
      );
    }

    // Check payload fingerprint
    if (existing.request_fingerprint !== input.request_fingerprint) {
      return { kind: 'CONFLICT' };
    }

    // The column is `jsonb`, so an older row's receipt could be a scalar or an array; a non-object
    // receipt is reported as null rather than reshaped, because reshaping provider evidence would
    // invent a structure the provider never returned.
    const stored_receipt = existing.response_receipt;
    const receipt: Record<string, unknown> | null =
      typeof stored_receipt === 'object' && stored_receipt !== null && !Array.isArray(stored_receipt)
        ? (stored_receipt as Record<string, unknown>)
        : null;

    // Decision table (§04 §3.2.3)
    if (existing.status === 'SUCCEEDED' || (existing.status === 'FAILED' && existing.response_receipt !== null)) {
      return {
        kind: 'REPLAY',
        run_id: existing.run_id,
        receipt,
      };
    }

    if (existing.status === 'RESERVED') {
      if (existing.expired) {
        return { kind: 'RECONCILE_REQUIRED' };
      }
      return {
        kind: 'IN_FLIGHT',
        run_id: existing.run_id,
      };
    }

    if (existing.status === 'FAILED' || existing.status === 'EXPIRED') {
      return { kind: 'RECONCILE_REQUIRED' };
    }

    throw new Error(
      `EFFECT_RESERVATION_STATUS_UNKNOWN: effect_key ${existing.effect_key} carries unhandled status ${String(
        existing.status,
      )}.`,
    );
  });
}

/**
 * @file In-memory effect guard tests (implement/04 §3.2.3, §4.4). Two properties are load bearing:
 * one dispatch slot per effect identity, and an unconfirmed outcome that stays RESERVED — never
 * settled, never retried, never reported as a success this process cannot prove.
 */

import { describe, expect, it } from 'vitest';

import type { IEffectGuard } from '../contracts/ports.js';
import { OrchestratorError } from '../contracts/types.js';
import { computeEffectKey, computeRequestFingerprint } from './effect-key.js';
import {
  EFFECT_RESERVATION_WINDOW_MS,
  MemoryEffectGuard,
  type EffectReservationRow,
} from './memory-effect-guard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const HOUR_MS = 60 * 60 * 1000;

const IDENTITY = {
  tenant_id: TENANT,
  skill_id: 'skill.campaign.launch',
  step_index: 0,
  action_revision: 0,
  request_id: 'signal-1',
} as const;

const PAYLOAD: Record<string, unknown> = { message: 'hello', channel: 'line' };

type ReserveInput = Parameters<IEffectGuard['reserve']>[0];

function testClock(startIso = '2026-01-01T00:00:00.000Z'): {
  now: () => Date;
  advanceMs: (ms: number) => void;
} {
  let currentMs = Date.parse(startIso);
  return {
    now: (): Date => new Date(currentMs),
    advanceMs: (ms: number): void => {
      currentMs += ms;
    },
  };
}

function reservationInput(guard: MemoryEffectGuard, overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    tenant_id: TENANT,
    run_id: 'run-1',
    request_id: IDENTITY.request_id,
    effect_key: guard.computeEffectKey(IDENTITY),
    request_fingerprint: guard.computeRequestFingerprint(PAYLOAD),
    skill_id: IDENTITY.skill_id,
    step_index: IDENTITY.step_index,
    action_revision: IDENTITY.action_revision,
    ...overrides,
  };
}

function rowOf(guard: MemoryEffectGuard, effect_key: string, tenant_id = TENANT): EffectReservationRow {
  const row = guard.peek(tenant_id, effect_key);
  if (row === null) {
    throw new Error(`expected a stored reservation for effect_key ${effect_key}`);
  }
  return row;
}

async function settlementFailure(settlement: Promise<void>): Promise<OrchestratorError> {
  try {
    await settlement;
  } catch (error) {
    if (error instanceof OrchestratorError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the settlement to be rejected');
}

describe('MemoryEffectGuard', () => {
  it('admits the first delivery and timestamps its reservation window', async () => {
    const clock = testClock('2026-01-01T00:00:00.000Z');
    const guard = new MemoryEffectGuard({ now: clock.now });
    const input = reservationInput(guard);

    expect(await guard.reserve(input)).toEqual({ kind: 'RESERVED' });

    const row = rowOf(guard, input.effect_key);
    expect(row.status).toBe('RESERVED');
    expect(row.run_id).toBe('run-1');
    expect(row.request_fingerprint).toBe(computeRequestFingerprint(PAYLOAD));
    expect(row.reserved_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row.expires_at).toBe('2026-01-04T00:00:00.000Z');
  });

  it('never opens a second dispatch slot for a duplicate reservation', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);

    expect(await guard.reserve(input)).toEqual({ kind: 'RESERVED' });
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-2' }))).toEqual({ kind: 'IN_FLIGHT' });
    expect(rowOf(guard, input.effect_key).run_id).toBe('run-1');
  });

  it('replays the stored receipt for a settled effect instead of dispatching again', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    const receipt = { provider_ref: 'msg-77', adapter_status: 'SUCCESS' };

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt });

    const replay = await guard.reserve(reservationInput(guard, { run_id: 'run-2' }));
    expect(replay).toEqual({ kind: 'REPLAY', receipt });
    expect(replay.kind === 'REPLAY' ? replay.receipt : null).toBe(receipt);
  });

  it('conflicts when the same key arrives with a different payload', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    await guard.reserve(input);

    const differentPayload = reservationInput(guard, {
      request_fingerprint: guard.computeRequestFingerprint({ ...PAYLOAD, message: 'goodbye' }),
    });
    expect(await guard.reserve(differentPayload)).toEqual({ kind: 'CONFLICT' });

    await guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: { provider_ref: 'msg-1' },
    });
    expect(await guard.reserve(differentPayload)).toEqual({ kind: 'CONFLICT' });
  });

  it('keeps a reservation open until the window lapses, then requires reconciliation', async () => {
    const clock = testClock();
    const guard = new MemoryEffectGuard({ now: clock.now });
    const input = reservationInput(guard);
    await guard.reserve(input);

    clock.advanceMs(71 * HOUR_MS);
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-2' }))).toEqual({ kind: 'IN_FLIGHT' });

    clock.advanceMs(HOUR_MS + 1);
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-3' }))).toEqual({
      kind: 'RECONCILE_REQUIRED',
    });
    // The row is never rewritten to an "unknown" state while it waits.
    expect(rowOf(guard, input.effect_key).status).toBe('RESERVED');
  });

  it('requires reconciliation after a provider-confirmed failure before any same-key attempt', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'FAILED' });

    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-2' }))).toEqual({
      kind: 'RECONCILE_REQUIRED',
    });

    const reconciled = await guard.reconcile({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      skill_id: IDENTITY.skill_id,
    });
    expect(reconciled).toEqual({ outcome: 'FAILED' });
    expect(reconciled.receipt).toBeUndefined();

    // §4.4 step 3: a confirmed absence is the only condition that clears a re-dispatch under the
    // same key, and the new attempt then settles the same reservation.
    const receipt = { provider_ref: 'msg-78' };
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt });
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-3' }))).toEqual({
      kind: 'REPLAY',
      receipt,
    });
  });

  it('treats an unconfirmed outcome as open: not settled and not retried', async () => {
    const clock = testClock();
    const guard = new MemoryEffectGuard({ now: clock.now });
    const input = reservationInput(guard);
    await guard.reserve(input);

    // The dispatch timed out, so nothing called `resolve`: reconciliation reports INDETERMINATE.
    expect(
      await guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: IDENTITY.skill_id }),
    ).toEqual({ outcome: 'INDETERMINATE' });
    expect(rowOf(guard, input.effect_key).status).toBe('RESERVED');
    // A concurrent worker parks instead of dispatching a second time.
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-2' }))).toEqual({ kind: 'IN_FLIGHT' });

    clock.advanceMs(73 * HOUR_MS);
    expect(
      await guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: IDENTITY.skill_id }),
    ).toEqual({ outcome: 'INDETERMINATE' });
    expect(rowOf(guard, input.effect_key).status).toBe('RESERVED');
  });

  it('never fabricates a reservation for a key it has not seen', async () => {
    const guard = new MemoryEffectGuard();
    const effect_key = guard.computeEffectKey(IDENTITY);

    expect(
      await guard.reconcile({ tenant_id: TENANT, effect_key, skill_id: IDENTITY.skill_id }),
    ).toEqual({ outcome: 'INDETERMINATE' });
    expect(guard.peek(TENANT, effect_key)).toBeNull();
    // Nothing was pre-created, so the first real delivery still owns its dispatch slot.
    expect(await guard.reserve(reservationInput(guard))).toEqual({ kind: 'RESERVED' });
  });

  it('rejects a settlement that is not SUCCEEDED or FAILED and leaves the row open', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    await guard.reserve(input);

    for (const status of ['INDETERMINATE', 'UNKNOWN', 'PENDING', '']) {
      const failure = await settlementFailure(
        guard.resolve({
          tenant_id: TENANT,
          effect_key: input.effect_key,
          status: status as 'SUCCEEDED',
        }),
      );
      expect(failure.code).toBe('INVALID_RESERVATION_SETTLEMENT');
    }

    expect(rowOf(guard, input.effect_key).status).toBe('RESERVED');
    expect(await guard.reserve(reservationInput(guard, { run_id: 'run-2' }))).toEqual({ kind: 'IN_FLIGHT' });
  });

  it('refuses to settle an effect that was never reserved', async () => {
    const guard = new MemoryEffectGuard();
    const effect_key = guard.computeEffectKey(IDENTITY);

    const failure = await settlementFailure(
      guard.resolve({
        tenant_id: TENANT,
        effect_key,
        status: 'SUCCEEDED',
        receipt: { provider_ref: 'unverified' },
      }),
    );
    expect(failure.code).toBe('RESERVATION_NOT_FOUND');
    expect(guard.peek(TENANT, effect_key)).toBeNull();
  });

  it('keeps tenants isolated under the same effect key', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    await guard.reserve(input);

    expect(await guard.reserve(reservationInput(guard, { tenant_id: OTHER_TENANT, run_id: 'run-other' }))).toEqual(
      { kind: 'RESERVED' },
    );

    await guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: { provider_ref: 'msg-a' },
    });
    expect(
      await guard.reserve(reservationInput(guard, { tenant_id: OTHER_TENANT, run_id: 'run-other-2' })),
    ).toEqual({ kind: 'IN_FLIGHT' });
    expect(rowOf(guard, input.effect_key, OTHER_TENANT).status).toBe('RESERVED');
  });

  it('defaults to the provisional 72 h reservation window', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    await guard.reserve(input);

    const row = rowOf(guard, input.effect_key);
    expect(Date.parse(row.expires_at) - Date.parse(row.reserved_at)).toBe(EFFECT_RESERVATION_WINDOW_MS);
    expect(EFFECT_RESERVATION_WINDOW_MS).toBe(72 * HOUR_MS);
  });

  it('exposes the deterministic key functions through the IEffectGuard port', () => {
    const guard: IEffectGuard = new MemoryEffectGuard();
    expect(guard.computeEffectKey(IDENTITY)).toBe(computeEffectKey(IDENTITY));
    expect(guard.computeRequestFingerprint(PAYLOAD)).toBe(computeRequestFingerprint(PAYLOAD));
    expect(guard.computeEffectKey({ ...IDENTITY, request_id: 'signal-2' })).not.toBe(
      computeEffectKey(IDENTITY),
    );
  });
});

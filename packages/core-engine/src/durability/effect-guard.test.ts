/**
 * @file Behavioral contract of the durable effect guard (implement/04 §3.2.2, §3.2.3, §4.4).
 *
 * The guard is the only decider of idempotency, so every case here is written against its public
 * port: the derived `effect_key`, the §3.2.3 decision table, and the two things that must never
 * happen — a second dispatch for one effect, and an unconfirmed outcome recorded as settled. The
 * durable authority is an in-memory `EffectReservationRepository` with the row transitions of
 * `agentos.effect_reservations`; it decides nothing, it only stores what the guard decided, which is
 * exactly the point: a cache-facing or process-local decider could not pass these cases.
 */

import { describe, expect, it } from 'vitest';

import {
  type EffectReservationRecord,
  type EffectReservationRepository,
  type EffectReservationStatus,
  OrchestratorError,
  type ReserveEffectInput,
} from '../contracts/index.js';
import { EFFECT_RESERVATION_TTL_MS, EffectGuard } from './effect-guard.js';

/** The reservation request the guard's public port accepts. */
type ReservationRequest = Parameters<EffectGuard['reserve']>[0];
/** The immutable request identity the `effect_key` is derived from. */
type EffectKeyInput = Parameters<EffectGuard['computeEffectKey']>[0];
/** The outcome vocabulary a settlement may carry; an indeterminate outcome is not in it. */
type SettlementStatus = Parameters<EffectGuard['resolve']>[0]['status'];

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const SKILL = 'skill-1';
const REQUEST_ID = 'req-1';
const START = '2026-09-22T00:00:00.000Z';
/** {@link START} plus the 72-hour idempotency window of §03 §3. */
const WINDOW_END = '2026-09-25T00:00:00.000Z';

/** The identity every case starts from; `run_id` is deliberately not part of it (TC-ORC-010). */
const IDENTITY: EffectKeyInput = {
  tenant_id: TENANT,
  skill_id: SKILL,
  step_index: 3,
  action_revision: 2,
  request_id: REQUEST_ID,
};

const PAYLOAD = { message: 'hi', to: '+6680000000000', amount_thb: 1490 };

/** A provider response as the adapter returned it; the guard hands it back unchanged on a replay. */
const RECEIPT = { provider_reference: 'msg_123', accepted: true, raw: { status: 'ok' } };

/** A clock the test owns, so the reservation window is a fact of the case and not of the machine. */
interface Clock {
  now(): Date;
  advance(ms: number): void;
}

/** Primary key of `agentos.effect_reservations`: an effect belongs to exactly one tenant. */
function storageKey(tenant_id: string, effect_key: string): string {
  return `${tenant_id}|${effect_key}`;
}

/** The two statuses the `effect_reservations.status` column accepts as a settlement. */
function isSettleable(status: string): status is SettlementStatus {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

/**
 * In-memory `agentos.effect_reservations` behind the injected port: the durable fact the guard
 * decides from, with the repository's transition rules — the primary key arbitrates the insert, a
 * settlement applies to a `RESERVED` row only, a reopen to a `FAILED` row only, an expiration to a
 * `RESERVED` row only — and every transition reports whether it applied.
 *
 * Nothing here decides idempotency, and nothing here keeps a cache: the guard is the subject of
 * every case below.
 */
class InMemoryEffectReservations implements EffectReservationRepository {
  private readonly rows = new Map<string, EffectReservationRecord>();

  private readonly now: () => Date;

  /** Models a row a refused insert cannot read back: a lost write, replica lag, or an RLS blind spot. */
  readsBlind = false;

  constructor(now: () => Date) {
    this.now = now;
  }

  async insertReservation(input: ReserveEffectInput): Promise<EffectReservationRecord | null> {
    const key = storageKey(input.tenant_id, input.effect_key);

    if (this.rows.has(key)) {
      return null;
    }

    const row: EffectReservationRecord = {
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      request_id: input.request_id,
      request_fingerprint: input.request_fingerprint,
      run_id: input.run_id,
      step_index: input.step_index,
      skill_id: input.skill_id,
      status: 'RESERVED',
      response_receipt: null,
      reserved_at: this.now().toISOString(),
      resolved_at: null,
      expires_at: input.expires_at,
    };

    this.rows.set(key, row);

    return row;
  }

  async getReservation(tenant_id: string, effect_key: string): Promise<EffectReservationRecord | null> {
    if (this.readsBlind) {
      return null;
    }

    return this.rows.get(storageKey(tenant_id, effect_key)) ?? null;
  }

  async settleReservation(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly status: SettlementStatus;
    readonly receipt?: unknown;
  }): Promise<boolean> {
    const key = storageKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);

    // A settleable row is `RESERVED` and the status must be one the column accepts; anything else
    // settles nothing, exactly as the compare-and-set of §03 DOMAIN 5 reports no row.
    if (row === undefined || row.status !== 'RESERVED' || !isSettleable(input.status)) {
      return false;
    }

    this.rows.set(key, {
      ...row,
      status: input.status,
      response_receipt: input.receipt ?? null,
      resolved_at: this.now().toISOString(),
    });

    return true;
  }

  async reopenReservation(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly expires_at: string;
  }): Promise<boolean> {
    const key = storageKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);

    if (row === undefined || row.status !== 'FAILED') {
      return false;
    }

    this.rows.set(key, {
      ...row,
      status: 'RESERVED',
      expires_at: input.expires_at,
      reserved_at: this.now().toISOString(),
      resolved_at: null,
    });

    return true;
  }

  async expireReservation(input: { readonly tenant_id: string; readonly effect_key: string }): Promise<boolean> {
    const key = storageKey(input.tenant_id, input.effect_key);
    const row = this.rows.get(key);

    if (row === undefined || row.status !== 'RESERVED') {
      return false;
    }

    this.rows.set(key, { ...row, status: 'EXPIRED' });

    return true;
  }

  /**
   * Writes a row exactly as an out-of-band writer could leave it, bypassing every transition above:
   * neither an unrecognised `status` nor an unreadable `expires_at` can be produced by this port, so
   * a seeded row is the only way to observe what the guard decides when it meets one.
   */
  seed(record: EffectReservationRecord): void {
    this.rows.set(storageKey(record.tenant_id, record.effect_key), record);
  }
}

interface Harness {
  readonly guard: EffectGuard;
  readonly reservations: InMemoryEffectReservations;
  readonly clock: Clock;
}

/** Every case gets its own guard, its own rows and its own pinned clock at {@link START}. */
function createHarness(): Harness {
  let current = Date.parse(START);
  const clock: Clock = {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
  const reservations = new InMemoryEffectReservations(clock.now);
  const guard = new EffectGuard({ repository: reservations, now: clock.now });

  return { guard, reservations, clock };
}

/**
 * Builds the reservation request for {@link IDENTITY}, digesting the payload the way the dispatch
 * path does, so a case states only the part of the identity it is about. An `effect_key` or
 * `request_fingerprint` passed in `overrides` wins over the derived value, which is how the
 * fail-closed input checks are reached.
 */
function request(
  guard: EffectGuard,
  overrides: Partial<ReservationRequest> & { payload?: Record<string, unknown> } = {},
): ReservationRequest {
  const identity: EffectKeyInput = {
    tenant_id: overrides.tenant_id ?? IDENTITY.tenant_id,
    skill_id: overrides.skill_id ?? IDENTITY.skill_id,
    step_index: overrides.step_index ?? IDENTITY.step_index,
    action_revision: overrides.action_revision ?? IDENTITY.action_revision,
    request_id: overrides.request_id ?? IDENTITY.request_id,
  };

  return {
    ...identity,
    run_id: overrides.run_id ?? 'run-1',
    effect_key: overrides.effect_key ?? guard.computeEffectKey(identity),
    request_fingerprint: overrides.request_fingerprint
      ?? guard.computeRequestFingerprint(overrides.payload ?? PAYLOAD),
  };
}

/**
 * Runs a call that must fail closed.
 *
 * @param call - Deferred call under test.
 * @returns The refusal code, or `undefined` when the call resolved.
 * @throws The original error when the failure came from outside the contract, so a broken runtime is
 *   never read as a refusal.
 */
async function refusalCodeFrom(call: () => unknown): Promise<string | undefined> {
  try {
    await call();

    return undefined;
  } catch (error) {
    if (error instanceof OrchestratorError) {
      return error.code;
    }

    throw error;
  }
}

/**
 * A durable row as an out-of-band writer could leave it. The identity and payload fingerprint stay
 * those of `input`, so the guard reaches the state check instead of failing an earlier one.
 */
function storedRow(
  input: ReservationRequest,
  state: { status: string; expires_at?: string },
): EffectReservationRecord {
  return {
    tenant_id: input.tenant_id,
    effect_key: input.effect_key,
    request_id: input.request_id,
    request_fingerprint: input.request_fingerprint,
    run_id: input.run_id,
    step_index: input.step_index,
    skill_id: input.skill_id,
    status: state.status as EffectReservationStatus,
    response_receipt: null,
    reserved_at: START,
    resolved_at: null,
    expires_at: state.expires_at ?? WINDOW_END,
  };
}

describe('EffectGuard.computeEffectKey', () => {
  it('derives SHA-256 over the canonical identity object and nothing else', () => {
    const { guard } = createHarness();

    // SHA-256 of {"action_revision":2,"request_id":"req-1","skill_id":"skill-1","step_index":3,"tenant_id":"tenant-1"}
    expect(guard.computeEffectKey(IDENTITY))
      .toBe('2578629fcc69ebbf95e2171baff389022013c0b63f994ad9898f2b3975d5337a');
  });

  it('re-keys on every identity component and stays stable without them', () => {
    const { guard } = createHarness();
    const key = guard.computeEffectKey(IDENTITY);
    const variants: Array<[label: string, identity: EffectKeyInput]> = [
      ['a different tenant', { ...IDENTITY, tenant_id: OTHER_TENANT }],
      ['a different skill', { ...IDENTITY, skill_id: 'skill-2' }],
      ['a different step', { ...IDENTITY, step_index: 4 }],
      ['a different action revision', { ...IDENTITY, action_revision: 3 }],
      ['a different request', { ...IDENTITY, request_id: 'req-2' }],
    ];

    expect(guard.computeEffectKey({ ...IDENTITY })).toBe(key);

    for (const [label, identity] of variants) {
      expect(guard.computeEffectKey(identity), label).not.toBe(key);
    }
  });

  it('refuses an identity component that would collapse distinct requests onto one key', () => {
    const { guard } = createHarness();
    const incomplete: Array<[label: string, identity: EffectKeyInput, code: string]> = [
      ['a blank tenant', { ...IDENTITY, tenant_id: '   ' }, 'TENANT_CONTEXT_REQUIRED'],
      ['a blank skill', { ...IDENTITY, skill_id: '' }, 'SKILL_ID_REQUIRED'],
      ['a blank request identity', { ...IDENTITY, request_id: '' }, 'REQUEST_ID_REQUIRED'],
      ['a negative step', { ...IDENTITY, step_index: -1 }, 'STEP_INDEX_INVALID'],
      ['a fractional step', { ...IDENTITY, step_index: 1.5 }, 'STEP_INDEX_INVALID'],
      ['a negative revision', { ...IDENTITY, action_revision: -1 }, 'ACTION_REVISION_INVALID'],
      ['a fractional revision', { ...IDENTITY, action_revision: 0.5 }, 'ACTION_REVISION_INVALID'],
    ];

    return Promise.all(
      incomplete.map(async ([label, identity, code]) => {
        expect(await refusalCodeFrom(() => guard.computeEffectKey(identity)), label).toBe(code);
      }),
    );
  });
});

describe('EffectGuard.reserve', () => {
  it('reserves an unseen key for the window the clock and the TTL define', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await expect(guard.reserve(input)).resolves.toStrictEqual({ kind: 'RESERVED' });

    expect(await reservations.getReservation(TENANT, input.effect_key)).toStrictEqual({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      request_id: REQUEST_ID,
      request_fingerprint: input.request_fingerprint,
      run_id: 'run-1',
      step_index: 3,
      skill_id: SKILL,
      status: 'RESERVED',
      response_receipt: null,
      reserved_at: START,
      resolved_at: null,
      expires_at: WINDOW_END,
    });
  });

  it('holds a second run of the same request in flight instead of reserving it again', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);

    await expect(guard.reserve({ ...input, run_id: 'run-2' })).resolves.toStrictEqual({ kind: 'IN_FLIGHT' });

    // The winner's row stands: a redelivered request that starts a new run is never a second effect.
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      run_id: 'run-1',
      status: 'RESERVED',
      resolved_at: null,
    });
  });

  it('returns the stored receipt for a replayed success without dispatching again', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt: RECEIPT });

    await expect(guard.reserve({ ...input, run_id: 'run-2' }))
      .resolves.toStrictEqual({ kind: 'REPLAY', receipt: RECEIPT });
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      status: 'SUCCEEDED',
      resolved_at: START,
    });
  });

  it('waits out a live window and asks for reconciliation once it has closed', async () => {
    const { guard, clock } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    clock.advance(EFFECT_RESERVATION_TTL_MS - 1);

    await expect(guard.reserve({ ...input, run_id: 'run-2' })).resolves.toStrictEqual({ kind: 'IN_FLIGHT' });

    clock.advance(1);

    await expect(guard.reserve({ ...input, run_id: 'run-2' })).resolves.toStrictEqual({ kind: 'RECONCILE_REQUIRED' });
  });

  it('fails closed when the same key carries different bytes', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);
    const conflicting = request(guard, { payload: { message: 'different', to: '+6680000000000', amount_thb: 1490 } });

    await guard.reserve(input);

    await expect(guard.reserve({ ...conflicting, effect_key: input.effect_key }))
      .resolves.toStrictEqual({ kind: 'CONFLICT' });

    // A conflict is terminal: it never rewrites the winner's row and never settles the effect.
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      request_fingerprint: input.request_fingerprint,
      status: 'RESERVED',
    });
    await expect(guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL }))
      .resolves.toStrictEqual({ outcome: 'INDETERMINATE' });
  });

  it('fails closed when the presented key is not the canonical derivation', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);
    const foreign = guard.computeEffectKey({ ...IDENTITY, request_id: 'req-2' });

    expect(await refusalCodeFrom(() => guard.reserve({ ...input, effect_key: foreign })))
      .toBe('EFFECT_KEY_MISMATCH');
    expect(await refusalCodeFrom(() => guard.reserve({ ...input, effect_key: 'a'.repeat(64) })))
      .toBe('EFFECT_KEY_MISMATCH');

    expect(await reservations.getReservation(TENANT, input.effect_key)).toBeNull();
    expect(await reservations.getReservation(TENANT, foreign)).toBeNull();
  });

  it('refuses a request_fingerprint that is not a lower-case SHA-256 digest', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    expect(await refusalCodeFrom(() => guard.reserve({ ...input, request_fingerprint: 'nope' })))
      .toBe('REQUEST_FINGERPRINT_INVALID');
    expect(await refusalCodeFrom(() => guard.reserve({
      ...input,
      request_fingerprint: input.request_fingerprint.toUpperCase(),
    }))).toBe('REQUEST_FINGERPRINT_INVALID');

    expect(await reservations.getReservation(TENANT, input.effect_key)).toBeNull();
  });

  it('refuses to dispatch when a refused insert cannot be read back', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    reservations.readsBlind = true;

    expect(await refusalCodeFrom(() => guard.reserve({ ...input, run_id: 'run-2' })))
      .toBe('RESERVATION_NOT_DURABLE');
  });

  it('admits exactly one caller when two workers reserve the same key concurrently', async () => {
    const { guard } = createHarness();
    const input = request(guard);

    const outcomes = await Promise.all([
      guard.reserve(input),
      guard.reserve({ ...input, run_id: 'run-2' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === 'RESERVED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'IN_FLIGHT')).toHaveLength(1);
  });

  it('scopes the reservation to the tenant that made it', async () => {
    const { guard, reservations } = createHarness();
    const ours = request(guard);
    const theirs = request(guard, { tenant_id: OTHER_TENANT });

    await guard.reserve(ours);

    expect(theirs.effect_key).not.toBe(ours.effect_key);
    await expect(guard.reserve(theirs)).resolves.toStrictEqual({ kind: 'RESERVED' });

    expect(await reservations.getReservation(TENANT, theirs.effect_key)).toBeNull();
    expect(await reservations.getReservation(OTHER_TENANT, ours.effect_key)).toBeNull();
  });

  it('refuses to decide from a status outside the four canonical values', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    reservations.seed(storedRow(input, { status: 'UNKNOWN' }));

    expect(await refusalCodeFrom(() => guard.reserve({ ...input, run_id: 'run-2' })))
      .toBe('RESERVATION_STATE_UNRECOGNISED');
    expect(await refusalCodeFrom(() => guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL })))
      .toBe('RESERVATION_STATE_UNRECOGNISED');
  });

  it('parks a reservation whose window cannot be read instead of dispatching it', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    reservations.seed(storedRow(input, { status: 'RESERVED', expires_at: 'not-a-timestamp' }));

    await expect(guard.reserve({ ...input, run_id: 'run-2' })).resolves.toStrictEqual({ kind: 'IN_FLIGHT' });
  });
});

describe('EffectGuard.resolve', () => {
  it('settles a reserved effect with the receipt the provider returned', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);

    await expect(guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: RECEIPT,
    })).resolves.toBeUndefined();

    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      status: 'SUCCEEDED',
      response_receipt: RECEIPT,
      resolved_at: START,
    });
  });

  it('refuses to settle an effect that has no durable reservation', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    expect(await refusalCodeFrom(() => guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: RECEIPT,
    }))).toBe('RESERVATION_NOT_SETTLEABLE');

    // Nothing is invented: a settlement never creates the row it could not find.
    expect(await reservations.getReservation(TENANT, input.effect_key)).toBeNull();
  });

  it('refuses to rewrite an effect that is already settled', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt: RECEIPT });

    expect(await refusalCodeFrom(() => guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'FAILED',
    }))).toBe('RESERVATION_NOT_SETTLEABLE');

    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      status: 'SUCCEEDED',
      response_receipt: RECEIPT,
    });
  });
  it('accepts a matching settlement after a worker interruption and preserves the durable receipt', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt: RECEIPT });

    // The first worker settled the row but crashed before consuming its resume event.
    await expect(guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: { provider_reference: 'a-different-retry-payload' },
    })).resolves.toBeUndefined();

    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      status: 'SUCCEEDED',
      response_receipt: RECEIPT,
    });
  });

  it('never records an indeterminate outcome as a settlement', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);
    const indeterminate = 'UNKNOWN' as unknown as SettlementStatus;

    await guard.reserve(input);

    expect(await refusalCodeFrom(() => guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: indeterminate,
    }))).toBe('RESERVATION_NOT_SETTLEABLE');

    // The row is left exactly as it was, so the effect stays reconcileable once the provider answers.
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({ status: 'RESERVED' });

    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt: RECEIPT });

    await expect(guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL }))
      .resolves.toStrictEqual({ outcome: 'SUCCEEDED', receipt: RECEIPT });
  });

  it('refuses to settle a reservation that has been escalated to a human', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    expect(await reservations.expireReservation({ tenant_id: TENANT, effect_key: input.effect_key })).toBe(true);

    expect(await refusalCodeFrom(() => guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: RECEIPT,
    }))).toBe('RESERVATION_NOT_SETTLEABLE');
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({ status: 'EXPIRED' });
  });
});

describe('EffectGuard.reconcile', () => {
  it('returns the stored receipt for a proven effect', async () => {
    const { guard } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'SUCCEEDED', receipt: RECEIPT });

    await expect(guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL }))
      .resolves.toStrictEqual({ outcome: 'SUCCEEDED', receipt: RECEIPT });
  });

  it('reports FAILED only after the provider confirmed the absence', async () => {
    const { guard } = createHarness();
    const input = request(guard);
    const identity = { tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL };

    await guard.reserve(input);

    await expect(guard.reconcile(identity)).resolves.toStrictEqual({ outcome: 'INDETERMINATE' });

    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'FAILED' });

    // Exact equality: a FAILED outcome carries no receipt at all, so no response is fabricated.
    await expect(guard.reconcile(identity)).resolves.toStrictEqual({ outcome: 'FAILED' });
  });

  it('reports INDETERMINATE for an escalated reservation instead of inferring an absence', async () => {
    const { guard, reservations } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    expect(await reservations.expireReservation({ tenant_id: TENANT, effect_key: input.effect_key })).toBe(true);

    await expect(guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL }))
      .resolves.toStrictEqual({ outcome: 'INDETERMINATE' });
  });

  it('reports INDETERMINATE for a key with no reservation at all', async () => {
    const { guard } = createHarness();
    const input = request(guard);

    // A missing row is not evidence of absence: the effect may have landed before the row was read.
    await expect(guard.reconcile({ tenant_id: TENANT, effect_key: input.effect_key, skill_id: SKILL }))
      .resolves.toStrictEqual({ outcome: 'INDETERMINATE' });
  });

  it('refuses to reconcile through a connector the key is not bound to', async () => {
    const { guard } = createHarness();
    const input = request(guard);

    await guard.reserve(input);

    expect(await refusalCodeFrom(() => guard.reconcile({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      skill_id: 'skill-2',
    }))).toBe('EFFECT_SKILL_MISMATCH');
  });

  it('holds a provider-confirmed absence until the row is reopened, then admits the retry', async () => {
    const { guard, reservations, clock } = createHarness();
    const input = request(guard);

    await guard.reserve(input);
    await guard.resolve({ tenant_id: TENANT, effect_key: input.effect_key, status: 'FAILED' });

    // A confirmed absence is not a licence to dispatch: the step still asks for reconciliation.
    await expect(guard.reserve({ ...input, run_id: 'run-2' })).resolves.toStrictEqual({ kind: 'RECONCILE_REQUIRED' });

    const reopened = await reservations.reopenReservation({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      expires_at: new Date(clock.now().getTime() + EFFECT_RESERVATION_TTL_MS).toISOString(),
    });

    expect(reopened).toBe(true);
    expect(await reservations.getReservation(TENANT, input.effect_key)).toMatchObject({
      status: 'RESERVED',
      resolved_at: null,
    });

    // The reopened window admits the retry, and every later caller of the same key waits on it.
    await expect(guard.reserve({ ...input, run_id: 'run-3' })).resolves.toStrictEqual({ kind: 'IN_FLIGHT' });
  });
});

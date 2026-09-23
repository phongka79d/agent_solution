/**
 * @file Behavioral contract of route-level idempotency (implement/06 §8.0, §8.3 C-6; `04` §4.4,
 * BR-005/BR-006).
 *
 * Every case drives the real `MemoryEffectGuard` from `@agentos/core-engine`, so what is proven
 * here is the mapping the gateway performs on top of the canonical reservation table — never the
 * agreement of a double written to match it. Three things have to hold: a first delivery owns the
 * slot under the canonical BR-005 key, a byte-identical replay returns the stored receipt without
 * a second dispatch, and the same key carrying different bytes is the only `409`.
 */

import {
  EFFECT_RESERVATION_WINDOW_MS,
  MemoryEffectGuard,
  computeEffectKey,
  computeRequestFingerprint,
} from '@agentos/core-engine';
import { describe, expect, it } from 'vitest';

import { FAILURE_STATUS, type GatewayFailure } from './contracts.js';
import { GatewayFailureError } from './http.js';
import { claimIdempotentEffect, settleIdempotentEffect, type IdempotencyOutcome } from './idempotency.js';
import type {
  ApprovalPort,
  ConversationPort,
  EventPort,
  GatewayAuditPort,
  GatewayRuntime,
  IdentityPort,
  KpiPort,
  ReceiptPort,
  RunPort,
  StreamPort,
  TakeoverLeasePort,
  WebhookVerificationPort,
} from './ports.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'run-4c1f0e2a';
const REQUEST_ID = 'signal-9b7c';
const SKILL_ID = 'skill.care.lookup_order';
const STEP_INDEX = 3;
const ACTION_REVISION = 2;

const START = '2026-09-22T00:00:00.000Z';
const GENERATED_ID = 'generated-correlation-id';

/** The five identity fields BR-005 binds; `run_id`, timestamps and retry counters are not among them. */
const IDENTITY = {
  tenant_id: TENANT,
  skill_id: SKILL_ID,
  step_index: STEP_INDEX,
  action_revision: ACTION_REVISION,
  request_id: REQUEST_ID,
};

const PAYLOAD = { order_reference: 'SO-4471', notify: true };
/** The same key's payload with one changed value: different canonical bytes, same identity. */
const CHANGED_PAYLOAD = { order_reference: 'SO-4471', notify: false };
/** What the provider returned for the first dispatch; a replay hands it back unchanged. */
const RECEIPT = { provider_reference: 'msg_77', accepted: true };

/** A clock the test owns, so the reservation window is a fact of the case, not of the machine. */
interface Clock {
  now(): Date;
  advance(ms: number): void;
}

function testClock(start: string): Clock {
  let current = Date.parse(start);
  return {
    now: (): Date => new Date(current),
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

/** The claim a case submits; every case starts from the same five-field identity. */
interface ClaimFixture {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly payload: Record<string, unknown>;
}

function fixture(overrides: Partial<ClaimFixture> = {}): ClaimFixture {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    request_id: REQUEST_ID,
    skill_id: SKILL_ID,
    step_index: STEP_INDEX,
    action_revision: ACTION_REVISION,
    payload: PAYLOAD,
    ...overrides,
  };
}

/**
 * A port that refuses to be used: the claim/settle path may reach the effect guard and nothing
 * else, so a case that touched a store would fail here instead of passing against a fixture.
 */
function refusingPort<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property): unknown => {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (): never => {
        throw new Error(`${name}.${property} is not part of an idempotency case`);
      };
    },
  });
}

/** The `GatewayRuntime` the idempotency cases run against: the real guard plus the fixed clock. */
function testRuntime(guard: MemoryEffectGuard, clock: Clock): GatewayRuntime {
  return {
    conversations: refusingPort<ConversationPort>('conversations'),
    takeover: refusingPort<TakeoverLeasePort>('takeover'),
    runs: refusingPort<RunPort>('runs'),
    approvals: refusingPort<ApprovalPort>('approvals'),
    events: refusingPort<EventPort>('events'),
    timeline: refusingPort<EventPort>('timeline'),
    streams: refusingPort<StreamPort>('streams'),
    kpi: refusingPort<KpiPort>('kpi'),
    identity: refusingPort<IdentityPort>('identity'),
    webhooks: refusingPort<WebhookVerificationPort>('webhooks'),
    audit: refusingPort<GatewayAuditPort>('audit'),
    receipts: refusingPort<ReceiptPort>('receipts'),
    effects: guard,
    clock: clock.now,
    ids: (): string => GENERATED_ID,
  };
}

/** The refusal a call raised; a call that resolved instead fails the case. */
async function refusalOf(action: () => Promise<unknown>): Promise<GatewayFailure> {
  try {
    await action();
  } catch (error) {
    if (error instanceof GatewayFailureError) return error.failure;
    throw error;
  }
  throw new Error('expected the call to raise a gateway refusal');
}

/** The key a first delivery claimed; an outcome that is not `PROCEED` fails the case. */
function claimedKey(outcome: IdempotencyOutcome): string {
  if (outcome.kind !== 'PROCEED') {
    throw new Error(`expected PROCEED, received ${outcome.kind}`);
  }
  return outcome.effect_key;
}

describe('claimIdempotentEffect', () => {
  it('admits the first delivery under the canonical BR-005 key', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    const outcome = await claimIdempotentEffect({ runtime, ...fixture() });

    expect(outcome).toEqual({
      kind: 'PROCEED',
      effect_key: computeEffectKey(IDENTITY),
      request_fingerprint: computeRequestFingerprint(PAYLOAD),
    });
    // A `PROCEED` without a durable slot would be exactly the duplicate dispatch BR-005 forbids.
    expect(guard.peek(TENANT, claimedKey(outcome))).toMatchObject({ status: 'RESERVED' });
  });

  it('returns the stored receipt for a byte-identical replay without dispatching again', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    const first = await claimIdempotentEffect({ runtime, ...fixture() });
    const effect_key = claimedKey(first);
    await settleIdempotentEffect({ runtime, tenant_id: TENANT, effect_key, receipt: RECEIPT });

    const replay = await claimIdempotentEffect({ runtime, ...fixture() });

    expect(replay).toEqual({ kind: 'REPLAY', receipt: RECEIPT });
    // The slot stayed settled: a settlement would have reopened it as `RECONCILE_REQUIRED`.
    expect(guard.peek(TENANT, effect_key)).toMatchObject({ status: 'SUCCEEDED', receipt: RECEIPT });
  });

  it('refuses a changed payload under the same key as IDEMPOTENCY_CONFLICT with status 409', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    const first = await claimIdempotentEffect({ runtime, ...fixture() });
    const effect_key = claimedKey(first);
    await settleIdempotentEffect({ runtime, tenant_id: TENANT, effect_key, receipt: RECEIPT });

    const failure = await refusalOf(() =>
      claimIdempotentEffect({ runtime, ...fixture({ payload: CHANGED_PAYLOAD }) }),
    );

    expect(failure).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT', http_status: 409 });
    expect(FAILURE_STATUS.IDEMPOTENCY_CONFLICT).toBe(409);
    // The settled receipt is never handed out for bytes the key did not carry.
    expect(guard.peek(TENANT, effect_key)).toMatchObject({ status: 'SUCCEEDED', receipt: RECEIPT });
  });

  it('admits the same payload under a fresh key as a new effect', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    const first = claimedKey(await claimIdempotentEffect({ runtime, ...fixture() }));
    const second = await claimIdempotentEffect({
      runtime,
      ...fixture({ request_id: 'signal-9b7d', payload: CHANGED_PAYLOAD }),
    });

    expect(second.kind).toBe('PROCEED');
    expect(claimedKey(second)).not.toBe(first);
    expect(guard.peek(TENANT, first)).toMatchObject({ status: 'RESERVED' });
    expect(guard.peek(TENANT, claimedKey(second))).toMatchObject({ status: 'RESERVED' });
  });

  it('reports IN_FLIGHT while the first delivery still holds the slot', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    await claimIdempotentEffect({ runtime, ...fixture() });

    expect(await claimIdempotentEffect({ runtime, ...fixture() })).toEqual({ kind: 'IN_FLIGHT' });
  });

  it('requires reconciliation once the unconfirmed reservation window has lapsed', async () => {
    const clock = testClock(START);
    const guard = new MemoryEffectGuard({ now: clock.now });
    const runtime = testRuntime(guard, clock);

    const first = await claimIdempotentEffect({ runtime, ...fixture() });
    const effect_key = claimedKey(first);

    clock.advance(EFFECT_RESERVATION_WINDOW_MS + 1);

    expect(await claimIdempotentEffect({ runtime, ...fixture() })).toEqual({
      kind: 'RECONCILE_REQUIRED',
    });
    // An indeterminate outcome is never settled: the row is still the open reservation the
    // reconciliation path reads, not a `FAILED` attempt that a blind retry could reopen.
    expect(guard.peek(TENANT, effect_key)).toMatchObject({ status: 'RESERVED' });
  });
});

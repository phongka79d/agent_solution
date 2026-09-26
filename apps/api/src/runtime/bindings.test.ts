import { describe, expect, it } from 'vitest';

import type {
  AgentRunLog,
  CustomerIdentityRow,
  DurableTaskRecord,
  RedisInjectedClient,
} from '@agentos/database';

import type { IEffectGuard } from '@agentos/core-engine/contracts';
import type { TenantTransactionRunner } from '@agentos/database';

/**
 * The `pg` client handed to a tenant transaction, named through the runner's own signature so this
 * workspace does not need `pg`'s types to script one.
 */
type ScriptedClient = Parameters<Parameters<TenantTransactionRunner>[1]>[0];

import {
  createApprovalReadPort,
  createDurableRunPort,
  createIdentityPort,
  createStartRunPort,
  createTakeoverLeasePort,
} from './bindings.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = 'run-a';
const EFFECT_KEY = 'effect-1';
const NOW = '2026-09-23T00:00:00.000Z';
/** Real SHA-256 digests: the reservation repository validates the fingerprint's shape. */
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function task(overrides: Partial<DurableTaskRecord> = {}): DurableTaskRecord {
  return {
    task_id: 'task-a',
    tenant_id: TENANT,
    run_id: RUN,
    correlation_id: 'corr-a',
    current_step: 2,
    state: 'failed',
    task_version: 4,
    lease_owner: null,
    lease_expires_at: null,
    retry_count: 1,
    max_retries: 3,
    last_error_class: 'FATAL',
    paused_for_approval_id: null,
    state_payload: { pending_action: { effect_key: EFFECT_KEY } },
    error_details: { code: 'CONSENT_REQUIRED' },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function log(overrides: Partial<AgentRunLog> = {}): AgentRunLog {
  return {
    tenant_id: TENANT,
    run_id: RUN,
    agent_id: 'agent-a',
    customer_or_entity_id: 'customer-a',
    trigger: 'signal',
    context: {},
    skill: 'skill.sales.send_message',
    step_index: 2,
    tool: 'API-003',
    decision: { planned_authority: 'AUTH-3' },
    authority: 'AUTH-3',
    approval: null,
    action: { effect_key: EFFECT_KEY, operation: 'send' },
    execution_status: 'failed',
    evidence: { recorded: false },
    outcome: null,
    latency_ms: 12,
    cost: { total_cost_usd: 0.25 },
    error: { code: 'CONSENT_REQUIRED' },
    started_at: NOW,
    completed_at: '2026-09-23T00:00:00.012Z',
    created_at: '2026-09-23T00:00:01.000Z',
    ...overrides,
  };
}

class FakeRedis implements RedisInjectedClient {
  readonly values = new Map<string, string>();
  readonly expiries = new Map<string, number>();

  private readonly nowMs: () => number;

  constructor(nowMs: () => number) {
    this.nowMs = nowMs;
  }

  async set(
    key: string,
    value: string,
    ...args: ReadonlyArray<string | number>
  ): Promise<string | null> {
    if (args.includes('NX') && this.live(key)) return null;
    const px = args.indexOf('PX');
    this.values.set(key, value);
    if (px >= 0) this.expiries.set(key, this.nowMs() + Number(args[px + 1]));
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key) ? (this.values.get(key) ?? null) : null;
  }

  async pttl(key: string): Promise<number> {
    if (!this.live(key)) return -2;
    const expiry = this.expiries.get(key);
    return expiry === undefined ? -1 : expiry - this.nowMs();
  }

  async eval(
    _script: string,
    _keys: number,
    ...args: ReadonlyArray<string | number>
  ): Promise<unknown> {
    const key = String(args[0]);
    const operator = String(args[1]);
    const window = args[2];
    const raw = await this.get(key);
    if (raw === null) return 0;
    const stored = JSON.parse(raw) as { operator_id: string };
    if (stored.operator_id !== operator) return -2;
    if (window === undefined) {
      this.values.delete(key);
      this.expiries.delete(key);
    } else {
      this.expiries.set(key, this.nowMs() + Number(window));
    }
    return 1;
  }
  private live(key: string): boolean {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= this.nowMs()) {
      this.values.delete(key);
      this.expiries.delete(key);
      return false;
    }
    return this.values.has(key);
  }
}

describe('createDurableRunPort', () => {
  it('projects PostgreSQL tasks with their per-step operational log', async () => {
    const durable = task({ state: 'completed', last_error_class: null });
    const port = createDurableRunPort(
      {
        getTask: async () => durable,
        listTasks: async () => ({ items: [durable], next_cursor: 'next' }),
        requeueFailed: async () => durable,
      },
      {
        readRunLogs: async () => [log({ execution_status: 'success', error: null })],
        readEvidenceChain: async () => [{
          evidence_id: 'evidence-a', run_id: RUN, tenant_id: TENANT, correlation_id: 'corr-a',
          step_index: 2, effect_key: EFFECT_KEY, previous_evidence_hash: '0'.repeat(64),
          payload_sha256: '1'.repeat(64), chain_hash: '2'.repeat(64), signature: '3'.repeat(64),
          raw_payload: {}, created_at: NOW,
        }],
      },
      { getReservation: async () => null },
    );

    await expect(port.read({ tenant_id: TENANT, run_id: RUN })).resolves.toEqual({
      run_id: RUN,
      task_version: 4,
      lifecycle_state: 'completed',
      correlation_id: 'corr-a',
      evidence_reference: 'evidence-a',
    });
    await expect(port.list({ tenant_id: TENANT })).resolves.toEqual({
      items: [
        expect.objectContaining({
          run_id: RUN,
          state: 'completed',
          steps: [
            expect.objectContaining({
              step_index: 2,
              action: `{"effect_key":"${EFFECT_KEY}","operation":"send"}`,
              cost: 0.25,
              error: null,
            }),
          ],
        }),
      ],
      next_cursor: 'next',
    });
  });

  it('requeues only a proved side-effect-free failure under the original effect key', async () => {
    let requeues = 0;
    const failed = task();
    const queued = task({ state: 'queued', task_version: 5, last_error_class: null });
    const port = createDurableRunPort(
      {
        getTask: async () => failed,
        listTasks: async () => ({ items: [], next_cursor: null }),
        requeueFailed: async () => {
          requeues += 1;
          return queued;
        },
      },
      { readRunLogs: async () => [log()], readEvidenceChain: async () => [] },
      { getReservation: async () => null },
    );

    await expect(port.classifyRetry(TENANT, RUN)).resolves.toEqual({
      retryable: true,
      failure_class: 'FAIL_CLOSED',
      effect_key: EFFECT_KEY,
    });
    await expect(
      port.retry({ tenant_id: TENANT, run_id: RUN, operator_id: 'op-a', reason: 'approved retry' }),
    ).resolves.toMatchObject({ lifecycle_state: 'queued', task_version: 5 });
    expect(requeues).toBe(1);
  });

  it('routes an unsettled reservation to reconciliation and never calls requeue', async () => {
    let requeues = 0;
    const port = createDurableRunPort(
      {
        getTask: async () => task(),
        listTasks: async () => ({ items: [], next_cursor: null }),
        requeueFailed: async () => {
          requeues += 1;
          return task({ state: 'queued' });
        },
      },
      { readRunLogs: async () => [log()], readEvidenceChain: async () => [] },
      {
        getReservation: async () => ({
          tenant_id: TENANT,
          effect_key: EFFECT_KEY,
          request_id: 'request-a',
          request_fingerprint: 'a'.repeat(64),
          run_id: RUN,
          step_index: 2,
          skill_id: 'skill.sales.send_message',
          status: 'RESERVED',
          response_receipt: null,
          reserved_at: NOW,
          resolved_at: null,
          expires_at: '2026-09-26T00:00:00.000Z',
          expired: false,
        }),
      },
    );

    await expect(port.classifyRetry(TENANT, RUN)).resolves.toEqual({
      retryable: false,
      reason: 'UNKNOWN',
    });
    await expect(
      port.retry({ tenant_id: TENANT, run_id: RUN, operator_id: 'op-a', reason: 'unsafe' }),
    ).rejects.toThrow('RUN_RECONCILIATION_REQUIRED');
    expect(requeues).toBe(0);
  });
});

describe('createApprovalReadPort', () => {
  const detail = {
    approval: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: TENANT,
      run_id: RUN,
      action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      campaign_id: null,
      effect_key: EFFECT_KEY,
      authority_required: 'AUTH-4' as const,
      payload: { channel: 'EMAIL' },
      payload_sha256: 'b'.repeat(64),
      reason: 'human authorization required',
      operator_id: null,
      decision: 'PENDING' as const,
      is_paused: true,
      review_comment: null,
      decided_at: null,
      created_at: NOW,
    },
    action: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: TENANT,
      decision_id: null,
      skill_name: 'skill.sales.send_message',
      effect_key: EFFECT_KEY,
      action_revision: 1,
      target_channel: 'EMAIL',
      action_payload: { channel: 'EMAIL' },
      status: 'pending' as const,
      created_at: NOW,
    },
  };

  it('maps the canonical pending row onto queue and detail responses', async () => {
    const port = createApprovalReadPort({
      listPending: async () => ({ items: [detail], next_cursor: null }),
      getDetail: async () => detail,
    });

    await expect(port.list({ tenant_id: TENANT, status: 'PENDING' })).resolves.toEqual({
      items: [
        expect.objectContaining({
          approval_id: detail.approval.id,
          status: 'PENDING',
          is_paused: true,
          payload_sha256: detail.approval.payload_sha256,
        }),
      ],
      next_cursor: null,
    });
    await expect(port.detail(TENANT, detail.approval.id)).resolves.toEqual(
      expect.objectContaining({ tenant_id: TENANT, expires_at: null }),
    );
  });
});

describe('createTakeoverLeasePort', () => {
  it('uses the canonical tenant/conversation key and owner-checked lease lifecycle', async () => {
    let now = Date.parse(NOW);
    const redis = new FakeRedis(() => now);
    const port = createTakeoverLeasePort(redis, () => new Date(now));

    const acquired = await port.acquire({
      tenant_id: TENANT,
      conversation_id: 'conversation-a',
      operator_id: 'operator-a',
      ttl_seconds: 60,
    });
    expect(acquired.outcome).toBe('ACQUIRED');
    expect([...redis.values.keys()]).toEqual([
      `tenant:${TENANT}:session:conversation-a:takeover_lock`,
    ]);

    const denied = await port.renew({
      tenant_id: TENANT,
      conversation_id: 'conversation-a',
      operator_id: 'operator-b',
      extend_seconds: 30,
    });
    expect(denied.outcome).toBe('HELD_BY_ANOTHER_OPERATOR');

    const released = await port.release({
      tenant_id: TENANT,
      conversation_id: 'conversation-a',
      operator_id: 'operator-a',
    });
    expect(released.outcome).toBe('EXPIRED');
    await expect(port.holder(TENANT, 'conversation-a')).resolves.toBeNull();

    now += 60_000;
  });
});

describe('createIdentityPort', () => {
  it('resolves only a verified exact tenant/channel identity', async () => {
    const verified: CustomerIdentityRow = {
      id: 'identity-a',
      tenant_id: TENANT,
      customer_id: 'customer-a',
      channel_type: 'LINE',
      channel_identifier: 'line-user-a',
      identifier_hash: 'hash-a',
      is_primary: true,
      verified_at: new Date(NOW),
      created_at: new Date(NOW),
    };
    const port = createIdentityPort(async () => verified);

    await expect(
      port.resolveCustomer({
        tenant_id: TENANT,
        session_id: 'session-a',
        channel_type: 'LINE',
        channel_identifier: 'line-user-a',
        claimed_customer_id: 'attacker-claim',
      }),
    ).resolves.toEqual({ customer_id: 'customer-a', verdict: 'CHANNEL_IDENTIFIER_EXACT' });
  });

  it('stays unresolved without a verified channel identifier', async () => {
    let lookups = 0;
    const port = createIdentityPort(async () => {
      lookups += 1;
      return null;
    });

    await expect(
      port.resolveCustomer({
        tenant_id: TENANT,
        session_id: 'session-a',
        channel_type: 'OPERATOR',
        claimed_customer_id: 'customer-a',
      }),
    ).resolves.toEqual({ customer_id: null, verdict: 'UNRESOLVED' });
    expect(lookups).toBe(0);
  });
});

describe('createStartRunPort', () => {
  const guard: IEffectGuard = {
    computeEffectKey: () => 'effect-care-1',
    computeRequestFingerprint: (payload) => {
      return (payload as { message?: string })?.message === 'different' ? DIGEST_B : DIGEST_A;
    },
    reserve: async () => ({ kind: 'RESERVED' as const }),
    resolve: async () => {},
    reconcile: async () => ({ outcome: 'INDETERMINATE' as const }),
  };

  function createTestRunner(handler: (sql: string, values: readonly unknown[]) => Record<string, unknown>[]) {
    const client = {
      async query<R extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number; command: string; oid: number; fields: unknown[] }> {
        const rows = handler(sql, values ?? []) as R[];
        return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
      },
    } as unknown as ScriptedClient;

    return async <T>(_tenant: string, work: (c: ScriptedClient) => Promise<T>): Promise<T> => {
      return work(client);
    };
  }

  it('admits a new run on first delivery and persists the API-resolved conversation UUID in subject', async () => {
    let persistedStatePayload: unknown;
    const runner = createTestRunner((sql, values) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return [
          {
            tenant_id: TENANT,
            effect_key: 'effect-care-1',
            request_id: 'req-1',
            request_fingerprint: DIGEST_A,
            run_id: 'minted-run-1',
            step_index: 0,
            skill_id: 'conversation.turn',
            status: 'RESERVED',
            response_receipt: null,
            reserved_at: new Date(),
            resolved_at: null,
            expires_at: new Date(Date.now() + 100000),
            expired: false,
          },
        ];
      }
      if (sql.includes('INSERT INTO agentos.platform_durable_tasks')) {
        persistedStatePayload = JSON.parse(String(values[6]));
        return [
          {
            tenant_id: TENANT,
            run_id: 'minted-run-1',
            correlation_id: 'corr-1',
            current_step: 0,
            state: 'queued',
            task_version: 1,
            retry_count: 0,
            max_retries: 3,
            last_error_class: null,
            last_error_details: null,
            lease_owner: null,
            lease_expires_at: null,
            state_payload: persistedStatePayload,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });

    const port = createStartRunPort({
      guard,
      workflows: { getTask: async () => null },
      ids: () => 'minted-run-1',
      runner,
    });

    const started = await port.start({
      tenant_id: TENANT,
      correlation_id: 'corr-1',
      request_id: 'req-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      session_id: 'session-1',
      channel_type: 'WEB_CHAT',
      payload: { message: 'hello', conversation_id: 'conv-1' },
    });

    expect(started).toEqual({
      run_id: 'minted-run-1',
      task_version: 1,
      correlation_id: 'corr-1',
      lifecycle_state: 'queued',
      admission: 'ADMITTED',
    });
    expect(persistedStatePayload).toMatchObject({
      signal: {
        subject: {
          session_id: 'session-1',
          conversation_id: 'conv-1',
          channel_type: 'WEB_CHAT',
        },
      },
    });
  });

  it('returns existing task identity on REPLAY / IN_FLIGHT duplicate', async () => {
    const runner = createTestRunner((sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return []; // conflict
      }
      if (sql.includes('FOR UPDATE')) {
        return [
          {
            tenant_id: TENANT,
            effect_key: 'effect-care-1',
            request_id: 'req-1',
            request_fingerprint: DIGEST_A,
            run_id: 'existing-run-id',
            step_index: 0,
            skill_id: 'conversation.turn',
            status: 'RESERVED',
            response_receipt: null,
            reserved_at: new Date(),
            resolved_at: null,
            expires_at: new Date(Date.now() + 100000),
            expired: false,
          },
        ];
      }
      return [];
    });

    const port = createStartRunPort({
      guard,
      workflows: {
        getTask: async (_tenant, runId) => {
          return task({
            run_id: runId,
            task_version: 2,
            correlation_id: 'orig-corr',
            state: 'running',
          });
        },
      },
      ids: () => 'unused-run-id',
      runner,
    });

    const started = await port.start({
      tenant_id: TENANT,
      correlation_id: 'corr-2',
      request_id: 'req-1',
      source_channel: 'WEB_CHAT',
      event_type: 'message.received',
      session_id: 'session-1',
      channel_type: 'WEB_CHAT',
      payload: { message: 'hello', conversation_id: 'conv-1' },
    });

    expect(started).toEqual({
      run_id: 'existing-run-id',
      task_version: 2,
      correlation_id: 'orig-corr',
      lifecycle_state: 'running',
      admission: 'IN_FLIGHT',
    });
  });

  it('throws IDEMPOTENCY_CONFLICT on payload conflict', async () => {
    const runner = createTestRunner((sql) => {
      if (sql.includes('INSERT INTO agentos.effect_reservations')) {
        return [];
      }
      if (sql.includes('FOR UPDATE')) {
        return [
          {
            tenant_id: TENANT,
            effect_key: 'effect-care-1',
            request_id: 'req-1',
            request_fingerprint: DIGEST_A, // existing was fingerprint-care-1
            run_id: 'existing-run-id',
            step_index: 0,
            skill_id: 'conversation.turn',
            status: 'RESERVED',
            response_receipt: null,
            reserved_at: new Date(),
            resolved_at: null,
            expires_at: new Date(Date.now() + 100000),
            expired: false,
          },
        ];
      }
      return [];
    });

    const port = createStartRunPort({
      guard,
      workflows: { getTask: async () => null },
      ids: () => 'minted-run-2',
      runner,
    });

    await expect(
      port.start({
        tenant_id: TENANT,
        correlation_id: 'corr-different',
        request_id: 'req-1',
        source_channel: 'WEB_CHAT',
        event_type: 'message.received',
        session_id: 'session-1',
        channel_type: 'WEB_CHAT',
        payload: { message: 'different', conversation_id: 'conv-1' },
      }),
    ).rejects.toMatchObject({
      failure: {
        error_code: 'IDEMPOTENCY_CONFLICT',
        http_status: 409,
      },
    });
  });
});

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { registerConversationRoutes } from './conversations.js';

const TENANT = 'tenant-a';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_TOKEN = 'session-token';

function buildHarness() {
  const conversation = {
    conversation_id: CONVERSATION_ID,
    tenant_id: TENANT,
    customer_id: null,
    channel: 'WEB_CHAT',
    external_thread_id: 'thread-a',
    active_agent: 'auto',
    state: 'open' as 'open' | 'paused_takeover' | 'closed',
    takeover_operator_id: null as string | null,
    last_message_at: '2026-09-23T00:00:00.000Z',
    created_at: '2026-09-23T00:00:00.000Z',
  };
  const receipts = new Map<string, Record<string, unknown>>();
  const appendMessage = vi.fn(async (_input: unknown) => undefined);
  const start = vi.fn(async (input: { correlation_id: string }) => ({
    run_id: 'run-a',
    task_version: 1,
    correlation_id: input.correlation_id,
    lifecycle_state: 'queued' as const,
    admission: 'ADMITTED' as 'ADMITTED' | 'IN_FLIGHT',
  }));
  const runtime = {
    conversations: {
      get: vi.fn(async (_tenant_id: string, _conversation_id: string) => conversation),
      appendMessage,
    },
    takeover: { holder: vi.fn(async () => null) },
    runs: { start },
    receipts: {
      receiptFor: vi.fn(async (_tenant_id: string, effect_key: string) => receipts.get(effect_key) ?? null),
      storeReceipt: vi.fn(async (_tenant_id: string, effect_key: string, receipt: Record<string, unknown>) => {
        receipts.set(effect_key, receipt);
      }),
    },
    effects: {
      computeEffectKey: (input: { tenant_id: string; skill_id: string; request_id: string }) =>
        [input.tenant_id, input.skill_id, input.request_id].join(':'),
      computeRequestFingerprint: (input: Record<string, unknown>) => JSON.stringify(input),
    },
    audit: { record: vi.fn(async () => undefined) },
    clock: () => new Date('2026-09-23T00:00:00.000Z'),
    ids: () => 'corr-a',
  } as unknown as GatewayRuntime;

  const app = Fastify({ logger: false });
  registerConversationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [],
      sessions: [{
        token: SESSION_TOKEN,
        tenant_id: TENANT,
        conversation_id: CONVERSATION_ID,
        session_id: 'session-a',
        channel: 'WEB_CHAT',
      }],
      widgets: [],
    }),
  });

  return { app, appendMessage, conversation, receipts, start };
}

function buildTakeoverHarness() {
  const conversation: {
    conversation_id: string;
    tenant_id: string;
    customer_id: string | null;
    channel: 'WEB_CHAT';
    external_thread_id: string;
    active_agent: string;
    state: 'open' | 'paused_takeover' | 'closed';
    takeover_operator_id: string | null;
    last_message_at: string;
    created_at: string;
  } = {
    conversation_id: CONVERSATION_ID,
    tenant_id: TENANT,
    customer_id: null,
    channel: 'WEB_CHAT',
    external_thread_id: 'thread-a',
    active_agent: 'auto',
    state: 'open',
    takeover_operator_id: null,
    last_message_at: '2026-09-23T00:00:00.000Z',
    created_at: '2026-09-23T00:00:00.000Z',
  };
  const lease = { operator_id: 'operator-a', expires_at: '2026-09-23T00:01:00.000Z' };
  const acquire = vi.fn(async (_input: unknown) => ({
    outcome: 'ACQUIRED' as 'ACQUIRED' | 'RENEWED' | 'HELD_BY_ANOTHER_OPERATOR',
    lease,
  }));
  const release = vi.fn(async (_input: unknown) => ({
    outcome: 'EXPIRED' as 'EXPIRED' | 'NOT_HELD' | 'HELD_BY_ANOTHER_OPERATOR',
    lease: null,
  }));
  const claim = vi.fn(async (_input: unknown): Promise<'CLAIMED' | 'NO_HANDOFF' | 'HELD_BY_ANOTHER_OPERATOR'> => 'CLAIMED');
  const complete = vi.fn(async (_input: unknown): Promise<'COMPLETED' | 'NO_HANDOFF' | 'NOT_ASSIGNED' | 'HELD_BY_ANOTHER_OPERATOR'> => 'COMPLETED');
  const setState = vi.fn(async (
    _tenant_id: string,
    _conversation_id: string,
    state: 'open' | 'paused_takeover' | 'closed',
    operator_id: string | null,
  ) => {
    conversation.state = state;
    conversation.takeover_operator_id = operator_id;
  });
  const runtime = {
    conversations: {
      get: vi.fn(async () => conversation),
      setState,
    },
    takeover: { acquire, release },
    handoffs: { claim, complete },
    audit: { record: vi.fn(async () => undefined) },
    clock: () => new Date('2026-09-23T00:00:00.000Z'),
    ids: () => 'corr-a',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  registerConversationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{
        token: 'operator-token',
        tenant_id: TENANT,
        operator_id: 'operator-a',
        permissions: ['conversation:takeover'],
      }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, acquire, claim, complete, conversation, release, setState };
}

describe('conversation takeover durable handoff coordination', () => {
  it('claims a queued handoff without re-writing the conversation outside the claim transaction', async () => {
    const { app, claim, setState } = buildTakeoverHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'customer requested a person', takeover_mode: 'FULL_CONTROL' },
    });
    expect(response.statusCode).toBe(200);
    expect(claim).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      operator_id: 'operator-a',
    });
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the manual takeover path only when no durable handoff exists', async () => {
    const { app, claim, setState } = buildTakeoverHarness();
    claim.mockResolvedValue('NO_HANDOFF');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(response.statusCode).toBe(200);
    expect(setState).toHaveBeenCalledWith(TENANT, CONVERSATION_ID, 'paused_takeover', 'operator-a');
    await app.close();
  });

  it('releases only a newly acquired Redis lease when durable claim fails', async () => {
    const acquired = buildTakeoverHarness();
    acquired.claim.mockRejectedValue(new Error('database unavailable'));
    await acquired.app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(acquired.release).toHaveBeenCalledOnce();
    await acquired.app.close();

    const renewed = buildTakeoverHarness();
    renewed.acquire.mockResolvedValue({
      outcome: 'RENEWED',
      lease: { operator_id: 'operator-a', expires_at: '2026-09-23T00:01:00.000Z' },
    });
    renewed.claim.mockRejectedValue(new Error('database unavailable'));
    await renewed.app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(renewed.release).not.toHaveBeenCalled();
    await renewed.app.close();
  });

  it('returns bot control only through the assigned handoff completion transaction', async () => {
    const { app, complete, conversation, release, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: { handoff_summary: 'resolved with the customer' },
    });
    expect(response.statusCode).toBe(200);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]!);
    expect(complete).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      operator_id: 'operator-a',
      completion_summary: 'resolved with the customer',
    });
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the manual resume state path only when no durable handoff exists', async () => {
    const { app, complete, conversation, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    complete.mockResolvedValue('NO_HANDOFF');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(setState).toHaveBeenCalledWith(TENANT, CONVERSATION_ID, 'open', null);
    await app.close();
  });

  it('refuses to complete a queued handoff not assigned to the operator', async () => {
    const { app, complete, conversation, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    complete.mockResolvedValue('NOT_ASSIGNED');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('TAKEOVER_LEASE_LOST');
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });
});
describe('POST /conversations/:conversation_id/messages shared Care admission', () => {
  it('replays the durable acceptance without starting or appending twice, and rejects changed bytes', async () => {
    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Where is my order?', idempotency_key: 'turn-1', module: 'support' };

    try {
      const first = await app.inject({ method: 'POST', url, headers, payload: body });
      const replay = await app.inject({ method: 'POST', url, headers, payload: body });
      const conflict = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...body, message: 'Different message' },
      });

      expect(first.statusCode).toBe(202);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(first.json());
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error_code).toBe('IDEMPOTENCY_CONFLICT');
      expect(start).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        request_id: 'turn-1',
        event_type: 'message.received',
        payload: { conversation_id: CONVERSATION_ID, message: 'Where is my order?', module: 'support' },
      });
    } finally {
      await app.close();
    }
  });

  it('waits for an in-flight admission receipt without appending another inbound message', async () => {
    const { app, appendMessage, receipts, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const request = { message: 'Where is my order?', idempotency_key: 'turn-flight', module: 'support' };
    const effectKey = [TENANT, 'conversation.turn', request.idempotency_key].join(':');
    const receipt = {
      task_id: 'run-existing',
      conversation_id: CONVERSATION_ID,
      status: 'running',
      task_version: 3,
      correlation_id: 'corr-existing',
      request_fingerprint: JSON.stringify({
        message: request.message,
        conversation_id: CONVERSATION_ID,
        module: 'support',
        attachments: null,
      }),
    };

    start.mockImplementationOnce(async (input) => {
      setTimeout(() => receipts.set(effectKey, receipt), 0);
      return {
        run_id: 'run-contender',
        task_version: 1,
        correlation_id: input.correlation_id,
        lifecycle_state: 'queued',
        admission: 'IN_FLIGHT',
      };
    });

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: request });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        task_id: 'run-existing',
        conversation_id: CONVERSATION_ID,
        status: 'running',
        correlation_id: 'corr-existing',
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects message admission with HTTP 409 and CONVERSATION_LOCKED when conversation.state=paused_takeover', async () => {
    const { app, appendMessage, conversation, start } = buildHarness();
    conversation.state = 'paused_takeover';
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Where is my order?', idempotency_key: 'turn-paused', module: 'support' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error_code: 'CONVERSATION_LOCKED',
        retryable: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects module: sales with HTTP 403 and CAPABILITY_NOT_ENABLED when ENABLED_AGENT_MODULES is unset', async () => {
    const originalEnv = process.env.ENABLED_AGENT_MODULES;
    delete process.env.ENABLED_AGENT_MODULES;

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Can I buy this?', idempotency_key: 'turn-sales-denied', module: 'sales' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error_code: 'CAPABILITY_NOT_ENABLED',
        message: 'only Customer Care support turns are enabled',
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) process.env.ENABLED_AGENT_MODULES = originalEnv;
      else delete process.env.ENABLED_AGENT_MODULES;
      await app.close();
    }
  });

  it('admits module: sales when ENABLED_AGENT_MODULES=support,sales and passes module to start run', async () => {
    const originalEnv = process.env.ENABLED_AGENT_MODULES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Can I buy this product?', idempotency_key: 'turn-sales-allowed', module: 'sales' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        request_id: 'turn-sales-allowed',
        payload: { conversation_id: CONVERSATION_ID, message: 'Can I buy this product?', module: 'sales' },
      });
      expect(appendMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (originalEnv !== undefined) process.env.ENABLED_AGENT_MODULES = originalEnv;
      else delete process.env.ENABLED_AGENT_MODULES;
      await app.close();
    }
  });

  it('rejects module: marketing with HTTP 403 and CAPABILITY_NOT_ENABLED when only support,sales are enabled', async () => {
    const originalEnv = process.env.ENABLED_AGENT_MODULES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Send me promo email', idempotency_key: 'turn-mkt-denied', module: 'marketing' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error_code: 'CAPABILITY_NOT_ENABLED',
        message: 'only Customer Care support turns are enabled',
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) process.env.ENABLED_AGENT_MODULES = originalEnv;
      else delete process.env.ENABLED_AGENT_MODULES;
      await app.close();
    }
  });

  it('respects injected deps.enabledModules over environment variable', async () => {
    const originalEnv = process.env.ENABLED_AGENT_MODULES;
    process.env.ENABLED_AGENT_MODULES = 'support';

    const { appendMessage, conversation, receipts, start } = buildHarness();
    const app = Fastify({ logger: false });
    registerConversationRoutes(app, {
      runtime: {
        conversations: {
          get: vi.fn(async () => conversation),
          appendMessage,
        },
        receipts: {
          receiptFor: vi.fn(async (_tid: string, key: string) => receipts.get(key) ?? null),
          storeReceipt: vi.fn(async (_tid: string, key: string, receipt: Record<string, unknown>) => {
            receipts.set(key, receipt);
          }),
        },
        takeover: { holder: vi.fn(async () => null) },
        runs: { start },
        effects: {
          computeEffectKey: vi.fn(({ request_id }: { request_id: string }) => `${TENANT}:turn:${request_id}`),
          computeRequestFingerprint: vi.fn((p: unknown) => JSON.stringify(p)),
        },
        audit: { record: vi.fn(async () => undefined) },
        clock: () => new Date('2026-09-23T00:00:00.000Z'),
        ids: () => 'corr-injected-sales',
      } as unknown as GatewayRuntime,
      credentials: createCredentialStore({
        operators: [],
        sessions: [
          {
            token: SESSION_TOKEN,
            tenant_id: TENANT,
            conversation_id: CONVERSATION_ID,
            session_id: 'session-1',
            channel: 'WEB_CHAT',
          },
        ],
        widgets: [],
      }),
      enabledModules: ['support', 'sales'],
    });

    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Can I buy this?', idempotency_key: 'turn-injected-sales', module: 'sales' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });
      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      if (originalEnv !== undefined) process.env.ENABLED_AGENT_MODULES = originalEnv;
      else delete process.env.ENABLED_AGENT_MODULES;
      await app.close();
    }
  });

  it('admits module: sales with event_type: cart.abandoned when SALES_SIGNAL_EVENT_TYPES=cart.abandoned', async () => {
    const originalModules = process.env.ENABLED_AGENT_MODULES;
    const originalEventTypes = process.env.SALES_SIGNAL_EVENT_TYPES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';
    process.env.SALES_SIGNAL_EVENT_TYPES = 'cart.abandoned';

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = {
      message: 'Restore my cart',
      idempotency_key: 'turn-sales-cart',
      module: 'sales',
      event_type: 'cart.abandoned',
    };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        request_id: 'turn-sales-cart',
        event_type: 'cart.abandoned',
        payload: { conversation_id: CONVERSATION_ID, message: 'Restore my cart', module: 'sales' },
      });
      expect(appendMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (originalModules !== undefined) process.env.ENABLED_AGENT_MODULES = originalModules;
      else delete process.env.ENABLED_AGENT_MODULES;
      if (originalEventTypes !== undefined) process.env.SALES_SIGNAL_EVENT_TYPES = originalEventTypes;
      else delete process.env.SALES_SIGNAL_EVENT_TYPES;
      await app.close();
    }
  });

  it('refuses module: sales with event_type: cart.abandoned when Sales contract is not configured', async () => {
    const originalModules = process.env.ENABLED_AGENT_MODULES;
    const originalEventTypes = process.env.SALES_SIGNAL_EVENT_TYPES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';
    delete process.env.SALES_SIGNAL_EVENT_TYPES;

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = {
      message: 'Restore my cart',
      idempotency_key: 'turn-sales-unconfigured',
      module: 'sales',
      event_type: 'cart.abandoned',
    };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      if (originalModules !== undefined) process.env.ENABLED_AGENT_MODULES = originalModules;
      else delete process.env.ENABLED_AGENT_MODULES;
      if (originalEventTypes !== undefined) process.env.SALES_SIGNAL_EVENT_TYPES = originalEventTypes;
      else delete process.env.SALES_SIGNAL_EVENT_TYPES;
      await app.close();
    }
  });

  it('refuses request with an event_type outside the accepted set and never calls start', async () => {
    const originalModules = process.env.ENABLED_AGENT_MODULES;
    const originalEventTypes = process.env.SALES_SIGNAL_EVENT_TYPES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';
    process.env.SALES_SIGNAL_EVENT_TYPES = 'cart.abandoned';

    const { app, appendMessage, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };

    try {
      // 1. Sales module with an unexpected event type
      const salesBad = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          message: 'Restore cart',
          idempotency_key: 'turn-bad-event-sales',
          module: 'sales',
          event_type: 'order.cancelled',
        },
      });
      expect(salesBad.statusCode).toBe(400);
      expect(salesBad.json()).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();

      // 2. Support module with cart.abandoned (Care contract only accepts message.received)
      const supportBad = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          message: 'Help me',
          idempotency_key: 'turn-bad-event-support',
          module: 'support',
          event_type: 'cart.abandoned',
        },
      });
      expect(supportBad.statusCode).toBe(400);
      expect(supportBad.json()).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();

      // 3. Invalid/empty string event_type
      const emptyType = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          message: 'Help me',
          idempotency_key: 'turn-empty-event',
          module: 'support',
          event_type: '   ',
        },
      });
      expect(emptyType.statusCode).toBe(400);
      expect(emptyType.json()).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        retryable: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      if (originalModules !== undefined) process.env.ENABLED_AGENT_MODULES = originalModules;
      else delete process.env.ENABLED_AGENT_MODULES;
      if (originalEventTypes !== undefined) process.env.SALES_SIGNAL_EVENT_TYPES = originalEventTypes;
      else delete process.env.SALES_SIGNAL_EVENT_TYPES;
      await app.close();
    }
  });

  it('respects injected deps.salesSignalEventTypes over environment variable', async () => {
    const originalModules = process.env.ENABLED_AGENT_MODULES;
    const originalEventTypes = process.env.SALES_SIGNAL_EVENT_TYPES;
    process.env.ENABLED_AGENT_MODULES = 'support,sales';
    process.env.SALES_SIGNAL_EVENT_TYPES = 'unrelated.event';

    const { appendMessage, conversation, receipts, start } = buildHarness();
    const app = Fastify({ logger: false });
    registerConversationRoutes(app, {
      runtime: {
        conversations: {
          get: vi.fn(async () => conversation),
          appendMessage,
        },
        takeover: { holder: vi.fn(async () => null) },
        runs: { start },
        receipts: {
          receiptFor: vi.fn(async (_t, key) => receipts.get(key) ?? null),
          storeReceipt: vi.fn(async (_t, key, r) => { receipts.set(key, r); }),
        },
        effects: {
          computeEffectKey: (input: { tenant_id: string; skill_id: string; request_id: string }) =>
            [input.tenant_id, input.skill_id, input.request_id].join(':'),
          computeRequestFingerprint: (input: Record<string, unknown>) => JSON.stringify(input),
        },
        audit: { record: vi.fn(async () => undefined) },
        clock: () => new Date('2026-09-23T00:00:00.000Z'),
        ids: () => 'corr-injected-event',
      } as unknown as GatewayRuntime,
      credentials: createCredentialStore({
        operators: [],
        sessions: [{
          token: SESSION_TOKEN,
          tenant_id: TENANT,
          conversation_id: CONVERSATION_ID,
          session_id: 'session-1',
          channel: 'WEB_CHAT',
        }],
        widgets: [],
      }),
      enabledModules: ['support', 'sales'],
      salesSignalEventTypes: ['cart.abandoned'],
    });

    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };

    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          message: 'Restore cart',
          idempotency_key: 'turn-injected-event',
          module: 'sales',
          event_type: 'cart.abandoned',
        },
      });
      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        request_id: 'turn-injected-event',
        event_type: 'cart.abandoned',
      });
    } finally {
      if (originalModules !== undefined) process.env.ENABLED_AGENT_MODULES = originalModules;
      else delete process.env.ENABLED_AGENT_MODULES;
      if (originalEventTypes !== undefined) process.env.SALES_SIGNAL_EVENT_TYPES = originalEventTypes;
      else delete process.env.SALES_SIGNAL_EVENT_TYPES;
      await app.close();
    }
  });
});

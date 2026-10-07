/**
 * @file Conversation routes: shared Care turn admission.
 *
 * Split from `conversations.test.ts`; the sibling file holds the other group exactly once and
 * every assertion body is unchanged.
 */

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createCredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { TurnIntentPort } from '../../runtime/bindings/turn-intent.js';
import type { TurnRateLimiter } from './care-turn.js';
import { registerConversationRoutes } from './conversations.js';

const TENANT = 'tenant-a';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

const SESSION_TOKEN = 'session-token';

function buildHarness(options: {
  readonly intentProposer?: TurnIntentPort;
  readonly takeoverHolder?: { readonly operator_id: string; readonly expires_at: string } | null;
  readonly turnRateLimiter?: TurnRateLimiter;
} = {}) {
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
  const providerCalls = { appendProviderCall: vi.fn(async (_input: unknown) => undefined) };
  const audit = { record: vi.fn(async (_input: unknown) => undefined) };
  const appendMessage = vi.fn(async (_input: unknown) => undefined);
  const setState = vi.fn(async (
    _tenant_id: string,
    _conversation_id: string,
    state: 'open' | 'paused_takeover' | 'closed',
    operator_id: string | null,
  ) => {
    conversation.state = state;
    conversation.takeover_operator_id = operator_id;
  });
  const clearTakeoverIfOwned = vi.fn(async (
    _tenant_id: string,
    _conversation_id: string,
    operator_id: string,
  ) => {
    if (conversation.state !== 'paused_takeover' || conversation.takeover_operator_id !== operator_id) return false;
    conversation.state = 'open';
    conversation.takeover_operator_id = null;
    return true;
  });
  // The real `runs.start` port carries the server-resolved channel, so the fixture names it too:
  // a case can then assert what the admission path actually passed.
  const start = vi.fn(async (input: { correlation_id: string; source_channel?: string; payload?: Record<string, unknown>; [key: string]: unknown }) => ({
    run_id: 'run-a',
    task_version: 1,
    correlation_id: input.correlation_id,
    lifecycle_state: 'queued' as const,
    admission: 'ADMITTED' as 'ADMITTED' | 'IN_FLIGHT',
  }));
  const reserve = vi.fn(async (): Promise<{ kind: 'RESERVED' | 'IN_FLIGHT' }> => ({ kind: 'RESERVED' }));
  const runtime = {
    conversations: {
      get: vi.fn(async (_tenant_id: string, _conversation_id: string) => conversation),
      appendMessage,
      setState,
      clearTakeoverIfOwned,
    },
    takeover: {
      holder: vi.fn(async () => options.takeoverHolder === undefined ? null : options.takeoverHolder),
    },
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
      reserve,
      resolve: vi.fn(async () => undefined),
    },
    audit,
    providerCalls,
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
    ...(options.intentProposer === undefined ? {} : { intentProposer: options.intentProposer }),
    ...(options.turnRateLimiter === undefined ? {} : { turnRateLimiter: options.turnRateLimiter }),
  });

  return { app, appendMessage, conversation, receipts, start, reserve, providerCalls, audit, setState, clearTakeoverIfOwned };
}

describe('POST /conversations/:conversation_id/messages shared Care admission', () => {
  it('records only redacted provider telemetry after an admitted intent proposal', async () => {
    const intentProposer: TurnIntentPort = {
      propose: vi.fn(async () => ({
        intent: 'faq_search' as const,
        requirements: { question: 'return policy' },
        confidence: 0.93,
        metadata: {
          provider: 'openai-compatible',
          model: 'intent-model',
          request_id: 'provider-request-1',
          latency_ms: 21,
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
      })),
    };
    const { app, providerCalls } = buildHarness({ intentProposer });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION_ID}/messages`,
        headers: { authorization: `Bearer ${SESSION_TOKEN}` },
        payload: { message: 'What is your return policy?', idempotency_key: 'turn-provider-1', module: 'support' },
      });

      expect(response.statusCode).toBe(202);
      expect(providerCalls.appendProviderCall).toHaveBeenCalledWith({
        tenant_id: TENANT,
        run_id: 'run-a',
        step_index: 0,
        stage: 'HYPOTHESIS',
        call_index: 0,
        provider: 'openai-compatible',
        model: 'intent-model',
        observed_status: 'SUCCESS',
        latency_ms: 21,
        prompt_tokens: 12,
        completion_tokens: 8,
      });
      const ledgerInput = providerCalls.appendProviderCall.mock.calls[0]?.[0];
      expect(JSON.stringify(ledgerInput)).not.toContain('return policy');
      expect(ledgerInput).not.toHaveProperty('prompt');
      expect(ledgerInput).not.toHaveProperty('completion');
    } finally {
      await app.close();
    }
  });

  it('keeps an admitted turn accepted when telemetry storage is unavailable and reports UNAVAILABLE', async () => {
    const intentProposer: TurnIntentPort = {
      propose: vi.fn(async () => ({
        intent: 'faq_search' as const,
        requirements: {},
        confidence: 0.8,
        metadata: {
          provider: 'openai-compatible',
          model: 'intent-model',
          latency_ms: 11,
        },
      })),
    };
    const { app, providerCalls, audit } = buildHarness({ intentProposer });
    providerCalls.appendProviderCall.mockRejectedValue(new Error('ledger connection secret must not escape'));
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION_ID}/messages`,
        headers: { authorization: `Bearer ${SESSION_TOKEN}` },
        payload: { message: 'Can you help?', idempotency_key: 'turn-provider-2', module: 'support' },
      });

      expect(response.statusCode).toBe(202);
      expect(JSON.stringify(response.json())).not.toContain('secret');
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'conversations.messages.provider_ledger',
        outcome: 'ACCEPTED',
        detail: { provider_ledger: 'UNAVAILABLE' },
      }));
    } finally {
      await app.close();
    }
  });
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

  it('persists a customer message during human takeover with HTTP 202 HUMAN_OWNED and no run', async () => {
    const { app, appendMessage, conversation, start } = buildHarness({
      takeoverHolder: { operator_id: 'operator-a', expires_at: '2026-09-23T00:01:00.000Z' },
    });
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = { message: 'Where is my order?', idempotency_key: 'turn-paused', module: 'support' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });
      const replay = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        conversation_id: CONVERSATION_ID,
        status: 'HUMAN_OWNED',
      });
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(response.json());
      expect(appendMessage).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: CONVERSATION_ID,
        content: body.message,
        request_id: body.idempotency_key,
      }));
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('treats an expired takeover lease as released for the next customer turn', async () => {
    const { app, appendMessage, conversation, start } = buildHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';

    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: { message: 'Where is my order?', idempotency_key: 'turn-expired', module: 'support' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ conversation_id: CONVERSATION_ID, status: 'accepted' });
    expect(conversation.state).toBe('paused_takeover');
    expect(conversation.takeover_operator_id).toBe('operator-a');
    expect(start).toHaveBeenCalledOnce();
    expect(appendMessage).toHaveBeenCalledOnce();
    await app.close();
  });

  it('claims the idempotency slot before intent classification, so a concurrent duplicate calls the LLM once', async () => {
    let releaseProposal: () => void = () => {};
    const proposalFinished = new Promise<void>((resolve) => {
      releaseProposal = resolve;
    });
    const intentProposer: TurnIntentPort = {
      propose: vi.fn(async () => {
        await proposalFinished;
        return { intent: 'faq_search' as const, requirements: {}, confidence: 0.9 };
      }),
    };
    const { app, reserve, start } = buildHarness({ intentProposer });
    reserve
      .mockImplementationOnce(async () => ({ kind: 'RESERVED' as const }))
      .mockImplementationOnce(async () => ({ kind: 'IN_FLIGHT' as const }));
    const request = {
      method: 'POST' as const,
      url: `/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: { message: 'Where is my order?', idempotency_key: 'turn-concurrent', module: 'support' },
    };

    try {
      const first = app.inject(request);
      await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1));
      const second = app.inject(request);
      await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(2));
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(intentProposer.propose).toHaveBeenCalledOnce();
      releaseProposal();
      const responses = await Promise.all([first, second]);
      expect(responses[0]?.statusCode).toBe(202);
      expect(responses[1]?.statusCode).toBe(202);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      releaseProposal();
      await app.close();
    }
  });

  it('returns RATE_LIMITED before intent classification when the tenant session bucket is empty', async () => {
    const intentProposer: TurnIntentPort = {
      propose: vi.fn(async () => ({ intent: 'faq_search' as const, requirements: {}, confidence: 0.9 })),
    };
    const turnRateLimiter: TurnRateLimiter = { consume: vi.fn(() => false) };
    const { app, start } = buildHarness({ intentProposer, turnRateLimiter });

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION_ID}/messages`,
        headers: { authorization: `Bearer ${SESSION_TOKEN}` },
        payload: { message: 'Please help', idempotency_key: 'turn-rate-limited', module: 'support' },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error_code: 'RATE_LIMITED' });
      expect(intentProposer.propose).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
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

  it('refuses a turn whose body claims the internal handoff channel, and derives the real one', async () => {
    // The internal channel is server-derived, so a caller cannot make an ordinary conversation turn
    // look like an orchestrator-brokered leg by naming ORCHESTRATOR_HANDOFF in the request body.
    const { app, appendMessage, start, conversation } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };
    const body = {
      message: 'hello',
      idempotency_key: 'turn-forged-channel',
      source_channel: 'ORCHESTRATOR_HANDOFF',
      event_type: 'handoff.marketing_to_sales',
    };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      // The route's schema admits only the turn's own fields, so the forged pair never reaches the
      // admission path at all: the delivery is refused and no run is started.
      expect(response.statusCode).toBe(400);
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();

      // The same conversation DOES admit an ordinary turn, and the run carries the conversation's
      // own channel rather than anything the caller supplied.
      const accepted = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { message: 'hello', idempotency_key: 'turn-plain-channel' },
      });

      expect(accepted.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]?.source_channel).toBe(conversation.channel);
    } finally {
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
      });
      expect(start).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) process.env.ENABLED_AGENT_MODULES = originalEnv;
      else delete process.env.ENABLED_AGENT_MODULES;
      await app.close();
    }
  });

  it('admits module: marketing when enabled and uses the canonical campaign event type', async () => {
    const originalEnv = process.env.ENABLED_AGENT_MODULES;
    process.env.ENABLED_AGENT_MODULES = 'support,marketing';

    const { app, appendMessage, start } = buildHarness();
    const url = '/conversations/' + CONVERSATION_ID + '/messages';
    const headers = { authorization: 'Bearer ' + SESSION_TOKEN };
    const body = { message: 'Prepare a campaign draft', idempotency_key: 'turn-mkt-allowed', module: 'marketing' };

    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: body });

      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        request_id: 'turn-mkt-allowed',
        event_type: 'campaign.requested',
        payload: { conversation_id: CONVERSATION_ID, message: 'Prepare a campaign draft', module: 'marketing' },
      });
      expect(appendMessage).toHaveBeenCalledTimes(1);
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

  it('validates attachments: rejects non-array or non-string attachments with 400 VALIDATION_FAILED', async () => {
    const { app } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };

    // String instead of array
    const stringRes = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        message: 'Here is my receipt',
        idempotency_key: 'turn-attachments-invalid-1',
        attachments: 'https://example.com/receipt.pdf',
      },
    });
    expect(stringRes.statusCode).toBe(400);
    expect(stringRes.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });

    // Array containing non-string
    const numberRes = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        message: 'Here is my receipt',
        idempotency_key: 'turn-attachments-invalid-2',
        attachments: [123],
      },
    });
    expect(numberRes.statusCode).toBe(400);
    expect(numberRes.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });

    await app.close();
  });

  it('accepts valid string array attachments', async () => {
    const { app, start } = buildHarness();
    const url = `/conversations/${CONVERSATION_ID}/messages`;
    const headers = { authorization: `Bearer ${SESSION_TOKEN}` };

    const validRes = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        message: 'Here is my receipt',
        idempotency_key: 'turn-attachments-valid',
        attachments: ['https://example.com/receipt.pdf'],
      },
    });
    expect(validRes.statusCode).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].payload).toMatchObject({
      attachments: ['https://example.com/receipt.pdf'],
    });

    await app.close();
  });
});


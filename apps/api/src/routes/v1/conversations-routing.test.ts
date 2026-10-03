import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createCredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { replyFailure } from '../../gateway/http.js';
import { registerConversationRoutes } from './conversations.js';
import { registerStorefrontRoutes } from './storefront.js';

const SESSION_SECRET = 'routing-session-secret-000000';
const TENANT = 'tenant-a';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';

function signedSessionToken(input: {
  readonly conversation_id: string;
  readonly session_id: string;
  readonly exp: number;
}): string {
  const binding = JSON.stringify({
    tenant_id: TENANT,
    conversation_id: input.conversation_id,
    session_id: input.session_id,
    exp: input.exp,
  });
  const payload = Buffer.from(binding, 'utf8').toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(binding, 'utf8').digest('base64url');
  return `${payload}.${signature}`;
}

type TaskReadFixture = {
  run_id: string;
  task_version: number;
  lifecycle_state: 'completed' | 'failed';
  correlation_id: string;
  conversation_id: string;
  session_id: string;
  answer?: string;
  sources?: readonly unknown[];
  error: { code: string; class: string | null } | null;
};

function harness() {
  const start = vi.fn(async (input: { correlation_id: string }) => ({
    run_id: 'run-a', task_version: 1, lifecycle_state: 'queued', correlation_id: input.correlation_id,
  }));
  const read = vi.fn(async (): Promise<TaskReadFixture> => ({
    run_id: 'run-a', task_version: 2, lifecycle_state: 'completed', correlation_id: 'corr-a',
    conversation_id: CONVERSATION, session_id: 'thread-a', answer: 'Approved answer', sources: [],
    error: null,
  }));
  const runtime = {
    runs: { start, read },
    identity: { resolveCustomer: vi.fn(async () => ({ customer_id: null })) },
    conversations: {
      get: vi.fn(async () => ({
        conversation_id: CONVERSATION, tenant_id: TENANT, customer_id: null, channel: 'WEB_CHAT',
        external_thread_id: 'thread-a', state: 'open',
      })),
      bindOrCreate: vi.fn(async () => ({
        conversation_id: CONVERSATION, tenant_id: TENANT, customer_id: null, channel: 'WEB_CHAT',
        external_thread_id: 'thread-a', state: 'open', bound: false,
      })),
      issueSessionToken: vi.fn(async () => 'issued-session-token'),
      appendMessage: vi.fn(async () => undefined),
    },
    takeover: { holder: vi.fn(async () => null) },
    receipts: { receiptFor: vi.fn(async () => null), storeReceipt: vi.fn(async () => undefined) },
    effects: {
      computeEffectKey: (input: { request_id: string }) => input.request_id,
      computeRequestFingerprint: (input: unknown) => JSON.stringify(input),
    },
    audit: { record: vi.fn(async () => undefined) },
    clock: () => new Date('2026-09-28T00:00:00.000Z'),
    ids: () => 'corr-a',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => replyFailure(reply, error, 'routing-test'));
  const credentials = createCredentialStore({
      sessions: [
        { token: 'owner', tenant_id: TENANT, conversation_id: CONVERSATION, session_id: 'thread-a', channel: 'WEB_CHAT' },
        { token: 'other', tenant_id: TENANT, conversation_id: '22222222-2222-4222-8222-222222222222', session_id: 'thread-b', channel: 'WEB_CHAT' },
      ],
      widgets: [
        { token: 'widget', tenant_id: TENANT, session_id: 'thread-a', origin: 'https://demo.example.test' },
        { token: 'widget-other', tenant_id: TENANT, session_id: 'thread-b', origin: 'https://demo.example.test' },
      ],
      operators: [
        { token: 'reader', tenant_id: TENANT, operator_id: 'op-reader', permissions: ['run:read'] },
        { token: 'non-reader', tenant_id: TENANT, operator_id: 'op-no-read', permissions: [] },
      ],
      session_secret: SESSION_SECRET,
  });
  registerConversationRoutes(app, { runtime, credentials, enabledModules: ['support', 'sales'] });
  registerStorefrontRoutes(app, { runtime, credentials, enabledModules: ['support', 'sales'] });
  return { app, start, read };
}

describe('conversation turn routing and task ownership', () => {
  it('maps a non-UUID conversation path parameter to VALIDATION_FAILED', async () => {
    const { app } = harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/conversations/not-a-uuid/messages',
        headers: { authorization: 'Bearer owner' },
        payload: { message: 'Where is my order?', module: 'support', idempotency_key: 'bad-id' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });
    } finally {
      await app.close();
    }
  });

  it('routes auto product advice to Sales but an order complaint to Care', async () => {
    const { app, start } = harness();
    try {
      for (const [message, module, key] of [
        ['Recommend a product in stock under my budget', 'sales', 'product'],
        ['I need a refund for a damaged product', 'support', 'complaint'],
      ]) {
        const response = await app.inject({
          method: 'POST', url: `/conversations/${CONVERSATION}/messages`,
          headers: { authorization: 'Bearer owner' },
          payload: { message, module: 'auto', idempotency_key: key },
        });
        expect(response.statusCode).toBe(202);
        expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { module, message } });
      }
    } finally { await app.close(); }
  });

  it('admits an omitted-module storefront product turn as Sales with its session-bound receipt', async () => {
    const { app, start } = harness();
    try {
      const response = await app.inject({
        method: 'POST', url: '/storefront/stream',
        headers: { authorization: 'Bearer widget', origin: 'https://demo.example.test' },
        payload: { message: 'Recommend a product in stock', idempotency_key: 'widget-product' },
      });
      expect(response.statusCode).toBe(200);
      expect(start.mock.calls[0]?.[0]).toMatchObject({
        session_id: 'thread-a', payload: { module: 'sales' },
      });
      expect(response.body).toContain('\"task_id\":\"run-a\"');
    } finally { await app.close(); }
  });

  it('refuses operator customer turns and widget/session turns addressed to another session thread', async () => {
    const { app, start } = harness();
    try {
      const operator = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION}/messages`,
        headers: { authorization: 'Bearer reader' },
        payload: { message: 'post as customer', module: 'support', idempotency_key: 'operator-turn' },
      });
      const widget = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION}/messages`,
        headers: { authorization: 'Bearer widget-other', origin: 'https://demo.example.test' },
        payload: { message: 'wrong thread', module: 'support', idempotency_key: 'widget-turn' },
      });
      const session = await app.inject({
        method: 'POST',
        url: `/conversations/${CONVERSATION}/messages`,
        headers: { authorization: 'Bearer other' },
        payload: { message: 'wrong session thread', module: 'support', idempotency_key: 'session-turn' },
      });

      expect(operator.statusCode).toBe(403);
      expect(operator.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(widget.statusCode).toBe(403);
      expect(widget.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(session.statusCode).toBe(403);
      expect(session.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('accepts valid conversation session tokens and rejects tampered, expired, and wrong-conversation bindings', async () => {
    const { app, start } = harness();
    const now = Math.floor(Date.now() / 1000);
    const valid = signedSessionToken({
      conversation_id: CONVERSATION,
      session_id: 'thread-a',
      exp: now + 60,
    });
    const validParts = valid.split('.');
    const signatureMiddle = Math.floor((validParts[1]?.length ?? 0) / 2);
    const tamperedCharacter = validParts[1]?.charAt(signatureMiddle) === 'A' ? 'B' : 'A';
    const tampered = `${validParts[0]}.${validParts[1]?.slice(0, signatureMiddle)}${tamperedCharacter}${validParts[1]?.slice(signatureMiddle + 1)}`;
    const expired = signedSessionToken({
      conversation_id: CONVERSATION,
      session_id: 'thread-a',
      exp: now - 1,
    });
    const wrongConversation = signedSessionToken({
      conversation_id: '22222222-2222-4222-8222-222222222222',
      session_id: 'thread-a',
      exp: now + 60,
    });

    try {
      for (const [token, expectedStatus] of [
        [valid, 202],
        [tampered, 401],
        [expired, 401],
        [wrongConversation, 403],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/conversations/${CONVERSATION}/messages`,
          headers: { authorization: `Bearer ${token}` },
          payload: { message: 'hello', module: 'support', idempotency_key: `token-${token.slice(-8)}` },
        });
        expect(response.statusCode).toBe(expectedStatus);
      }
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('requires takeover authority for R01 operators, owns session threads, and validates channels', async () => {
    const { app } = harness();
    try {
      const invalidChannel = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: 'Bearer reader' },
        payload: { channel: 'UNKNOWN_CHANNEL', customer_identifier: 'thread-a' },
      });
      const operator = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: 'Bearer reader' },
        payload: { channel: 'WEB_CHAT', customer_identifier: 'thread-a' },
      });
      const otherThread = await app.inject({
        method: 'POST',
        url: '/conversations',
        headers: { authorization: 'Bearer owner' },
        payload: { channel: 'WEB_CHAT', customer_identifier: 'thread-b' },
      });

      expect(invalidChannel.statusCode).toBe(400);
      expect(invalidChannel.json().error_code).toBe('VALIDATION_FAILED');
      expect(operator.statusCode).toBe(403);
      expect(operator.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(otherThread.statusCode).toBe(403);
      expect(otherThread.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
    } finally {
      await app.close();
    }
  });

  it('returns a completed answer only to its owner session, bound widget, or permitted operator', async () => {
    const { app, read } = harness();
    try {
      for (const [token, origin] of [['owner', ''], ['widget', 'https://demo.example.test'], ['reader', '']]) {
        const response = await app.inject({
          method: 'GET', url: '/tasks/run-a',
          headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().answer).toBe('Approved answer');
        expect(response.json().error).toBeNull();
      }
      for (const [token, expected] of [['other', 404], ['non-reader', 403], ['unknown', 401]]) {
        const response = await app.inject({ method: 'GET', url: '/tasks/run-a', headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(expected);
        expect(response.json().answer).toBeUndefined();
      }
      expect(read).toHaveBeenCalledTimes(4);
    } finally { await app.close(); }
  });
  it('returns only a sanitized code and class for a failed task', async () => {
    const { app, read } = harness();
    read.mockImplementationOnce(async () => ({
      run_id: 'run-a',
      task_version: 3,
      lifecycle_state: 'failed',
      correlation_id: 'corr-failed',
      conversation_id: CONVERSATION,
      session_id: 'thread-a',
      error: { code: 'R1', class: 'FATAL' },
    }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/tasks/run-a',
        headers: { authorization: 'Bearer owner' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'failed',
        error: { code: 'R1', class: 'FATAL' },
      });
      expect(response.json()).not.toHaveProperty('error_details');
      expect(response.json().error).not.toHaveProperty('message');
      expect(Object.keys(response.json().error).sort()).toEqual(['class', 'code']);
    } finally { await app.close(); }
  });
});

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from '../../gateway/principal.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { registerOperatorConversationRoutes } from './operator-conversations.js';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-28T00:00:00.000Z');

function conversation(tenant_id = TENANT, state: 'open' | 'paused_takeover' | 'closed' = 'paused_takeover') {
  return {
    conversation_id: CONVERSATION_ID,
    tenant_id,
    customer_id: 'customer-a',
    channel: 'WEB_CHAT' as const,
    external_thread_id: 'thread-a',
    active_agent: 'support',
    state,
    takeover_operator_id: state === 'paused_takeover' ? 'operator-a' : null,
    last_message_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    bound: true,
  };
}

function buildHarness(options: {
  readonly tenant_id?: string;
  readonly permissions?: readonly ('conversation:takeover' | 'customer:read')[];
  readonly holder?: { readonly operator_id: string; readonly expires_at: string } | null;
  readonly state?: 'open' | 'paused_takeover' | 'closed';
} = {}) {
  const row = conversation(options.tenant_id ?? TENANT, options.state ?? 'paused_takeover');
  const messages = [
    {
      message_id: 'message-customer-1',
      sender_type: 'customer' as const,
      sender_id: 'customer-a',
      content: 'Hello',
      created_at: NOW.toISOString(),
    },
  ];
  const appendMessage = vi.fn(async (_input: unknown) => 'message-operator-1');
  const audit = vi.fn(async (_input: unknown) => undefined);
  const runtime = {
    conversations: {
      get: vi.fn(async (tenant_id: string) => (tenant_id === row.tenant_id ? row : null)),
      list: vi.fn(async (tenant_id: string) => (tenant_id === row.tenant_id ? [row] : [])),
      listMessages: vi.fn(async (input: { tenant_id: string }) =>
        input.tenant_id === row.tenant_id ? messages : [],
      ),
      appendMessage,
    },
    takeover: {
      holder: vi.fn(async () => options.holder === undefined
        ? { operator_id: 'operator-a', expires_at: '2026-09-28T00:01:00.000Z' }
        : options.holder),
    },
    audit: { record: audit },
    clock: () => NOW,
    ids: () => 'correlation-1',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  });
  registerOperatorConversationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{
        token: 'operator-token',
        tenant_id: TENANT,
        operator_id: 'operator-a',
        permissions: options.permissions ?? ['conversation:takeover'],
      }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, appendMessage, audit, list: runtime.conversations.list, listMessages: runtime.conversations.listMessages };
}

describe('operator conversation routes', () => {
  it('rejects unauthenticated conversation reads', async () => {
    const { app } = buildHarness({ permissions: ['customer:read'] });
    const response = await app.inject({ method: 'GET', url: '/conversations' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error_code).toBe('AUTHENTICATION_FAILED');
  });
  it('lists tenant conversations for an operator with customer:read', async () => {
    const { app, list, audit } = buildHarness({ permissions: ['customer:read'] });
    const response = await app.inject({
      method: 'GET',
      url: '/conversations?limit=10',
      headers: { authorization: 'Bearer operator-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      next_cursor: null,
      items: [{ conversation_id: CONVERSATION_ID, tenant_id: TENANT }],
    });
    expect(list).toHaveBeenCalledWith(TENANT, 10);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'conversations.list',
      tenant_id: TENANT,
      outcome: 'ACCEPTED',
    }));
  });


  it('lists only the authenticated tenant and permits customer:read without takeover authority', async () => {
    const { app, list } = buildHarness({ permissions: ['customer:read'] });
    const response = await app.inject({
      method: 'GET',
      url: `/conversations?tenant_id=${OTHER_TENANT}&limit=10`,
      headers: { authorization: 'Bearer operator-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('TENANT_BINDING_MISMATCH');
    expect(list).not.toHaveBeenCalled();
  });
  it('does not reveal another tenant conversation through the message endpoint', async () => {
    const { app, listMessages } = buildHarness({
      tenant_id: OTHER_TENANT,
      permissions: ['customer:read'],
    });
    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION_ID}/messages`,
      headers: { authorization: 'Bearer operator-token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error_code).toBe('CONVERSATION_NOT_FOUND');
    expect(listMessages).not.toHaveBeenCalled();
  });


  it('returns tenant-scoped message history to a customer reader', async () => {
    const { app, listMessages } = buildHarness({ permissions: ['customer:read'] });
    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION_ID}/messages?limit=20`,
      headers: { authorization: 'Bearer operator-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversation_id: CONVERSATION_ID,
      next_cursor: null,
      items: [{ message_id: 'message-customer-1', sender_type: 'customer' }],
    });
    expect(listMessages).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      limit: 20,
    });
  });

  it('refuses a human reply when another operator owns the live lease', async () => {
    const { app, appendMessage } = buildHarness({
      holder: { operator_id: 'operator-b', expires_at: '2026-09-28T00:01:00.000Z' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response', operator_id: 'operator-b' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('TAKEOVER_LEASE_HELD');
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('refuses a human reply when the takeover lease is expired', async () => {
    const { app, appendMessage } = buildHarness({ holder: null });
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('TAKEOVER_LEASE_EXPIRED');
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('appends one operator message with server-derived identity, audits, and never starts an agent reply', async () => {
    const { app, appendMessage, audit } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response', operator_id: 'spoofed-operator' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      conversation_id: CONVERSATION_ID,
      message_id: 'message-operator-1',
      status: 'persisted',
    });
    expect(appendMessage).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      sender_type: 'operator',
      sender_id: 'operator-a',
      content: 'Human response',
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'conversations.operator_message',
      operator_id: 'operator-a',
      outcome: 'ACCEPTED',
      detail: expect.objectContaining({ message_id: 'message-operator-1', status: 'persisted' }),
    }));
  });

  it('derives the replay key from the body and maps a reused key to IDEMPOTENCY_CONFLICT', async () => {
    const { app, appendMessage } = buildHarness();

    const first = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response', idempotency_key: 'reply-key-1' },
    });
    expect(first.statusCode).toBe(201);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      request_id: 'operator-reply:reply-key-1',
      content: 'Human response',
    }));

    appendMessage.mockRejectedValueOnce(new Error('IDEMPOTENCY_CONFLICT: different content'));
    const conflict = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Different text', idempotency_key: 'reply-key-1' },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error_code).toBe('IDEMPOTENCY_CONFLICT');

    const invalid = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response', idempotency_key: '' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('requires the conversation to be paused under the authenticated operator before replying', async () => {
    const { app, appendMessage } = buildHarness({ state: 'open' });
    const response = await app.inject({
      method: 'POST',
      url: `/conversations/${CONVERSATION_ID}/operator-messages`,
      headers: { authorization: 'Bearer operator-token' },
      payload: { message: 'Human response' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('CONVERSATION_LOCKED');
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

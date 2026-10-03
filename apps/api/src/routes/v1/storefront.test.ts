import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerStorefrontRoutes } from './storefront.js';

const TENANT = 'tenant-a';
const TOKEN = 'widget-token';
const ORIGIN = 'https://shop.example.test';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

function buildHarness(options: {
  readonly conversation_session?: string;
  readonly identity?: { readonly resolveCustomer: (input: {
    readonly tenant_id: string;
    readonly session_id: string;
    readonly channel_type: string;
    readonly channel_identifier?: string;
  }) => Promise<{ readonly customer_id: string | null; readonly verdict: string }> };
} = {}) {
  const receipts = new Map<string, { event_id: string; event_name: string; occurred_at: string; payload_sha256: string }>();
  const append = vi.fn(async (input: {
    source_event_id: string;
    event_name: string;
    occurred_at: string;
    payload: Record<string, unknown>;
  }) => {
    if (receipts.has(input.source_event_id)) return { inserted: false };
    receipts.set(input.source_event_id, {
      event_id: input.source_event_id,
      event_name: input.event_name,
      occurred_at: input.occurred_at,
      payload_sha256: String(input.payload['payload_sha256']),
    });
    return { inserted: true };
  });
  const conversation = {
    conversation_id: CONVERSATION_ID,
    tenant_id: TENANT,
    channel: 'WEB_CHAT',
    external_thread_id: options.conversation_session ?? 'widget-session',
  };
  const getConversation = vi.fn(async (_tenant_id: string, conversation_id: string) =>
    conversation_id === CONVERSATION_ID ? conversation : null);
  const listWidgetMessages = vi.fn(async (_input: {
    readonly tenant_id: string;
    readonly conversation_id: string;
    readonly after?: string;
  }) => ({
    messages: [{
      message_id: MESSAGE_ID,
      sender_type: 'operator' as const,
      sender_id: 'operator-1',
      content: 'Hello from support',
      created_at: '2026-09-30T00:00:00.000Z',
      delivery_status: 'DELIVERED' as const,
    }],
    next_cursor: MESSAGE_ID,
  }));
  const auditRecord = vi.fn(async () => undefined);
  const start = vi.fn();
  const runtime = {
    ids: () => 'corr-storefront-test',
    runs: { start },
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    events: {
      append,
      receipt: vi.fn(async (_tenant_id: string, event_id: string) => receipts.get(event_id) ?? null),
    },
    conversations: { get: getConversation, listWidgetMessages },
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerStorefrontRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [],
      sessions: [],
      widgets: [{
        token: TOKEN,
        tenant_id: TENANT,
        session_id: 'widget-session',
        origin: ORIGIN,
      }],
    }),
  });
  return { app, append, auditRecord, getConversation, listWidgetMessages, start };
}

const event = (payload: Record<string, unknown>) => ({
  event_id: 'storefront-event-1',
  event_type: 'customer.updated',
  occurred_at: '2026-09-30T00:00:00.000Z',
  payload,
});

describe('POST /storefront/events idempotency', () => {
  it('canonicalizes payload keys and refuses a changed event body under the same id', async () => {
    const { app, append } = buildHarness();
    try {
      const headers = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };
      const first = await app.inject({
        method: 'POST',
        url: '/storefront/events',
        headers,
        payload: event({ first: 1, nested: { z: 2, a: 3 } }),
      });
      const reordered = await app.inject({
        method: 'POST',
        url: '/storefront/events',
        headers,
        payload: event({ nested: { a: 3, z: 2 }, first: 1 }),
      });
      const changed = await app.inject({
        method: 'POST',
        url: '/storefront/events',
        headers,
        payload: event({ first: 9, nested: { a: 3, z: 2 } }),
      });

      expect(first.statusCode).toBe(202);
      expect(reordered.statusCode).toBe(202);
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
      expect(append).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe('POST /storefront/events customer binding', () => {
  it('binds the customer the widget session verifiably resolves to', async () => {
    const resolveCustomer = vi.fn(async () => ({ customer_id: 'customer-42', verdict: 'VERIFIED' }));
    const { app, append } = buildHarness({ identity: { resolveCustomer } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/storefront/events',
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
        payload: event({ first: 1 }),
      });

      expect(response.statusCode).toBe(202);
      expect(resolveCustomer).toHaveBeenCalledWith({
        tenant_id: TENANT,
        session_id: 'widget-session',
        channel_type: 'WEB_CHAT',
        channel_identifier: 'widget-session',
      });
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer-42' }));
    } finally {
      await app.close();
    }
  });

  it('stores an unresolved session as an anonymous event instead of guessing a customer', async () => {
    const resolveCustomer = vi.fn(async () => ({ customer_id: null, verdict: 'UNVERIFIED' }));
    const { app, append } = buildHarness({ identity: { resolveCustomer } });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/storefront/events',
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
        payload: event({ first: 1 }),
      });

      expect(response.statusCode).toBe(202);
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ customer_id: null }));
    } finally {
      await app.close();
    }
  });
});
describe('POST /storefront/stream request validation', () => {
  it('refuses an unsupported module as a typed Vietnamese 400 before starting a run', async () => {
    const { app, auditRecord, start } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/storefront/stream',
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
        payload: {
          message: 'Hi',
          idempotency_key: 'bad-module',
          module: 'unknown-module',
        },
      });
      const body = response.json();

      expect(response.statusCode).toBe(400);
      expect(body).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        message: 'Mô-đun không hợp lệ; hãy chọn marketing, sales, support hoặc auto.',
      });
      expect(start).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'REFUSED',
        error_code: 'VALIDATION_FAILED',
      }));
    } finally {
      await app.close();
    }
  });
});


describe('GET /storefront/conversations/:id/messages widget scope', () => {
  it('returns the conversation transcript and acknowledges operator messages for the bound widget', async () => {
    const { app, listWidgetMessages } = buildHarness();
    try {
      const after = '33333333-3333-4333-8333-333333333333';
      const response = await app.inject({
        method: 'GET',
        url: `/storefront/conversations/${CONVERSATION_ID}/messages?after=${after}`,
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        messages: [{
          message_id: MESSAGE_ID,
          role: 'operator',
          text: 'Hello from support',
          created_at: '2026-09-30T00:00:00.000Z',
          delivery_status: 'DELIVERED',
        }],
        next_cursor: MESSAGE_ID,
      });
      expect(listWidgetMessages).toHaveBeenCalledWith({
        tenant_id: TENANT,
        conversation_id: CONVERSATION_ID,
        after,
      });
    } finally {
      await app.close();
    }
  });

  it('returns 404 when a widget session requests another session conversation', async () => {
    const { app, listWidgetMessages } = buildHarness({ conversation_session: 'someone-elses-session' });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/storefront/conversations/${CONVERSATION_ID}/messages`,
        headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error_code).toBe('CONVERSATION_NOT_FOUND');
      expect(listWidgetMessages).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

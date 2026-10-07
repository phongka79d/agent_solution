import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { installRawBodyPreservation } from '../../gateway/raw-body.js';
import { registerEventRoutes } from './events.js';

const TENANT = 'tenant-events';
const TOKEN = 'events-provider-token';

function buildHarness() {
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
  const auditRecord = vi.fn(async () => undefined);
  const runtime = {
    ids: () => 'corr-events-test',
    webhooks: { verify: vi.fn(async () => ({ ok: true as const })) },
    events: {
      append,
      receipt: vi.fn(async (_tenant_id: string, source_event_id: string) => receipts.get(source_event_id) ?? null),
    },
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  installRawBodyPreservation(app);
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerEventRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{
        token: TOKEN,
        tenant_id: TENANT,
        operator_id: 'events-provider',
        permissions: [],
      }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, append };
}

const envelope = (payload: Record<string, unknown>) => ({
  event_id: 'event-1',
  event_type: 'customer.updated',
  source: 'provider-a',
  occurred_at: '2026-09-30T00:00:00.000Z',
  payload,
});

describe('POST /events digest identity', () => {
  it('canonicalizes nested payload keys and refuses a changed body under the same id', async () => {
    const { app, append } = buildHarness();
    try {
      const headers = { 'content-type': 'application/json', 'x-tenant-id': TOKEN };
      const first = await app.inject({
        method: 'POST',
        url: '/events',
        headers,
        payload: JSON.stringify(envelope({ first: 1, nested: { z: 2, a: 3 } })),
      });
      const reordered = await app.inject({
        method: 'POST',
        url: '/events',
        headers,
        payload: JSON.stringify(envelope({ nested: { a: 3, z: 2 }, first: 1 })),
      });
      const changed = await app.inject({
        method: 'POST',
        url: '/events',
        headers,
        payload: JSON.stringify(envelope({ first: 9, nested: { a: 3, z: 2 } })),
      });

      expect(first.statusCode).toBe(202);
      expect(reordered.statusCode).toBe(202);
      expect(reordered.json()).toMatchObject({ status: 'IGNORED' });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
      expect(append).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MAX_RAW_BODY_BYTES } from './gateway/raw-body.js';
import { createCredentialStore } from './gateway/principal.js';
import { createGatewayComposition, UnboundPortError } from './runtime/composition.js';
import { buildServer, DEPENDENCIES } from './server.js';

/** One tenant's operator, so a route can be reached past authentication. */
const OPERATOR_TOKEN = 'operator-token-value';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

/**
 * Builds the deployed surface over an empty credential store, or over one known operator.
 *
 * @param with_operator Whether to trust {@link OPERATOR_TOKEN} for {@link TENANT}.
 * @returns A server that answers `/health`, `/api/v1` and the R10 socket handshake.
 */
function buildTestServer(with_operator: boolean, loggerStream?: NodeJS.WritableStream): FastifyInstance {
  return buildServer(
    createGatewayComposition(
      { SESSION_SECRET: 'test-session-secret-000000', PLATFORM_SECRET: 'test-platform-secret-00000' },
      {
        credentials: createCredentialStore({
          operators: with_operator
            ? [{ token: OPERATOR_TOKEN, tenant_id: TENANT, operator_id: 'op-1', permissions: [] }]
            : [],
          sessions: [],
          widgets: [],
        }),
      },
    ),
    loggerStream === undefined ? undefined : { loggerStream },
  );
}

describe('GET /health', () => {
  it('reports the api service as ok without touching a dependency', async () => {
    const app = buildTestServer(false);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'api',
      dependencies: [...DEPENDENCIES],
    });

    await app.close();
  });
});

describe('request logging and correlation', () => {
  it('redacts credentials and customer PII from serialized log records', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const app = buildTestServer(false, stream);

    const secret = 'request-secret-that-must-not-be-serialized';
    app.log.info({
      req: {
        headers: { authorization: `Bearer ${secret}`, cookie: secret, 'x-api-key': secret },
        body: { token: secret, password: secret, email: 'customer@example.test', phone: '+15555550123' },
      },
      config: { secret },
      provider: { api_key: secret },
      credentials: { password: secret },
      payload: { plaintext: secret },
    }, 'redaction-test');

    await new Promise<void>((resolve) => setImmediate(resolve));
    const serialized = lines.join('');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('customer@example.test');
    expect(serialized).not.toContain('+15555550123');
    await app.close();
  });

  it('echoes a valid correlation id and replaces an invalid one', async () => {
    const app = buildTestServer(false);
    const valid = 'corr-2026-09-30';
    const accepted = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': valid },
    });
    expect(accepted.headers['x-correlation-id']).toBe(valid);

    const invalid = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'not valid/with spaces' },
    });
    const replaced = invalid.headers['x-correlation-id'];
    expect(replaced).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(replaced).not.toBe('not valid/with spaces');

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-correlation-id': valid },
      payload: {},
    });
    expect(refused.headers['x-correlation-id']).toBe(valid);
    expect(refused.json()).toMatchObject({ correlation_id: valid });
    await app.close();
  });
});

describe('the /api/v1 surface', () => {
  it('mounts every group under the canonical prefix and authenticates before any handler', async () => {
    const app = buildTestServer(true);

    // An unauthenticated delivery to a canonical path reaches the credential check, not a handler:
    // the refusal is the gateway's own vocabulary and no port is consulted.
    const guarded = await app.inject({ method: 'POST', url: '/api/v1/events', payload: {} });
    expect(guarded.statusCode).toBe(401);
    expect(guarded.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED', retryable: false });

    // The same route is not served outside the prefix, so a caller cannot reach an unprefixed
    // variant of the contract.
    const unprefixed = await app.inject({ method: 'POST', url: '/events', payload: {} });
    expect(unprefixed.statusCode).toBe(404);

    // R04 verifies a signature over the bytes the caller sent, so the server installs the
    // preserving parser: an oversized delivery is refused by that boundary, in the gateway's own
    // vocabulary, and never reaches a handler that would sign over a body it never saw.
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filler: 'x'.repeat(MAX_RAW_BODY_BYTES + 1) }),
    });
    expect(oversized.statusCode, JSON.stringify(oversized.json())).toBe(400);
    expect(oversized.json()).toMatchObject({
      error_code: 'VALIDATION_FAILED',
      message: 'Không thể đọc yêu cầu được gửi đến.',
      details: { reason: 'RAW_BODY_TOO_LARGE' },
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'content-type': 'application/json' },
      payload: '{"event":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error_code: 'VALIDATION_FAILED',
      message: 'Không thể đọc yêu cầu được gửi đến.',
      details: { reason: 'MALFORMED_REQUEST' },
    });

    await app.close();
  });
});

describe('Customer Care turn admission', () => {
  it('does not admit or append a message when the execution path is unbound', async () => {
    const composition = createGatewayComposition(
      { SESSION_SECRET: 'test-session-secret-000000', PLATFORM_SECRET: 'test-platform-secret-00000' },
    );
    const appendMessage = vi.fn();
    const start = vi.fn(async (_input: Parameters<typeof composition.runtime.runs.start>[0]) => {
      throw new UnboundPortError('runs.start', 'no orchestrator graph is bound in this deployment');
    });
    const app = buildServer({
      ...composition,
      credentials: createCredentialStore({
        operators: [],
        sessions: [{ token: 'care-session', tenant_id: TENANT, conversation_id: CONVERSATION, session_id: 'session-a', channel: 'WEB_CHAT' }],
        widgets: [],
      }),
      intentProposer: { propose: async () => ({ intent: 'faq_search', requirements: {}, confidence: 0.9 }) },
      runtime: {
        ...composition.runtime,
        // The default composition binds `runs.start`; this deployment case has no bound execution
        // path, so the admission fails before the customer message can be persisted.
        runs: {
          ...composition.runtime.runs,
          start,
        },
        conversations: {
          ...composition.runtime.conversations,
          get: async () => ({
            conversation_id: CONVERSATION, tenant_id: TENANT, customer_id: null,
            channel: 'WEB_CHAT' as const, external_thread_id: 'session-a', active_agent: 'CS-01',
            state: 'open' as const, takeover_operator_id: null,
            last_message_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', bound: true,
          }),
          appendMessage,
        },
        receipts: { ...composition.runtime.receipts, receiptFor: async () => null },
        effects: {
          ...composition.runtime.effects,
          reserve: vi.fn(async () => ({ kind: 'RESERVED' as const })),
        } as typeof composition.runtime.effects,
      },
    });

    const response = await app.inject({
      method: 'POST', url: `/api/v1/conversations/${CONVERSATION}/messages`,
      headers: { authorization: 'Bearer care-session' },
      payload: { message: 'Where is my order?', module: 'support', idempotency_key: 'care-request-1' },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(503);
    expect(response.json()).toMatchObject({ error_code: 'CAPABILITY_UNAVAILABLE' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(appendMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it('admits the customer message atomically with the turn', async () => {
    const composition = createGatewayComposition(
      { SESSION_SECRET: 'test-session-secret-000000', PLATFORM_SECRET: 'test-platform-secret-00000' },
    );
    const appendMessage = vi.fn();
    const start = vi.fn(async (input: Parameters<typeof composition.runtime.runs.start>[0]) => ({
      run_id: 'run-admitted-1',
      task_version: 1,
      correlation_id: input.correlation_id,
      lifecycle_state: 'queued' as const,
    }));
    const app = buildServer({
      ...composition,
      credentials: createCredentialStore({
        operators: [],
        sessions: [{ token: 'care-session', tenant_id: TENANT, conversation_id: CONVERSATION, session_id: 'session-a', channel: 'WEB_CHAT' }],
        widgets: [],
      }),
      intentProposer: { propose: async () => ({ intent: 'faq_search', requirements: {}, confidence: 0.9 }) },
      runtime: {
        ...composition.runtime,
        runs: { ...composition.runtime.runs, start },
        conversations: {
          ...composition.runtime.conversations,
          get: async () => ({
            conversation_id: CONVERSATION, tenant_id: TENANT, customer_id: null,
            channel: 'WEB_CHAT' as const, external_thread_id: 'session-a', active_agent: 'CS-01',
            state: 'open' as const, takeover_operator_id: null,
            last_message_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z', bound: true,
          }),
          appendMessage,
        },
        receipts: { ...composition.runtime.receipts, receiptFor: async () => null, storeReceipt: vi.fn() },
        audit: { ...composition.runtime.audit, record: vi.fn() },
        effects: {
          ...composition.runtime.effects,
          reserve: vi.fn(async () => ({ kind: 'RESERVED' as const })),
        } as typeof composition.runtime.effects,
      },
    });

    const idempotencyKey = 'care-request-server-test';
    const response = await app.inject({
      method: 'POST', url: `/api/v1/conversations/${CONVERSATION}/messages`,
      headers: { authorization: 'Bearer care-session' },
      payload: { message: 'Where is my order?', idempotency_key: idempotencyKey },
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
    expect(response.json()).toMatchObject({ task_id: 'run-admitted-1', status: 'accepted' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      admission_reservation: {
        customer_message: {
          conversation_id: CONVERSATION,
          sender_id: 'session-a',
          content: 'Where is my order?',
          request_id: idempotencyKey,
        },
      },
    });
    expect(appendMessage).not.toHaveBeenCalled();
    await app.close();
  });
});

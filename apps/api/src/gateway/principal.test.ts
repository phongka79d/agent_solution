/**
 * @file Behavioral contract of gateway authentication and tenant binding (implement/06 §8.0 "Tenant
 * binding", §9.1; NFR-006).
 *
 * Every case goes through a real Fastify request, so what is proven is the transport outcome a
 * caller sees — the status and the refusal code — rather than the return value of a helper. The
 * port bundle records every call it receives, which is what makes "a refused request mutates
 * nothing" an observation about the request instead of a claim about a handler.
 */

import { MemoryEffectGuard } from '@agentos/core-engine';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { correlationIdOf, replyFailure } from './http.js';
import {
  authenticate,
  createCredentialStore,
  requireOperator,
  requirePrincipal,
  type CredentialStore,
  type OperatorCredential,
  type SessionCredential,
  type WidgetCredential,
} from './principal.js';
import type {
  ApprovalPort,
  CareHandoffPort,
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
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/**
 * Test credentials. They are opaque strings the store matches exactly — nothing here is a token
 * format the gateway parses, and no value is a real credential.
 */
const OPERATOR_TOKEN = 'test-operator-token';
const VIEWER_TOKEN = 'test-viewer-token';
const SESSION_TOKEN = 'test-session-token';
const WIDGET_TOKEN = 'test-widget-token';

const OPERATOR: OperatorCredential = {
  token: OPERATOR_TOKEN,
  tenant_id: TENANT_A,
  operator_id: 'operator-1',
  permissions: ['approval:decide', 'run:read'],
};

/** An operator that holds `run:read` but not `approval:decide`; authority is never implied. */
const VIEWER: OperatorCredential = {
  token: VIEWER_TOKEN,
  tenant_id: TENANT_A,
  operator_id: 'operator-2',
  permissions: ['run:read'],
};

const SESSION: SessionCredential = {
  token: SESSION_TOKEN,
  tenant_id: TENANT_A,
  conversation_id: 'conversation-1',
  session_id: 'session-1',
  channel: 'WEB_CHAT',
};

const WIDGET: WidgetCredential = {
  token: WIDGET_TOKEN,
  tenant_id: TENANT_A,
  session_id: 'widget-session-1',
  origin: 'https://widget.example.test',
};

function testCredentials(): CredentialStore {
  return createCredentialStore({ operators: [OPERATOR, VIEWER], sessions: [SESSION], widgets: [WIDGET] });
}

/** The bearer presentation of a token; the scheme is the only structure the gateway reads. */
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** The port bundle and every call it received. */
interface TestRuntime {
  readonly runtime: GatewayRuntime;
  readonly calls: string[];
}

/**
 * A `GatewayRuntime` for the authentication cases. Its ports do not model the platform: they record
 * the call and return nothing, because the only thing these cases have to observe about a port is
 * whether a refused request reached one at all.
 */
function createTestRuntime(): TestRuntime {
  const calls: string[] = [];

  const recordingPort = <T extends object>(name: string): T =>
    new Proxy({} as T, {
      get: (_target, property): unknown => {
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (): Promise<void> => {
          calls.push(`${name}.${property}`);
          return Promise.resolve();
        };
      },
    });

  return {
    runtime: {
      conversations: recordingPort<ConversationPort>('conversations'),
      handoffs: recordingPort<CareHandoffPort>('handoffs'),
      takeover: recordingPort<TakeoverLeasePort>('takeover'),
      runs: recordingPort<RunPort>('runs'),
      approvals: recordingPort<ApprovalPort>('approvals'),
      events: recordingPort<EventPort>('events'),
      timeline: recordingPort<EventPort>('timeline'),
      streams: recordingPort<StreamPort>('streams'),
      kpi: recordingPort<KpiPort>('kpi'),
      identity: recordingPort<IdentityPort>('identity'),
      webhooks: recordingPort<WebhookVerificationPort>('webhooks'),
      audit: recordingPort<GatewayAuditPort>('audit'),
      receipts: recordingPort<ReceiptPort>('receipts'),
      effects: new MemoryEffectGuard(),
      clock: (): Date => new Date('2026-09-22T00:00:00.000Z'),
      ids: (): string => 'generated-correlation-id',
    },
    calls,
  };
}

/**
 * The probe surface the cases inject against: one route per authentication outcome, all of them
 * registered with the hook under test except the deliberately unprotected one.
 */
function createApp(credentials: CredentialStore, tested: TestRuntime): FastifyInstance {
  const app = Fastify();
  const hook = authenticate({ credentials, runtime: tested.runtime });

  app.setErrorHandler((error, request, reply): void => {
    replyFailure(reply, error, correlationIdOf(request, tested.runtime));
  });

  app.post('/api/v1/probe', { preHandler: hook }, async (request) => {
    const principal = requirePrincipal(request);
    return { kind: principal.kind, tenant_id: principal.tenant_id };
  });

  app.post('/api/v1/mutate', { preHandler: hook }, async (request) => {
    const principal = requirePrincipal(request);
    await tested.runtime.conversations.appendMessage({
      tenant_id: principal.tenant_id,
      conversation_id: principal.conversation_id ?? 'conversation-1',
      sender_type: 'customer',
      sender_id: 'customer-1',
      content: 'hello',
    });
    return { accepted: true };
  });

  app.post('/api/v1/decide', { preHandler: hook }, async (request) => ({
    operator_id: requireOperator(request, 'approval:decide').operator_id,
  }));

  app.post('/api/v1/unauthenticated', async (request) => ({
    tenant_id: requirePrincipal(request).tenant_id,
  }));

  return app;
}

describe('createCredentialStore', () => {
  it('resolves a token by exact match and by nothing else', () => {
    const credentials = createCredentialStore({ operators: [OPERATOR], sessions: [], widgets: [] });

    expect(credentials.resolveOperator(OPERATOR_TOKEN)).toBe(OPERATOR);
    // No trimming, no case folding, no prefix or suffix decoding: a token is a key, not a format.
    expect(credentials.resolveOperator(`${OPERATOR_TOKEN} `)).toBeNull();
    expect(credentials.resolveOperator(OPERATOR_TOKEN.toUpperCase())).toBeNull();
    expect(credentials.resolveOperator('')).toBeNull();
  });
});

describe('authenticate', () => {
  it('refuses a token no credential resolves', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: bearer('test-token-nobody-holds'),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED', retryable: false });
    await app.close();
  });

  it('refuses a request that presents no credential at all', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({ method: 'POST', url: '/api/v1/probe' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED' });
    await app.close();
  });

  it('refuses a body tenant_id that is not the authenticated tenant and echoes neither value', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: bearer(OPERATOR_TOKEN),
      payload: { tenant_id: TENANT_B },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'TENANT_BINDING_MISMATCH' });
    expect(response.body).not.toContain(TENANT_B);
    expect(response.body).not.toContain(TENANT_A);
    await app.close();
  });

  it('refuses a query tenant_id that is not the authenticated tenant', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/probe?tenant_id=${TENANT_B}`,
      headers: bearer(OPERATOR_TOKEN),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'TENANT_BINDING_MISMATCH' });
    await app.close();
  });

  it('refuses an X-Tenant-ID routing hint that is not the authenticated tenant', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: { ...bearer(OPERATOR_TOKEN), 'x-tenant-id': TENANT_B },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'TENANT_BINDING_MISMATCH' });
    await app.close();
  });

  it('accepts a matching tenant assertion and binds the principal tenant', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: { ...bearer(OPERATOR_TOKEN), 'x-tenant-id': TENANT_A },
      payload: { tenant_id: TENANT_A },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'OPERATOR', tenant_id: TENANT_A });
    await app.close();
  });

  it('resolves a session credential presented as a provider delivery api key', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: { 'x-tenant-id': SESSION_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'CHANNEL_SESSION', tenant_id: TENANT_A });
    await app.close();
  });

  it('resolves a widget session credential and binds its tenant', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: bearer(WIDGET_TOKEN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'WIDGET_SESSION', tenant_id: TENANT_A });
    await app.close();
  });
});

describe('requirePrincipal', () => {
  it('refuses a protected route that ran without a principal', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({ method: 'POST', url: '/api/v1/unauthenticated' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED' });
    await app.close();
  });
});

describe('requireOperator', () => {
  it('refuses a session principal even when the body claims the permission', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/decide',
      headers: bearer(SESSION_TOKEN),
      payload: { permissions: ['approval:decide'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
    await app.close();
  });

  it('refuses an operator that does not hold the required permission', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/decide',
      headers: bearer(VIEWER_TOKEN),
      payload: { operator_id: 'operator-1', permissions: ['approval:decide'] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error_code: 'INSUFFICIENT_AUTHORITY',
      details: { missing_permissions: ['approval:decide'] },
    });
    await app.close();
  });

  it('returns the stored operator id, never one the payload supplied', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/decide',
      headers: bearer(OPERATOR_TOKEN),
      payload: { operator_id: 'operator-from-body' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operator_id: OPERATOR.operator_id });
    await app.close();
  });
});

describe('tenant binding at the mutation boundary', () => {
  it('refuses a cross-tenant assertion before any port is called', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/mutate',
      headers: bearer(OPERATOR_TOKEN),
      payload: { tenant_id: TENANT_B, content: 'hello' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'TENANT_BINDING_MISMATCH' });
    expect(tested.calls).toEqual([]);
    await app.close();
  });

  it('reaches the port once the assertion matches the principal', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/mutate',
      headers: bearer(OPERATOR_TOKEN),
      payload: { tenant_id: TENANT_A, content: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(tested.calls).toEqual(['conversations.appendMessage']);
    await app.close();
  });
});

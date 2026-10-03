/**
 * @file Behavioral contract of gateway authentication and tenant binding (implement/06 §8.0 "Tenant
 * binding", §9.1; NFR-006).
 *
 * Every case goes through a real Fastify request, so what is proven is the transport outcome a
 * caller sees — the status and the refusal code — rather than the return value of a helper. The
 * port bundle records every call it receives, which is what makes "a refused request mutates
 * nothing" an observation about the request instead of a claim about a handler.
 */

import { createHmac } from 'node:crypto';

import { MemoryEffectGuard } from '@agentos/core-engine';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { correlationIdOf, replyFailure } from './http.js';
import {
  authenticate,
  createCredentialStore,
  requireOperator,
  requirePrincipal,
  verifyConversationSessionToken,
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
  ReceiptPort,
  RunPort,
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

const SESSION_SIGNING_SECRET = 'test-session-secret-000000';
const SESSION_NOW = 1_800_000_000;

function signedSessionToken(overrides: Partial<{
  tenant_id: string;
  conversation_id: string;
  session_id: string;
  exp: number;
}> = {}): string {
  const binding = JSON.stringify({
    tenant_id: overrides.tenant_id ?? TENANT_A,
    conversation_id: overrides.conversation_id ?? 'conversation-1',
    session_id: overrides.session_id ?? 'session-1',
    exp: overrides.exp ?? SESSION_NOW + 60,
    channel: 'WEB_CHAT',
  });
  const encoded = Buffer.from(binding, 'utf8').toString('base64url');
  const signature = createHmac('sha256', SESSION_SIGNING_SECRET).update(binding, 'utf8').digest('base64url');
  return `${encoded}.${signature}`;
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
  it('keeps exact static session rows authoritative when signed verification is enabled', () => {
    const staticSession: SessionCredential = {
      token: 'static.session.token',
      tenant_id: TENANT_A,
      conversation_id: 'conversation-static',
      session_id: 'session-static',
      channel: 'WEB_CHAT',
    };
    const credentials = createCredentialStore({
      operators: [],
      sessions: [staticSession],
      widgets: [],
      session_secret: SESSION_SIGNING_SECRET,
    });

    expect(credentials.resolveConversationSession(staticSession.token)).toBe(staticSession);
  });
  it('never uses JWT_SECRET as a session-signing fallback', () => {
    const originalSessionSecret = process.env.SESSION_SECRET;
    const originalJwtSecret = process.env.JWT_SECRET;
    delete process.env.SESSION_SECRET;
    process.env.JWT_SECRET = SESSION_SIGNING_SECRET;
    try {
      const credentials = createCredentialStore({ operators: [], sessions: [], widgets: [] });
      expect(credentials.resolveConversationSession(signedSessionToken())).toBeNull();
    } finally {
      if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSessionSecret;
      if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalJwtSecret;
    }
  });
});

describe('verifyConversationSessionToken', () => {
  it('accepts a valid binding and rejects tampered or expired tokens', () => {
    const valid = signedSessionToken();
    const parts = valid.split('.');
    const signatureMiddle = Math.floor((parts[1]?.length ?? 0) / 2);
    const tamperedCharacter = parts[1]?.charAt(signatureMiddle) === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}.${parts[1]?.slice(0, signatureMiddle)}${tamperedCharacter}${parts[1]?.slice(signatureMiddle + 1)}`;

    expect(verifyConversationSessionToken(valid, SESSION_SIGNING_SECRET, SESSION_NOW)).toMatchObject({
      tenant_id: TENANT_A,
      conversation_id: 'conversation-1',
      session_id: 'session-1',
      channel: 'WEB_CHAT',
    });
    expect(verifyConversationSessionToken(tampered, SESSION_SIGNING_SECRET, SESSION_NOW)).toBeNull();
    expect(
      verifyConversationSessionToken(
        signedSessionToken({ exp: SESSION_NOW }),
        SESSION_SIGNING_SECRET,
        SESSION_NOW,
      ),
    ).toBeNull();
  });

  it('authenticates a signed session without a static row and refuses tampering or expiry', async () => {
    // Keep this case independent of any SESSION_SECRET left by another test or the test runner.
    const originalSessionSecret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      const credentials = createCredentialStore({
        operators: [],
        sessions: [],
        widgets: [],
        session_secret: SESSION_SIGNING_SECRET,
      });
      const valid = signedSessionToken({ exp: Math.floor(Date.now() / 1000) + 60 });
      const tamperedParts = valid.split('.');
      const signatureMiddle = Math.floor((tamperedParts[1]?.length ?? 0) / 2);
      const tamperedCharacter = tamperedParts[1]?.charAt(signatureMiddle) === 'A' ? 'B' : 'A';
      const tampered = `${tamperedParts[0]}.${tamperedParts[1]?.slice(0, signatureMiddle)}${tamperedCharacter}${tamperedParts[1]?.slice(signatureMiddle + 1)}`;
      const expired = signedSessionToken({ exp: Math.floor(Date.now() / 1000) - 1 });
      for (const [token, expectedStatus] of [[valid, 200], [tampered, 401], [expired, 401]] as const) {
        const app = createApp(credentials, createTestRuntime());
        try {
          const response = await app.inject({
            method: 'POST',
            url: '/api/v1/probe',
            headers: bearer(token),
          });
          expect(response.statusCode).toBe(expectedStatus);
        } finally {
          await app.close();
        }
      }
    } finally {
      if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSessionSecret;
    }
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

  it('does not accept an X-Tenant-ID assertion as a credential', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: { 'x-tenant-id': SESSION_TOKEN },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED' });
    await app.close();
  });

  it('resolves a session credential presented through Authorization', async () => {
    const tested = createTestRuntime();
    const app = createApp(testCredentials(), tested);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/probe',
      headers: bearer(SESSION_TOKEN),
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
      headers: { ...bearer(WIDGET_TOKEN), origin: WIDGET.origin },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'WIDGET_SESSION', tenant_id: TENANT_A });
    await app.close();
  });

  it('refuses widget credentials from absent or different origins', async () => {
    const app = createApp(testCredentials(), createTestRuntime());
    for (const origin of [undefined, 'https://other.example.test']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/probe',
        headers: { ...bearer(WIDGET_TOKEN), ...(origin === undefined ? {} : { origin }) },
      });
      expect(response.statusCode).toBe(401);
    }
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

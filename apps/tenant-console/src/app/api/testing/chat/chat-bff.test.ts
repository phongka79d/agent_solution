import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import {
  createSession,
  resetSessionsForTests,
  TENANT_CSRF_COOKIE,
  TENANT_CSRF_HEADER,
  TENANT_SESSION_COOKIE,
} from '../../../../lib/auth/session';
import { createChatSession, resetChatSessionsForTests } from '../../../../lib/testing/chat-sessions';

vi.mock('server-only', () => ({}));

import { POST as createChat } from './session/route';
import { POST as sendTurn } from './turn/route';
import { GET as getTask } from './task/route';

const ORIGIN = 'https://console.example.test';
const OPERATOR_TOKEN = 'operator-secret-for-test';
const WIDGET_TOKEN = 'private-widget-token-for-test';

type ConsoleIdentity = Awaited<ReturnType<typeof createConsoleIdentity>>;

async function createConsoleIdentity(permissions: AuthSession['permissions'] = ['conversation:takeover']) {
  const session: AuthSession = {
    identity: { user_id: 'operator-1', email: 'operator@example.test', display_name: 'Operator' },
    membership: {
      tenant_id: '99999999-9999-4999-8999-999999999999',
      tenant_name: null,
      role: 'company_admin',
      scope: 'company',
    },
    permissions,
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  };
  const created = await createSession({ accessToken: OPERATOR_TOKEN, session, csrfToken: 'test-csrf-token' });
  return {
    cookie: `${TENANT_SESSION_COOKIE}=${created.cookieValue}; ${TENANT_CSRF_COOKIE}=${created.session.csrfToken}`,
    sessionId: created.session.id,
  };
}

function requestHeaders(identity: ConsoleIdentity): Headers {
  return new Headers({
    cookie: identity.cookie,
    origin: ORIGIN,
    [TENANT_CSRF_HEADER]: 'test-csrf-token',
    authorization: 'Bearer browser-controlled-token',
  });
}

function upstreamAuthSession(permissions: AuthSession['permissions'] = ['conversation:takeover']): Response {
  const session: AuthSession = {
    identity: { user_id: 'operator-1', email: 'operator@example.test', display_name: 'Operator' },
    membership: {
      tenant_id: '99999999-9999-4999-8999-999999999999',
      tenant_name: null,
      role: 'company_admin',
      scope: 'company',
    },
    permissions,
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  };
  return new Response(JSON.stringify(session), { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  process.env.DEMO_MODE = 'true';
  process.env.APP_ENV = 'ci';
  process.env.TENANT_COOKIE_HMAC_KEY = 'tenant-cookie-key-that-is-at-least-32-bytes-long';
  process.env.API_BASE_URL = 'https://api.example.test';
  process.env.NEXTAUTH_URL = ORIGIN;
  resetSessionsForTests();
  resetChatSessionsForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith('/demo/session')) return upstreamAuthSession();
    if (url.pathname.endsWith('/demo/widget-session')) {
      return jsonResponse({
        access_token: WIDGET_TOKEN,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        session_id: 'demo-widget-session-1',
      }, 201);
    }
    if (url.pathname.endsWith('/storefront/stream')) {
      const turn = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(`${JSON.stringify({ task_id: 'task-1', conversation_id: 'conversation-1', session_id: turn.session_id })}\nanswer chunk\n`, { status: 200 });
    }
    if (url.pathname.endsWith('/tasks/task-1')) {
      return jsonResponse({
        task_id: 'task-1',
        status: 'completed',
        answer: `Answer containing ${WIDGET_TOKEN}`,
        sources: [{ source_record_id: 'record-1', source_version: '1', source_file: WIDGET_TOKEN }],
        error: null,
        access_token: WIDGET_TOKEN,
      });
    }
    return jsonResponse({ error_code: 'NOT_FOUND' }, 404);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('server-side testing chat routes', () => {
  it('keeps browser secrets private and binds widget Origin to the minted chat session', async () => {
    const identity = await createConsoleIdentity();
    const sessionResponse = await createChat(new Request(`${ORIGIN}/api/testing/chat/session`, {
      method: 'POST',
      headers: requestHeaders(identity),
      body: JSON.stringify({ persona: 'C05' }),
    }));
    expect(sessionResponse.status).toBe(201);
    const sessionBody = await sessionResponse.json() as { chat_session_id: string; expires_at: string };
    expect(sessionBody.chat_session_id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    process.env.NEXTAUTH_URL = 'https://rotated.example.test';
    expect(JSON.stringify(sessionBody)).not.toContain(WIDGET_TOKEN);

    const turnResponse = await sendTurn(new Request(`${ORIGIN}/api/testing/chat/turn`, {
      method: 'POST',
      headers: requestHeaders(identity),
      body: JSON.stringify({ chat_session_id: sessionBody.chat_session_id, message: 'Recommend a product' }),
    }));
    expect(turnResponse.status).toBe(200);
    const turnBody = await turnResponse.json() as { task_id: string; conversation_id: string };
    expect(turnBody).toEqual({ task_id: 'task-1', conversation_id: 'conversation-1' });
    expect(JSON.stringify(turnBody)).not.toContain(WIDGET_TOKEN);

    const taskRequestHeaders = requestHeaders(identity);
    taskRequestHeaders.set('origin', 'https://attacker.example.test');
    const taskResponse = await getTask(new Request(
      `${ORIGIN}/api/testing/chat/task?chat_session_id=${encodeURIComponent(sessionBody.chat_session_id)}&task_id=task-1`,
      { headers: taskRequestHeaders },
    ));
    expect(taskResponse.status).toBe(200);
    const taskBody = await taskResponse.json() as { answer: string; sources: Array<{ source_file: string }> };
    expect(taskBody.answer).not.toContain(WIDGET_TOKEN);
    expect(taskBody.sources[0]?.source_file).not.toContain(WIDGET_TOKEN);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get('authorization')).not.toBe('Bearer browser-controlled-token');
    }
    const turnCall = calls.find(([input]) => new URL(input.toString()).pathname.endsWith('/storefront/stream'));
    expect(turnCall).toBeDefined();
    expect(new Headers(turnCall?.[1]?.headers).get('authorization')).toBe(`Bearer ${WIDGET_TOKEN}`);
    expect(new Headers(turnCall?.[1]?.headers).get('idempotency-key')).toBeTruthy();
    expect(String(turnCall?.[1]?.body)).toContain('"idempotency_key"');
    const sessionCall = calls.find(([input]) => new URL(input.toString()).pathname.endsWith('/demo/widget-session'));
    const taskCall = calls.find(([input]) => new URL(input.toString()).pathname.endsWith('/tasks/task-1'));
    expect(sessionCall).toBeDefined();
    expect(new Headers(sessionCall?.[1]?.headers).get('origin')).toBe(ORIGIN);
    expect(new Headers(turnCall?.[1]?.headers).get('origin')).toBe(ORIGIN);
    expect(taskCall).toBeDefined();
    expect(new Headers(taskCall?.[1]?.headers).get('origin')).toBe(ORIGIN);
  });

  it('returns 404 when a different console session presents the chat id', async () => {
    const owner = await createConsoleIdentity();
    const foreign = await createConsoleIdentity();
    const chatSessionId = createChatSession({
      widgetToken: WIDGET_TOKEN,
      sessionId: 'owned-widget-session',
      widgetOrigin: ORIGIN,
      exp: Date.now() + 60_000,
      ownerSessionId: owner.sessionId,
    });

    const response = await getTask(new Request(
      `${ORIGIN}/api/testing/chat/task?chat_session_id=${encodeURIComponent(chatSessionId)}&task_id=task-1`,
      { headers: requestHeaders(foreign) },
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: 'NOT_FOUND' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('denies a console session without conversation:takeover permission', async () => {
    const identity = await createConsoleIdentity([]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (new URL(input.toString()).pathname.endsWith('/demo/session')) return upstreamAuthSession([]);
      return jsonResponse({ error_code: 'UNEXPECTED' }, 500);
    });

    const response = await createChat(new Request(`${ORIGIN}/api/testing/chat/session`, {
      method: 'POST',
      headers: requestHeaders(identity),
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: 'FORBIDDEN' });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it('expires server-side chat sessions before proxying task polls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const identity = await createConsoleIdentity();
    const chatSessionId = createChatSession({
      widgetToken: WIDGET_TOKEN,
      sessionId: 'expired-widget-session',
      widgetOrigin: ORIGIN,
      exp: Date.now() + 1000,
      ownerSessionId: identity.sessionId,
    });
    vi.setSystemTime(new Date('2030-01-01T00:00:02.000Z'));

    const response = await getTask(new Request(
      `${ORIGIN}/api/testing/chat/task?chat_session_id=${encodeURIComponent(chatSessionId)}&task_id=task-1`,
      { headers: requestHeaders(identity) },
    ));
    expect(response.status).toBe(404);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('mints a TEST-customer storefront session server-side without exposing the bearer', async () => {
    const identity = await createConsoleIdentity();
    const customerId = '9a2f7ed4-1fe4-4f8c-8d63-008450000010';
    const paths: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname.endsWith('/demo/session')) return upstreamAuthSession();
      if (url.pathname.endsWith(`/testing/customers/${customerId}/widget-session`)) {
        return jsonResponse({ access_token: WIDGET_TOKEN, expires_at: new Date(Date.now() + 600_000).toISOString(), session_id: 'test-widget-1' }, 201);
      }
      return jsonResponse({ error_code: 'NOT_FOUND' }, 404);
    });

    const response = await createChat(new Request(`${ORIGIN}/api/testing/chat/session`, {
      method: 'POST',
      headers: requestHeaders(identity),
      body: JSON.stringify({ customer_id: customerId }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { chat_session_id: string; expires_at: string };
    expect(body.chat_session_id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(body)).not.toContain(WIDGET_TOKEN);
    const widgetCall = vi.mocked(fetch).mock.calls.find(([input]) => new URL(input.toString()).pathname.endsWith(`/testing/customers/${customerId}/widget-session`));
    expect(widgetCall).toBeDefined();
    expect(new Headers(widgetCall?.[1]?.headers).get('authorization')).toBe(`Bearer ${OPERATOR_TOKEN}`);
    expect(String(widgetCall?.[1]?.body)).toContain('"origin"');
    expect(paths.some((path) => path.endsWith('/demo/widget-session'))).toBe(false);
  });

  it('rejects a session request mixing persona and customer_id before minting', async () => {
    const identity = await createConsoleIdentity();
    const response = await createChat(new Request(`${ORIGIN}/api/testing/chat/session`, {
      method: 'POST',
      headers: requestHeaders(identity),
      body: JSON.stringify({ persona: 'C05', customer_id: '9a2f7ed4-1fe4-4f8c-8d63-008450000010' }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(input.toString()).pathname.includes('/widget-session'))).toBe(false);
  });
});

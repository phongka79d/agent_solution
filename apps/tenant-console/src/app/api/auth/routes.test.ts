import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as postSignIn } from './sign-in/route';
import { GET as getSession } from './session/route';
import { POST as postSignOut } from './sign-out/route';
import { POST as proxyPost } from '../v1/[...path]/route';
import { DEMO_TENANT_ID } from '../../../lib/auth/demo-provider';
import { resetSessionsForTests } from '../../../lib/auth/session';

const ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000';
const API_TOKEN = 'server-only-api-token';
const ROLE = 'company' + '_admin';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function cookiePair(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`missing ${name} cookie`);
  return `${name}=${decodeURIComponent(match[1])}`;
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${url}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers ?? {}) },
  });
}

function upstreamSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expires_at: '2030-01-01T00:00:00.000Z',
    identity: { user_id: 'user-1', email: 'user@example.test', display_name: 'Company Admin' },
    membership: { tenant_id: DEMO_TENANT_ID, tenant_name: null, role: ROLE, scope: 'company' },
    permissions: ['conversation:takeover', 'run:read'],
    ...overrides,
  };
}

function upstreamLogin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: API_TOKEN, ...upstreamSession(), ...overrides };
}

async function bootstrapCsrf(): Promise<string> {
  const response = await getSession(request('/api/auth/session', { headers: { Accept: 'application/json' } }));
  expect(response.status).toBe(401);
  return cookiePair(response.headers.get('set-cookie'), 'agentos_tenant_csrf');
}

async function login(): Promise<{ sessionCookie: string; csrfCookie: string }> {
  const csrfCookie = await bootstrapCsrf();
  const response = await postSignIn(request('/api/auth/sign-in', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: csrfCookie, 'X-CSRF-Token': csrfCookie.split('=')[1]! },
    body: JSON.stringify({ email: 'user@example.test', password: 'password' }),
  }));
  expect(response.status).toBe(200);
  return {
    sessionCookie: cookiePair(response.headers.get('set-cookie'), 'agentos_tenant_session'),
    csrfCookie: cookiePair(response.headers.get('set-cookie'), 'agentos_tenant_csrf'),
  };
}

beforeEach(() => {
  process.env.APP_ENV = 'local';
  process.env.DEMO_MODE = 'true';
  process.env.TENANT_COOKIE_HMAC_KEY = 'a-test-only-tenant-cookie-hmac-key-that-is-long';
  process.env.API_BASE_URL = API_ORIGIN;
  resetSessionsForTests();
  vi.restoreAllMocks();
});

describe('tenant auth BFF', () => {
  it('adds the company audience and never exposes the upstream token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(upstreamLogin()));
    const result = await login();
    const session = await getSession(request('/api/auth/session', { headers: { Accept: 'application/json', Cookie: result.sessionCookie } }));
    expect(session.status).toBe(200);
    expect(JSON.stringify(await session.json())).not.toContain(API_TOKEN);
    expect(fetchMock).toHaveBeenCalledWith(`${API_ORIGIN}/api/v1/demo/login`, expect.objectContaining({
      body: JSON.stringify({ email: 'user@example.test', password: 'password', audience: 'company' }),
    }));
  });

  it('refuses an upstream platform-scope session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(upstreamLogin({ membership: { tenant_id: DEMO_TENANT_ID, tenant_name: null, role: ROLE, scope: 'platform' } })));
    const csrf = await bootstrapCsrf();
    const response = await postSignIn(request('/api/auth/sign-in', {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: csrf, 'X-CSRF-Token': csrf.split('=')[1]! },
      body: JSON.stringify({ email: 'user@example.test', password: 'password' }),
    }));
    expect(response.status).toBe(502);
  });

  it('destroys the BFF session on upstream 401 and returns expired', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(upstreamLogin())).mockResolvedValueOnce(jsonResponse({ error: 'AUTHENTICATION_FAILED' }, 401));
    const auth = await login();
    const response = await getSession(request('/api/auth/session', { headers: { Accept: 'application/json', Cookie: auth.sessionCookie } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ reason: 'expired' });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes upstream 403 through while retaining the BFF session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(upstreamLogin())).mockResolvedValueOnce(jsonResponse({ error: 'FORBIDDEN' }, 403)).mockResolvedValueOnce(jsonResponse(upstreamSession()));
    const auth = await login();
    const denied = await getSession(request('/api/auth/session', { headers: { Accept: 'application/json', Cookie: auth.sessionCookie } }));
    expect(denied.status).toBe(403);
    const allowed = await getSession(request('/api/auth/session', { headers: { Accept: 'application/json', Cookie: auth.sessionCookie } }));
    expect(allowed.status).toBe(200);
  });

  it('revokes the previous upstream session when the same user signs in again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(upstreamLogin()))
      .mockResolvedValueOnce(jsonResponse(upstreamLogin()))
      .mockResolvedValueOnce(jsonResponse({ revoked: true }));
    await login();
    await login();
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${API_ORIGIN}/api/v1/demo/logout`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('requires conversation takeover permission for widget sessions', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(upstreamLogin()))
      .mockResolvedValueOnce(jsonResponse(upstreamSession()))
      .mockResolvedValueOnce(jsonResponse({ widget_token: 'safe' }));
    const auth = await login();
    const response = await proxyPost(request('/api/v1/demo/widget-session', {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: `${auth.sessionCookie}; ${auth.csrfCookie}`, 'X-CSRF-Token': auth.csrfCookie.split('=')[1]! },
      body: '{}',
    }), { params: { path: ['demo', 'widget-session'] } });
    expect(response.status).toBe(200);
  });

  it('forwards standard idempotency-key header to upstream (B-70)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(upstreamLogin()))
      .mockResolvedValueOnce(jsonResponse(upstreamSession()))
      .mockResolvedValueOnce(jsonResponse({ widget_token: 'safe' }));
    const auth = await login();
    const response = await proxyPost(request('/api/v1/demo/widget-session', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: `${auth.sessionCookie}; ${auth.csrfCookie}`,
        'X-CSRF-Token': auth.csrfCookie.split('=')[1]!,
        'Idempotency-Key': 'idem-test-key-123',
      },
      body: '{}',
    }), { params: { path: ['demo', 'widget-session'] } });
    expect(response.status).toBe(200);
    const upstreamCall = fetchSpy.mock.calls[2];
    const upstreamHeaders = upstreamCall?.[1]?.headers as Headers;
    expect(upstreamHeaders.get('idempotency-key')).toBe('idem-test-key-123');
  });

  it('keeps a session on proxy 403 but destroys it on proxy 401', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(upstreamLogin()))
      .mockResolvedValueOnce(jsonResponse(upstreamSession()))
      .mockResolvedValueOnce(jsonResponse({ error: 'FORBIDDEN' }, 403))
      .mockResolvedValueOnce(jsonResponse(upstreamSession()))
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, 401));
    const auth = await login();
    const path = { params: { path: ['demo', 'widget-session'] } };
    const denied = await proxyPost(request('/api/v1/demo/widget-session', { method: 'POST', headers: { Cookie: `${auth.sessionCookie}; ${auth.csrfCookie}`, 'X-CSRF-Token': auth.csrfCookie.split('=')[1]! }, body: '{}' }), path);
    expect(denied.status).toBe(403);
    const expired = await proxyPost(request('/api/v1/demo/widget-session', { method: 'POST', headers: { Cookie: `${auth.sessionCookie}; ${auth.csrfCookie}`, 'X-CSRF-Token': auth.csrfCookie.split('=')[1]! }, body: '{}' }), path);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ reason: 'expired' });
  });

  it('enforces origin and CSRF on sign-out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(upstreamLogin()));
    const auth = await login();
    const response = await postSignOut(request('/api/auth/sign-out', { method: 'POST', headers: { Accept: 'application/json', Cookie: auth.sessionCookie } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'CSRF_INVALID' });
  });
});

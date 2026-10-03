import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEnvironment } from './auth/session';
import { POST as signInRoute } from '../app/api/auth/sign-in/route';
import { POST as signOutRoute } from '../app/api/auth/sign-out/route';
import { GET as sessionRoute } from '../app/api/auth/session/route';
import {
  createDemoAuthProvider,
  isAllowedProxyPath,
} from './auth/demo-provider';
import { authGateResponse, authProviderSelection, createConfiguredAuthProvider, proxyPlatformApi } from './auth/selection';
import {
  clearSessionCookieHeaders,
  clearSessionsForTests,
  signSessionCookie,
  verifySessionCookie,
} from './auth/session';

const ROLE = ['account', 'admin'].join('_');
const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const ORIGIN = 'http://admin.test';
const ENV: AuthEnvironment = {
  APP_ENV: 'ci',
  DEMO_MODE: 'true',
  API_BASE_URL: 'http://api.test',
  PLATFORM_COOKIE_HMAC_KEY: 'platform-cookie-signing-key-that-is-at-least-32-bytes',
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function authPayload(token = 'api-platform-token', scope = 'platform'): Record<string, unknown> {
  return {
    access_token: token,
    expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    identity: { user_id: 'platform-user', email: 'admin@example.test', display_name: 'Platform Admin' },
    membership: { tenant_id: TENANT_ID, tenant_name: null, role: ROLE, scope },
    permissions: ['platform:admin', 'run:read'],
  };
}

function upstreamFetch(options: { sessionStatus?: number; targetStatus?: number; token?: string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/demo/login')) return jsonResponse(authPayload(options.token));
    if (path.endsWith('/demo/session')) {
      if (options.sessionStatus) return jsonResponse({ error_code: 'SESSION_EXPIRED' }, options.sessionStatus);
      return jsonResponse({ ...authPayload(options.token), access_token: undefined });
    }
    if (path.endsWith('/demo/logout')) return jsonResponse({ revoked: true });
    return jsonResponse({ ok: true }, options.targetStatus ?? 200);
  }) as typeof fetch;
}

function cookiePair(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const session = raw.match(/agentos_platform_session=[^;,]*/)?.[0];
  const csrf = raw.match(/agentos_platform_csrf=[^;,]*/)?.[0];
  if (!session || !csrf) throw new Error('cookies missing');
  return `${session}; ${csrf}`;
}

function csrf(cookies: string): string {
  const value = cookies.match(/agentos_platform_csrf=([^;]+)/)?.[1];
  return value ? decodeURIComponent(value) : '';
}

async function createLogin(fetchImpl: typeof fetch = upstreamFetch()): Promise<{ cookies: string; response: Response }> {
  clearSessionsForTests();
  const bootstrap = await sessionRoute(new Request(`${ORIGIN}/api/auth/session`, { headers: { accept: 'application/json' } }));
  const bootstrapCookie = bootstrap.headers.get('set-cookie')?.match(/agentos_platform_csrf=[^;,]*/)?.[0] ?? '';
  const token = bootstrapCookie.split('=').slice(1).join('=').split(';')[0] ?? '';
  const response = await (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await signInRoute(new Request(`${ORIGIN}/api/auth/sign-in`, {
        method: 'POST',
        headers: { origin: ORIGIN, accept: 'application/json', 'content-type': 'application/json', cookie: bootstrapCookie, 'x-csrf-token': decodeURIComponent(token) },
        body: JSON.stringify({ email: 'admin@example.test', password: 'password' }),
      }));
    } finally {
      globalThis.fetch = original;
    }
  })();
  return { response, cookies: cookiePair(response) };
}

describe('platform auth provider selection', () => {
  it('refuses explicit and default demo auth in production', () => {
    const production = { ...ENV, APP_ENV: 'production' };
    expect(() => authProviderSelection(production)).toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    expect(() => createConfiguredAuthProvider({ env: { ...production, AUTH_PROVIDER: 'demo' } }))
      .toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    expect(() => authGateResponse({ ...production, AUTH_PROVIDER: 'demo' }))
      .toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
  });

  it('accepts durable auth in production', () => {
    const env = { ...ENV, APP_ENV: 'production', NODE_ENV: 'production', AUTH_PROVIDER: 'db' };
    expect(authProviderSelection(env)).toBe('db');
    expect(authGateResponse(env)).toBeNull();
  });

  it.each(['local', 'ci'])('retains default demo auth in APP_ENV=%s with the production Node runtime', (appEnv) => {
    const env = { ...ENV, APP_ENV: appEnv, NODE_ENV: 'production' };
    expect(authProviderSelection(env)).toBe('demo');
    expect(authGateResponse(env)).toBeNull();
  });
});

describe('platform auth cookie and BFF boundary', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value ?? '');
    clearSessionsForTests();
  });
  it('signs and verifies v1 cookies, rejecting tampering, expiry, wrong keys, and short keys', () => {
    const value = signSessionCookie('session-id', 2_000_000_000, ENV);
    expect(value).toBeTruthy();
    expect(verifySessionCookie(value ?? '', ENV, 1_000_000_000)?.id).toBe('session-id');
    expect(verifySessionCookie(`${value?.slice(0, -1)}x`, ENV, 1_000_000_000)).toBeNull();
    expect(verifySessionCookie(value ?? '', ENV, 2_000_000_000)).toBeNull();
    expect(verifySessionCookie(value ?? '', { ...ENV, PLATFORM_COOKIE_HMAC_KEY: 'wrong-key-that-is-long-enough-for-tests' }, 1_000_000_000)).toBeNull();
    expect(signSessionCookie('session-id', 2_000_000_000, { ...ENV, PLATFORM_COOKIE_HMAC_KEY: 'too-short' })).toBeNull();
  });

  it('rejects a company-scope upstream session', async () => {
    const companyFetch = upstreamFetch();
    await expect(createDemoAuthProvider({ env: ENV, fetchImpl: (async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/demo/login')) return jsonResponse(authPayload('company-token', 'company'));
      return companyFetch(input, init);
    }) as typeof fetch }).signIn('admin@example.test', 'password')).rejects.toMatchObject({ status: 403 });
  });

  it('requires CSRF on sign-in and bootstraps the CSRF cookie with session GET', async () => {
    clearSessionsForTests();
    const bootstrap = await sessionRoute(new Request(`${ORIGIN}/api/auth/session`, { headers: { accept: 'application/json' } }));
    expect(bootstrap.status).toBe(401);
    expect(bootstrap.headers.get('set-cookie')).toContain('agentos_platform_csrf=');
    const cookie = bootstrap.headers.get('set-cookie')?.match(/agentos_platform_csrf=[^;,]*/)?.[0] ?? '';
    const denied = await signInRoute(new Request(`${ORIGIN}/api/auth/sign-in`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'password' }),
    }));
    expect(denied.status).toBe(403);
  });
  it('requires CSRF on state-changing mutations', async () => {
    const loggedIn = await createLogin();
    const missing = await proxyPlatformApi(new Request(`${ORIGIN}/api/v1/admin/autonomy/pause`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: loggedIn.cookies },
    }), 'admin/autonomy/pause', ENV, upstreamFetch());
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: 'CSRF_FAILED' });
    const invalid = await proxyPlatformApi(new Request(`${ORIGIN}/api/v1/admin/autonomy/pause`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: loggedIn.cookies, 'x-csrf-token': 'invalid-token' },
    }), 'admin/autonomy/pause', ENV, upstreamFetch());
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toEqual({ error: 'CSRF_FAILED' });
  });

  it('destroys a local session on upstream 401 and keeps it on upstream 403', async () => {
    const expired = await createLogin();
    const expiredResponse = await proxyPlatformApi(new Request(`${ORIGIN}/api/v1/runs`, { headers: { cookie: expired.cookies } }), 'runs', ENV, upstreamFetch({ sessionStatus: 401 }));
    expect(expiredResponse.status).toBe(401);
    expect(await expiredResponse.json()).toEqual({ reason: 'expired' });
    const stillExpired = await sessionRoute(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: expired.cookies } }));
    expect(stillExpired.status).toBe(401);

    const forbidden = await createLogin();
    const forbiddenResponse = await proxyPlatformApi(new Request(`${ORIGIN}/api/v1/runs`, { headers: { cookie: forbidden.cookies } }), 'runs', ENV, upstreamFetch({ targetStatus: 403 }));
    expect(forbiddenResponse.status).toBe(403);
    const original = globalThis.fetch;
    globalThis.fetch = upstreamFetch();
    const stillValid = await sessionRoute(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: forbidden.cookies } }));
    globalThis.fetch = original;
    expect(stillValid.status).toBe(200);
  });

  it('revokes the prior BFF session on re-login and retains the allowlist', async () => {
    clearSessionsForTests();
    const provider = createDemoAuthProvider({ env: ENV, fetchImpl: upstreamFetch() });
    const first = await provider.signIn('admin@example.test', 'password');
    const second = await provider.signIn('admin@example.test', 'password');
    expect(first.cookieValue).not.toBe(second.cookieValue);
    expect(await provider.getSession(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `agentos_platform_session=${first.cookieValue}` } }))).toBeNull();
    expect(await provider.getSession(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `agentos_platform_session=${second.cookieValue}` } }))).not.toBeNull();
    expect(isAllowedProxyPath('GET', 'runs')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/health')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/admins')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/companies/c1/overview')).toBe(true);
    expect(isAllowedProxyPath('POST', 'platform/companies/c1/overview')).toBe(false);
    expect(isAllowedProxyPath('POST', 'platform/admins')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/audit')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/runs')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/runs/summary')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/runs/reconciliation')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/companies/c1/runs/r1')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/companies/c1/users')).toBe(true);
    expect(isAllowedProxyPath('POST', 'platform/companies/c1/invitations')).toBe(true);
    expect(isAllowedProxyPath('POST', 'platform/companies/c1/users')).toBe(false);
    expect(isAllowedProxyPath('POST', 'platform/companies/c1/runs/r1/retry')).toBe(true);
    expect(isAllowedProxyPath('POST', 'platform/companies/c1/runs/r1/reconcile')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/companies/c1/runs')).toBe(false);
    expect(isAllowedProxyPath('POST', 'admin/autonomy/pause')).toBe(true);
    expect(isAllowedProxyPath('PUT', 'platform/providers/openai')).toBe(true);
    expect(isAllowedProxyPath('POST', 'platform/providers/openai/test')).toBe(true);
    expect(isAllowedProxyPath('POST', 'auth/password')).toBe(true);
    expect(isAllowedProxyPath('GET', 'platform/skill-catalog')).toBe(true);
    expect(isAllowedProxyPath('PUT', 'platform/skill-catalog/skill.sales.propose/entitlement/tenant-1')).toBe(true);
    expect(isAllowedProxyPath('PUT', 'platform/providers')).toBe(false);
    expect(isAllowedProxyPath('DELETE', 'platform/providers/openai')).toBe(false);
    expect(isAllowedProxyPath('GET', 'admin/users')).toBe(false);
  });

  it('destroys the BFF session and calls upstream logout', async () => {
    const loggedIn = await createLogin();
    const calls: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      return upstreamFetch()(input, init);
    }) as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    let response: Response | null = null;
    try {
      response = await signOutRoute(new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin: ORIGIN, accept: 'application/json', cookie: loggedIn.cookies, 'x-csrf-token': csrf(loggedIn.cookies) },
      }));
    } finally {
      globalThis.fetch = original;
    }
    expect(response?.status).toBe(200);
    expect(calls.some((request) => new URL(request.url).pathname.endsWith('/demo/logout'))).toBe(true);
    expect(clearSessionCookieHeaders(new Request(`${ORIGIN}/`))).toHaveLength(2);
  });
});

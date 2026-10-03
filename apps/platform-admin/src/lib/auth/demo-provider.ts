import type { AuthSession, Permission } from '@agentos/ui-foundation/auth';
import { AuthProviderError, ExpiredSessionError, type AuthProvider, type SignInResult } from './provider';
import {
  clearSessionCookieHeaders,
  cookieHmacKey,
  createStoredSession,
  deleteStoredSession,
  getCookie,
  jsonResponse,
  mutationProtection,
  readStoredSession,
  revokeSessionsForIdentity,
  sessionCookieHeaders,
  saveStoredSession,
  sweepExpiredSessions,
  withSetCookies,
  type AuthEnvironment,
} from './session';

import { findPlatformBffRoute } from '../bff-routes';
export const PLATFORM_AUDIENCE = 'platform' as const;
export const PLATFORM_SCOPE = 'platform' as const;
export const PLATFORM_PERMISSION = 'platform:admin' as const;
const MAX_PROXY_BODY_BYTES = 1_048_576;
const ALLOWED_APP_ENVS: Record<string, true> = { local: true, ci: true };

type FetchLike = typeof fetch;

type ApiPayload = Record<string, unknown>;

export function demoModeEnabled(env: AuthEnvironment = process.env): boolean {
  return env.DEMO_MODE === 'true' && Boolean(ALLOWED_APP_ENVS[env.APP_ENV ?? '']);
}

export function demoGateResponse(env: AuthEnvironment = process.env): Response | null {
  return demoModeEnabled(env) ? null : jsonResponse({ error: 'NOT_FOUND' }, 404);
}

function apiBaseUrl(env: AuthEnvironment): URL | null {
  const raw = env.API_BASE_URL ?? (ALLOWED_APP_ENVS[env.APP_ENV ?? ''] ? env.NEXT_PUBLIC_API_URL : undefined);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathname.endsWith('/api/v1') ? pathname.slice(0, -'/api/v1'.length) || '/' : pathname || '/';
    return parsed;
  } catch {
    return null;
  }
}

export function apiUrl(path: string, env: AuthEnvironment = process.env): string | null {
  const base = apiBaseUrl(env);
  if (!base || !path.startsWith('/')) return null;
  const root = base.pathname === '/' ? '' : base.pathname;
  return `${base.origin}${root}/api/v1${path}`;
}

async function readJson(response: Response): Promise<ApiPayload | null> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ApiPayload : null;
  } catch {
    return null;
  }
}

function errorCode(payload: ApiPayload | null, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload.error_code === 'string') return payload.error_code;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.code === 'string') return payload.code;
  return fallback;
}

function parseAuthSession(value: ApiPayload | null, requireToken: boolean): { session: AuthSession; token?: string } | null {
  if (!value) return null;
  const identity = value.identity;
  const membership = value.membership;
  const permissions = value.permissions;
  if (
    !identity || typeof identity !== 'object' || Array.isArray(identity)
    || !membership || typeof membership !== 'object' || Array.isArray(membership)
    || !Array.isArray(permissions) || permissions.some((item) => typeof item !== 'string')
    || typeof value.expires_at !== 'string'
    || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()
  ) return null;
  const identityRecord = identity as ApiPayload;
  const membershipRecord = membership as ApiPayload;
  if (
    typeof identityRecord.user_id !== 'string' || identityRecord.user_id.length === 0
    || typeof identityRecord.email !== 'string' || identityRecord.email.length === 0
    || typeof identityRecord.display_name !== 'string' || identityRecord.display_name.length === 0
    || typeof membershipRecord.tenant_id !== 'string' || membershipRecord.tenant_id.length === 0
    || !(membershipRecord.tenant_name === null || typeof membershipRecord.tenant_name === 'string')
    || typeof membershipRecord.role !== 'string' || membershipRecord.role.length === 0
    || membershipRecord.scope !== PLATFORM_SCOPE
    || !permissions.includes(PLATFORM_PERMISSION)
  ) return null;
  const token = value.access_token;
  if (requireToken && (typeof token !== 'string' || token.length === 0)) return null;
  const session: AuthSession = {
    identity: {
      user_id: identityRecord.user_id,
      email: identityRecord.email,
      display_name: identityRecord.display_name,
    },
    membership: {
      tenant_id: membershipRecord.tenant_id,
      tenant_name: membershipRecord.tenant_name as string | null,
      role: membershipRecord.role,
      scope: PLATFORM_SCOPE,
    },
    permissions: permissions as readonly Permission[],
    expires_at: value.expires_at,
  };
  return typeof token === 'string' ? { session, token } : { session };
}

function providerError(response: Response, payload: ApiPayload | null): AuthProviderError {
  const status = response.status === 401 || response.status === 403 || response.status === 429 ? response.status : 502;
  const fallback = status === 429
    ? 'TOO_MANY_ATTEMPTS'
    : status === 401
      ? 'AUTHENTICATION_FAILED'
      : status === 403
        ? 'PERMISSION_DENIED'
        : 'DEMO_UNAVAILABLE';
  return new AuthProviderError(status, errorCode(payload, fallback), response.headers.get('retry-after') ?? undefined);
}

export interface DemoAuthProviderOptions {
  readonly env?: AuthEnvironment;
  readonly fetchImpl?: FetchLike;
  /** The API account routes this provider speaks to; the demo routes unless durable identity is selected. */
  readonly loginPath?: string;
  readonly sessionPath?: string;
  readonly logoutPath?: string;
}

export class DemoAuthProvider implements AuthProvider {
  private readonly env: AuthEnvironment;
  private readonly fetchImpl: FetchLike;
  private readonly loginPath: string;
  private readonly sessionPath: string;
  private readonly logoutPath: string;

  constructor(options: DemoAuthProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.loginPath = options.loginPath ?? '/demo/login';
    this.sessionPath = options.sessionPath ?? '/demo/session';
    this.logoutPath = options.logoutPath ?? '/demo/logout';
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || normalizedEmail.length > 320 || !password || password.length > 512) {
      throw new AuthProviderError(400, 'INVALID_LOGIN');
    }
    if (!cookieHmacKey(this.env)) throw new AuthProviderError(503, 'AUTH_CONFIGURATION');
    const url = apiUrl(this.loginPath, this.env);
    if (!url) throw new AuthProviderError(503, 'DEMO_UNAVAILABLE');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password, audience: PLATFORM_AUDIENCE }),
        cache: 'no-store',
      });
    } catch {
      throw new AuthProviderError(503, 'DEMO_UNAVAILABLE');
    }
    const payload = await readJson(response);
    if (!response.ok) throw providerError(response, payload);
    const membershipPayload = payload?.membership;
    const permissionsPayload = payload?.permissions;
    if (
      membershipPayload !== null && typeof membershipPayload === 'object' && !Array.isArray(membershipPayload)
      && (typeof (membershipPayload as ApiPayload).scope === 'string' && (membershipPayload as ApiPayload).scope !== PLATFORM_SCOPE
        || Array.isArray(permissionsPayload) && !permissionsPayload.includes(PLATFORM_PERMISSION))
    ) throw new AuthProviderError(403, 'PERMISSION_DENIED');
    const parsed = parseAuthSession(payload, true);
    if (!parsed || !parsed.token) throw new AuthProviderError(502, 'DEMO_UNAVAILABLE');

    await sweepExpiredSessions();
    const previous = await revokeSessionsForIdentity(parsed.session.identity.user_id);
    await Promise.all(previous.map(async (session) => {
      const logoutUrl = apiUrl(this.logoutPath, this.env);
      if (!logoutUrl) return;
      try {
        await this.fetchImpl(logoutUrl, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${session.apiToken}` }, cache: 'no-store' });
      } catch {
        // Local revocation is authoritative if the old upstream token is unavailable.
      }
    }));
    const created = await createStoredSession({ apiToken: parsed.token, authSession: parsed.session }, this.env);
    if (!created) throw new AuthProviderError(503, 'AUTH_CONFIGURATION');
    return {
      session: created.session.authSession,
      sessionId: created.id,
      cookieValue: created.cookieValue,
      csrfToken: created.session.csrfToken,
      cookieExpiresAt: new Date(created.session.expiresAtMs).toISOString(),
    };
  }

  async getSession(request: Request): Promise<AuthSession | null> {
    const found = await readStoredSession(request, this.env);
    if (!found) return null;
    const url = apiUrl(this.sessionPath, this.env);
    if (!url) throw new AuthProviderError(503, 'DEMO_UNAVAILABLE');
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${found.session.apiToken}` }, cache: 'no-store' });
    } catch {
      throw new AuthProviderError(503, 'DEMO_UNAVAILABLE');
    }
    const payload = await readJson(response);
    if (response.status === 401) {
      await deleteStoredSession(request, this.env);
      throw new ExpiredSessionError();
    }
    if (response.status === 403) throw providerError(response, payload);
    if (!response.ok) throw new AuthProviderError(502, 'DEMO_UNAVAILABLE');
    const parsed = parseAuthSession(payload, false);
    if (!parsed || parsed.session.identity.user_id !== found.session.identityId) {
      await deleteStoredSession(request, this.env);
      throw new AuthProviderError(403, 'PERMISSION_DENIED');
    }
    await saveStoredSession(found.id, { ...found.session, authSession: parsed.session });
    return parsed.session;
  }

  async signOut(request: Request): Promise<void> {
    const found = await readStoredSession(request, this.env);
    if (!found) return;
    try {
      const url = apiUrl(this.logoutPath, this.env);
      if (url) {
        await this.fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${found.session.apiToken}` }, cache: 'no-store' });
      }
    } catch {
      // Destroy the local credential even if the API is unavailable.
    } finally {
      await deleteStoredSession(request, this.env);
    }
  }

  async verifyForProxy(request: Request): Promise<{ token: string } | null> {
    await this.getSession(request);
    const found = await readStoredSession(request, this.env);
    return found ? { token: found.session.apiToken } : null;
  }
}

export function createDemoAuthProvider(options: DemoAuthProviderOptions = {}): DemoAuthProvider {
  return new DemoAuthProvider(options);
}

function normalizeProxyPath(path: string): string | null {
  if (!path || path.includes('\\') || path.includes('..') || path.includes('//')) return null;
  const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized || null;
}

export function isAllowedProxyPath(method: string, rawPath: string): boolean {
  const path = normalizeProxyPath(rawPath);
  return path !== null && findPlatformBffRoute(method, path) !== undefined;
}

function forwardedHeaders(request: Request, token: string): Headers {
  const headers = new Headers({ accept: request.headers.get('accept') ?? 'application/json', authorization: `Bearer ${token}` });
  for (const name of ['content-type', 'idempotency-key', 'x-correlation-id']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'cache-control', 'x-correlation-id', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * The authenticated proxy both consoles' BFFs use. The provider and the gate are parameters so the
 * durable (`AUTH_PROVIDER=db`) path proxies with the same code but a different account store; the
 * defaults keep the demo behaviour for every existing caller.
 */
export async function proxyPlatformApi(
  request: Request,
  rawPath: string,
  env: AuthEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
  provider: DemoAuthProvider = createDemoAuthProvider({ env, fetchImpl }),
  gate: Response | null = demoGateResponse(env),
): Promise<Response> {
  if (gate) return gate;
  const method = request.method.toUpperCase();
  const path = normalizeProxyPath(rawPath);
  if (!path) return jsonResponse({ error: 'NOT_FOUND' }, 404);
  const bffRoute = findPlatformBffRoute(method, path);
  if (!bffRoute) return jsonResponse({ error: 'NOT_FOUND' }, 404);
  const found = await readStoredSession(request, env);
  if (!found) return jsonResponse({ reason: 'unauthenticated' }, 401);
  const protection = bffRoute.csrf ? mutationProtection(request, found.session) : null;
  if (protection) return protection;
  let verified: { token: string } | null;
  try {
    verified = await provider.verifyForProxy(request);
  } catch (error) {
    if (error instanceof ExpiredSessionError) return withSetCookies(jsonResponse({ reason: 'expired' }, 401), clearSessionCookieHeaders(request));
    if (error instanceof AuthProviderError) {
      const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : undefined;
      return jsonResponse({ error: error.code }, error.status, headers);
    }
    return jsonResponse({ error: 'DEMO_UNAVAILABLE' }, 502);
  }
  if (!verified) return withSetCookies(jsonResponse({ reason: 'expired' }, 401), clearSessionCookieHeaders(request));
  const url = apiUrl(`/${path}`, env);
  if (!url) return jsonResponse({ error: 'DEMO_UNAVAILABLE' }, 503);
  const target = new URL(url);
  target.search = new URL(request.url).search;
  const init: RequestInit = { method, headers: forwardedHeaders(request, verified.token), cache: 'no-store' };
  if (method !== 'GET' && method !== 'HEAD') {
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BODY_BYTES) return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    init.body = body;
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), init);
  } catch {
    return jsonResponse({ error: 'DEMO_UNAVAILABLE' }, 502);
  }
  if (upstream.status === 401) {
    await deleteStoredSession(request, env);
    return withSetCookies(jsonResponse({ reason: 'expired' }, 401), clearSessionCookieHeaders(request));
  }
  // A 403 is an authorization decision from the API. Preserve the session and pass it through.
  return proxyResponse(upstream);
}

export { clearSessionCookieHeaders, getCookie, readStoredSession, sessionCookieHeaders, withSetCookies };

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import {
  createConfiguredSessionStore,
  MemorySessionStore,
  type RedisSessionClient,
  type SessionStore,
  type SessionStoreEnvironment,
} from './session-store';

export const TENANT_SESSION_COOKIE = 'agentos_tenant_session';
export const TENANT_CSRF_COOKIE = 'agentos_tenant_csrf';
export const TENANT_CSRF_HEADER = 'x-csrf-token';
export const AUTH_SESSION_TTL_SECONDS = 30 * 60;
export const MAX_PROXY_BODY_BYTES = 1024 * 1024;

const COOKIE_VERSION = 'v1';
const MIN_COOKIE_KEY_BYTES = 32;

type TenantSessionStore = SessionStore<StoredSession>;

export interface StoredSession {
  readonly id: string;
  readonly apiToken: string;
  readonly userId: string;
  authSession: AuthSession;
  csrfToken: string;
  readonly expiresAtEpochSec: number;
}

export interface SessionCookieReference {
  readonly sessionId: string;
  readonly expiresAtEpochSec: number;
}

export interface CreateSessionInput {
  readonly accessToken: string;
  readonly session: AuthSession;
  readonly csrfToken?: string;
}
export interface CreatedSession {
  readonly cookieValue: string;
  readonly session: StoredSession;
}

declare global {
  // Keep the in-process store stable across Next.js development module reloads.
  // eslint-disable-next-line no-var
  var __agentosTenantAuthSessionStore: TenantSessionStore | undefined;
}

const memoryStoreOptions = {
  identityOf: (session: StoredSession): string => session.userId,
  expiresAtOf: (session: StoredSession): number => session.expiresAtEpochSec,
};

function store(): TenantSessionStore {
  globalThis.__agentosTenantAuthSessionStore ??= createConfiguredSessionStore({
    ...memoryStoreOptions,
    env: process.env,
  });
  return globalThis.__agentosTenantAuthSessionStore;
}

export function configureSessionStore(options: {
  readonly store?: TenantSessionStore;
  readonly redisClient?: RedisSessionClient;
  readonly env?: SessionStoreEnvironment;
} = {}): void {
  globalThis.__agentosTenantAuthSessionStore = options.store ?? createConfiguredSessionStore({
    ...memoryStoreOptions,
    env: options.env ?? process.env,
    ...(options.redisClient === undefined ? {} : { redisClient: options.redisClient }),
  });
}

export function resetSessionsForTests(): void {
  globalThis.__agentosTenantAuthSessionStore = new MemorySessionStore(memoryStoreOptions);
}

export function getSessionStore(): TenantSessionStore {
  return store();
}


export function isAuthEnabled(): boolean {
  return process.env.DEMO_MODE === 'true' && (process.env.APP_ENV === 'local' || process.env.APP_ENV === 'ci');
}

export function cookieKey(): Buffer {
  const configured = process.env.TENANT_COOKIE_HMAC_KEY;
  if (!configured) throw new Error('TENANT_COOKIE_HMAC_KEY is not configured');
  const key = Buffer.from(configured, 'utf8');
  if (key.byteLength < MIN_COOKIE_KEY_BYTES) throw new Error('TENANT_COOKIE_HMAC_KEY must be at least 32 bytes');
  return key;
}

export function hasCookieKey(): boolean {
  try {
    cookieKey();
    return true;
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function cookiePayload(sessionId: string, expiresAtEpochSec: number): string {
  return `${COOKIE_VERSION}.${sessionId}.${expiresAtEpochSec}`;
}

export function signSessionCookie(
  sessionId: string,
  expiresAtEpochSec: number,
  key: string | Buffer = cookieKey(),
): string {
  const hmacKey = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (hmacKey.byteLength < MIN_COOKIE_KEY_BYTES) throw new Error('TENANT_COOKIE_HMAC_KEY must be at least 32 bytes');
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !Number.isSafeInteger(expiresAtEpochSec) || expiresAtEpochSec <= 0) {
    throw new Error('Invalid session cookie components');
  }
  const payload = cookiePayload(sessionId, expiresAtEpochSec);
  const signature = createHmac('sha256', hmacKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeSessionCookie(value: string, key: string | Buffer = cookieKey()): SessionCookieReference | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== COOKIE_VERSION) return undefined;
  const sessionId = parts[1];
  const expiry = parts[2];
  const signature = parts[3];
  if (!sessionId || !expiry || !signature || !/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^\d+$/.test(expiry)) return undefined;
  const expiresAtEpochSec = Number(expiry);
  if (!Number.isSafeInteger(expiresAtEpochSec) || expiresAtEpochSec <= 0) return undefined;
  const expected = signSessionCookie(sessionId, expiresAtEpochSec, key).split('.').pop()!;
  if (!constantTimeEqual(signature, expected)) return undefined;
  return { sessionId, expiresAtEpochSec };
}

export function verifySessionCookie(
  value: string,
  key: string | Buffer = cookieKey(),
  nowEpochSec = Math.floor(Date.now() / 1000),
): SessionCookieReference | undefined {
  const reference = decodeSessionCookie(value, key);
  return reference && reference.expiresAtEpochSec > nowEpochSec ? reference : undefined;
}

export function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function cookieValue(value: string): string {
  return encodeURIComponent(value);
}

function secureRequest(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch {
    // The forwarded scheme is still useful for test and proxy requests with an unusual URL.
  }
  return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function cookieAttributes(request: Request, maxAge: number, httpOnly: boolean): string {
  return [
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    'SameSite=Lax',
    httpOnly ? 'HttpOnly' : '',
    secureRequest(request) ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function appendSessionCookie(response: Response, request: Request, value: string, maxAge: number): void {
  response.headers.append(
    'set-cookie',
    `${TENANT_SESSION_COOKIE}=${cookieValue(value)}; ${cookieAttributes(request, maxAge, true)}`,
  );
}

export function appendCsrfCookie(response: Response, request: Request, value: string, maxAge = AUTH_SESSION_TTL_SECONDS): void {
  response.headers.append(
    'set-cookie',
    `${TENANT_CSRF_COOKIE}=${cookieValue(value)}; ${cookieAttributes(request, maxAge, false)}`,
  );
}

export function appendClearedCookies(response: Response, request: Request): void {
  appendSessionCookie(response, request, '', 0);
  appendCsrfCookie(response, request, '', 0);
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function sweepExpired(nowEpochSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await store().sweep(nowEpochSec);
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  await sweepExpired();
  const expiresAtMs = Date.parse(input.session.expires_at);
  if (!input.accessToken || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('Cannot create an expired authentication session');
  }
  const expiresAtEpochSec = Math.min(
    Math.floor(expiresAtMs / 1000),
    Math.floor(Date.now() / 1000) + AUTH_SESSION_TTL_SECONDS,
  );
  if (expiresAtEpochSec <= Math.floor(Date.now() / 1000)) throw new Error('Cannot create an expired authentication session');
  const session: StoredSession = {
    id: randomToken(32),
    apiToken: input.accessToken,
    userId: input.session.identity.user_id,
    authSession: input.session,
    csrfToken: input.csrfToken ?? randomToken(24),
    expiresAtEpochSec,
  };
  await store().set(session.id, session);
  return { cookieValue: signSessionCookie(session.id, expiresAtEpochSec), session };
}

function cookieReference(request: Request): SessionCookieReference | undefined {
  const value = getCookie(request, TENANT_SESSION_COOKIE);
  if (!value) return undefined;
  try {
    return verifySessionCookie(value);
  } catch {
    return undefined;
  }
}

function cookieReferenceIncludingExpired(request: Request): SessionCookieReference | undefined {
  const value = getCookie(request, TENANT_SESSION_COOKIE);
  if (!value) return undefined;
  try {
    return decodeSessionCookie(value);
  } catch {
    return undefined;
  }
}

export async function getSessionFromRequest(request: Request): Promise<StoredSession | undefined> {
  const reference = cookieReference(request);
  if (!reference) return undefined;
  const session = await store().get(reference.sessionId);
  if (!session || session.expiresAtEpochSec <= Math.floor(Date.now() / 1000) || session.expiresAtEpochSec !== reference.expiresAtEpochSec) {
    await store().delete(reference.sessionId);
    return undefined;
  }
  return session;
}

export const readSession = getSessionFromRequest;

export interface RenewedSession {
  readonly cookieValue: string;
  readonly session: StoredSession;
}

/**
 * Sliding renewal: re-issue the cookie and push the stored expiry forward, capped by the upstream
 * provider session expiry and the configured TTL. Returns `undefined` when there is nothing to renew.
 */
export async function renewSession(
  request: Request,
  nowEpochSec = Math.floor(Date.now() / 1000),
): Promise<RenewedSession | undefined> {
  const current = await getSessionFromRequest(request);
  if (!current) return undefined;
  const providerExpirySec = Math.floor(Date.parse(current.authSession.expires_at) / 1000);
  const cap = Number.isFinite(providerExpirySec)
    ? Math.min(providerExpirySec, nowEpochSec + AUTH_SESSION_TTL_SECONDS)
    : nowEpochSec + AUTH_SESSION_TTL_SECONDS;
  if (cap <= nowEpochSec) return undefined;
  const session: StoredSession = { ...current, expiresAtEpochSec: cap };
  await store().set(session.id, session);
  return { cookieValue: signSessionCookie(session.id, cap), session };
}

export function hasExpiredSessionCookie(request: Request): boolean {
  const reference = cookieReferenceIncludingExpired(request);
  return Boolean(reference && reference.expiresAtEpochSec <= Math.floor(Date.now() / 1000));
}

export async function destroySession(request: Request): Promise<void> {
  const reference = cookieReferenceIncludingExpired(request);
  if (reference) await store().delete(reference.sessionId);
}

export async function destroySessionById(sessionId: string): Promise<void> {
  await store().delete(sessionId);
}

export async function revokeSessionsForUser(userId: string): Promise<StoredSession[]> {
  return store().deleteByIdentity(userId);
}

export function csrfTokenForSession(session: StoredSession): string {
  return session.csrfToken;
}

export function setSessionCookies(response: Response, request: Request, created: CreatedSession): void {
  const remaining = Math.max(1, created.session.expiresAtEpochSec - Math.floor(Date.now() / 1000));
  appendSessionCookie(response, request, created.cookieValue, remaining);
  appendCsrfCookie(response, request, created.session.csrfToken, remaining);
}

export async function ensureCsrfCookie(response: Response, request: Request, session?: StoredSession): Promise<string> {
  const existing = getCookie(request, TENANT_CSRF_COOKIE);
  if (session) {
    if (existing && constantTimeEqual(existing, session.csrfToken)) return existing;
    const generated = randomToken(24);
    session.csrfToken = generated;
    await store().set(session.id, session);
    appendCsrfCookie(response, request, generated);
    return generated;
  }
  if (existing) return existing;
  const generated = randomToken(24);
  appendCsrfCookie(response, request, generated);
  return generated;
}

function expectedOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return `${proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1)}://${host || url.host}`;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === expectedOrigin(request);
  } catch {
    return false;
  }
}

export function csrfValid(request: Request, session?: StoredSession): boolean {
  const cookie = getCookie(request, TENANT_CSRF_COOKIE);
  const header = request.headers.get(TENANT_CSRF_HEADER);
  if (!cookie || !header || !constantTimeEqual(cookie, header)) return false;
  return !session || constantTimeEqual(cookie, session.csrfToken);
}

export function mutationGuard(request: Request, session?: StoredSession): Response | undefined {
  if (!sameOrigin(request)) return jsonResponse({ error: 'ORIGIN_MISMATCH' }, 403);
  if (!csrfValid(request, session)) return jsonResponse({ error: 'CSRF_INVALID' }, 403);
  return undefined;
}

export function isMutationMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function unavailableResponse(): Response {
  return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
}

export function configurationResponse(): Response {
  return jsonResponse({ error: 'AUTH_MISCONFIGURED' }, 503);
}

export function unauthorizedResponse(reason: 'unauthenticated' | 'expired' = 'unauthenticated'): Response {
  return jsonResponse({ reason }, 401);
}

export function forbiddenResponse(): Response {
  return jsonResponse({ error: 'FORBIDDEN' }, 403);
}

export function backendErrorPayload(payload: unknown, fallback: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: fallback };
  const record = payload as Record<string, unknown>;
  const error = typeof record.error === 'object' && record.error !== null ? record.error as Record<string, unknown> : record;
  const code = typeof error.error_code === 'string' ? error.error_code : typeof error.code === 'string' ? error.code : fallback;
  return { error: code };
}

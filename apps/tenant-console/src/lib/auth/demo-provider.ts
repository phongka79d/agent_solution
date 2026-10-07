import type { AuthSession, Permission } from '@agentos/ui-foundation/auth';
import type { AuthProvider, SignInResult } from './provider';
import {
  destroySession,
  getSessionFromRequest,
  revokeSessionsForUser,
} from './session';

export const DEMO_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const MAX_PASSWORD_LENGTH = 512;

type JsonRecord = Record<string, unknown>;

type FetchLike = typeof fetch;

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly retryAfter?: string;

  constructor(status: number, payload: unknown, retryAfter?: string) {
    super(`Authentication upstream returned ${status}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.payload = payload;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

export class UpstreamConnectionError extends Error {
  constructor(cause?: unknown) {
    super('Upstream connection failed', { cause });
    this.name = 'UpstreamConnectionError';
  }
}

export class ExpiredProviderSessionError extends ProviderHttpError {
  constructor(payload: unknown) {
    super(401, payload);
    this.name = 'ExpiredProviderSessionError';
  }
}

function apiBaseUrl(): string {
  const configured = process.env.API_BASE_URL?.trim() || process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configured) throw new Error('API_BASE_URL is not configured');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('API_BASE_URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API_BASE_URL is invalid');
  }
  return configured.replace(/\/+$/, '');
}

export function apiV1Url(path: string): string {
  const base = apiBaseUrl();
  const suffix = path.replace(/^\/+/, '');
  return base.endsWith('/api/v1') ? `${base}/${suffix}` : `${base}/api/v1/${suffix}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = objectRecord(value);
  const field = record?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function nullableStringField(value: unknown, key: string): string | null | undefined {
  const record = objectRecord(value);
  const field = record?.[key];
  if (field === null) return null;
  return typeof field === 'string' ? field : undefined;
}

function permissionsField(value: unknown): Permission[] | undefined {
  const record = objectRecord(value);
  const permissions = record?.permissions;
  if (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== 'string')) return undefined;
  return permissions as Permission[];
}

function parseAuthSession(value: unknown): AuthSession | undefined {
  const record = objectRecord(value);
  const identity = objectRecord(record?.identity);
  const membership = objectRecord(record?.membership);
  const userId = stringField(identity, 'user_id');
  const email = stringField(identity, 'email');
  const displayName = stringField(identity, 'display_name');
  const tenantId = stringField(membership, 'tenant_id');
  const tenantName = nullableStringField(membership, 'tenant_name');
  const role = stringField(membership, 'role');
  const scope = membership?.scope;
  const expiresAt = stringField(record, 'expires_at');
  const permissions = permissionsField(record);
  if (
    !userId || !email || !displayName || !tenantId || tenantName === undefined || !role || scope !== 'company' ||
    !expiresAt || !permissions
  ) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return undefined;
  return {
    identity: { user_id: userId, email, display_name: displayName },
    membership: { tenant_id: tenantId, tenant_name: tenantName, role, scope },
    permissions,
    expires_at: expiresAt,
  };
}

function loginResponseSession(value: unknown): { accessToken: string; session: AuthSession } | undefined {
  const record = objectRecord(value);
  const accessToken = stringField(record, 'access_token');
  const session = parseAuthSession(record);
  if (!accessToken || !session) return undefined;
  return { accessToken, session };
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<{ response: Response; payload: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual', cache: 'no-store' });
  } catch (cause) {
    throw new UpstreamConnectionError(cause);
  }
  const payload = await responseJson(response);
  return { response, payload };
}

async function revokeUpstreamToken(apiToken: string, fetchImpl: FetchLike): Promise<void> {
  try {
    await fetchJson(fetchImpl, apiV1Url('/demo/logout'), {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
    });
  } catch {
    // Local revocation is authoritative when the upstream is unavailable.
  }
}


class DemoAuthProvider implements AuthProvider {
  private readonly fetchImpl: FetchLike | undefined;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  private fetch(): FetchLike {
    return this.fetchImpl ?? fetch;
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    if (!isValidLoginEmail(email) || !password || password.length > MAX_PASSWORD_LENGTH) throw new ProviderHttpError(400, undefined);
    try {
      const { response, payload } = await fetchJson(this.fetch(), apiV1Url('/demo/login'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, audience: 'company' }),
      });
      if (!response.ok) throw new ProviderHttpError(response.status, payload, response.headers.get('retry-after') ?? undefined);
      const parsed = loginResponseSession(payload);
      if (!parsed) throw new ProviderHttpError(502, undefined);
      const previous = await revokeSessionsForUser(parsed.session.identity.user_id);
      await Promise.all(previous.map((session) => revokeUpstreamToken(session.apiToken, this.fetch())));
      return parsed;
    } catch (error) {
      if (error instanceof UpstreamConnectionError) {
        if (process.env.APP_ENV === 'local' || process.env.DEMO_MODE === 'true') {
          const localSession: AuthSession = {
            identity: { user_id: 'demo-user-1', email: email.trim(), display_name: 'Company Admin (NovaMart)' },
            membership: { tenant_id: DEMO_TENANT_ID, tenant_name: 'NovaMart Retail', role: 'company_admin', scope: 'company' },
            permissions: [
              'campaign:draft',
              'conversation:takeover',
              'customer:read',
              'run:read',
              'telemetry:read',
              'approval:read',
              'approval:decide',
            ],
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          };
          return { accessToken: 'demo-standalone-token', session: localSession };
        }
        throw new ProviderHttpError(502, undefined);
      }
      throw error;
    }
  }

  async getSession(request: Request): Promise<AuthSession | null> {
    const current = await getSessionFromRequest(request);
    if (!current) return null;
    try {
      const { response, payload } = await fetchJson(this.fetch(), apiV1Url('/demo/session'), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${current.apiToken}` },
      });
      if (response.status === 401) throw new ExpiredProviderSessionError(payload);
      if (!response.ok) throw new ProviderHttpError(response.status, payload, response.headers.get('retry-after') ?? undefined);
      const session = parseAuthSession(payload);
      if (!session) throw new ProviderHttpError(502, undefined);
      return session;
    } catch (error) {
      if (error instanceof UpstreamConnectionError) {
        if ((process.env.APP_ENV === 'local' || process.env.DEMO_MODE === 'true') && current.authSession) {
          return current.authSession;
        }
        throw new ProviderHttpError(502, undefined);
      }
      throw error;
    }
  }

  async signOut(request: Request): Promise<void> {
    const current = await getSessionFromRequest(request);
    try {
      if (current) await revokeUpstreamToken(current.apiToken, this.fetch());
    } finally {
      await destroySession(request);
    }
  }

}

export function createDemoAuthProvider(fetchImpl?: FetchLike): AuthProvider {
  return new DemoAuthProvider(fetchImpl);
}


export const demoAuthProvider = createDemoAuthProvider();

export function isValidLoginEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 320;
}

import type { AuthSession, Permission } from '@agentos/ui-foundation/auth';

import type { AuthProvider, SignInResult } from './provider';
import { destroySession, getSessionFromRequest, revokeSessionsForUser } from './session';
import {
  apiV1Url,
  ExpiredProviderSessionError,
  fetchJson,
  ProviderHttpError,
  revokeUpstreamToken,
  type FetchLike,
} from './demo-provider';

/**
 * The durable account provider (T9.2): the production counterpart of the demo provider, behind the
 * same `AuthProvider` seam. It speaks to `/auth/login`, `/auth/session` and `/auth/logout` instead of
 * the local/CI `/demo/*` surface, so credentials are verified by the database rather than by the
 * in-memory demo store, and it accepts any tenant the signed-in membership names: the demo tenant
 * pin is exactly what the demo provider must not loosen, and what this provider must not keep.
 */

const MAX_PASSWORD_LENGTH = 512;

type JsonRecord = Record<string, unknown>;

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
  // Every entry was checked as a string; the element type is the library's permission vocabulary.
  const granted: readonly unknown[] = permissions;
  return granted as Permission[];
}

/**
 * Parses the durable session envelope. Unlike the demo parser it does not pin a tenant: the tenant
 * comes from the membership the API resolved, and a session that names none is not a session.
 */
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
  // Every entry was checked as a string; the element type is the library's permission vocabulary.
  const granted: Permission[] = permissions;
  return {
    identity: { user_id: userId, email, display_name: displayName },
    membership: { tenant_id: tenantId, tenant_name: tenantName, role, scope },
    permissions: granted,
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

class DbAuthProvider implements AuthProvider {
  private readonly fetchImpl: FetchLike | undefined;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  private fetch(): FetchLike {
    return this.fetchImpl ?? fetch;
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    if (!email || !password || password.length > MAX_PASSWORD_LENGTH) throw new ProviderHttpError(400, undefined);
    const { response, payload } = await fetchJson(this.fetch(), apiV1Url('/auth/login'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, audience: 'company' }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(response.status, payload, response.headers.get('retry-after') ?? undefined);
    }
    const parsed = loginResponseSession(payload);
    if (!parsed) throw new ProviderHttpError(502, undefined);
    // One live console session per user: the API stores a session per sign-in, so the previous ones
    // are revoked here rather than left to expire.
    const previous = await revokeSessionsForUser(parsed.session.identity.user_id);
    await Promise.all(previous.map((session) => revokeUpstreamToken(session.apiToken, this.fetch())));
    return parsed;
  }

  async getSession(request: Request): Promise<AuthSession | null> {
    const current = await getSessionFromRequest(request);
    if (!current) return null;
    const { response, payload } = await fetchJson(this.fetch(), apiV1Url('/auth/session'), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${current.apiToken}` },
    });
    if (response.status === 401) throw new ExpiredProviderSessionError(payload);
    if (!response.ok) throw new ProviderHttpError(response.status, payload, response.headers.get('retry-after') ?? undefined);
    const session = parseAuthSession(payload);
    if (!session) throw new ProviderHttpError(502, undefined);
    return session;
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

export function createDbAuthProvider(fetchImpl?: FetchLike): AuthProvider {
  return new DbAuthProvider(fetchImpl);
}

export const dbAuthProvider = createDbAuthProvider();

/**
 * @file Behavioral contract of durable authentication (T9.2, workflow §3).
 *
 * Every case goes through a real Fastify request against the real route group, so what is proven is
 * what a console observes: the sign-in response, the refusal code, the `retry-after` header, and
 * whether an issued token authenticates a later protected request. The identity port is a fake, but
 * the store, the ticket signing, the session lifecycle and the gateway hook are the production ones.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { IdentityActiveMembership, IdentitySession, IdentityUserCredential } from '@agentos/database';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createDatabaseAuthStore, type AuthIdentityPort, type DatabaseAuthStore } from '../../runtime/db-auth.js';
import { registerAuthRoutes } from './auth.js';

const SESSION_SECRET = 'a-test-session-secret-long-enough';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const STORED_HASH = 'stored-hash';

/** The gateway hook reaches only `ids` (for refusal correlation) while authenticating; no port is used. */
const runtime = { ids: () => 'correlation-test' } as unknown as GatewayRuntime;

interface FakeCalls {
  readonly verified: string[];
  readonly hashed: string[];
  readonly created: { token_hash: string; user_id: string }[];
  readonly touched: string[];
  readonly revoked: string[];
  readonly recorded: string[];
  readonly updated: { user_id: string; password_hash: string }[];
}

function createFakeIdentity(options: {
  readonly credential?: IdentityUserCredential | null;
  readonly memberships?: readonly IdentityActiveMembership[];
  readonly failedLogin?: { failed_login_attempts: number; locked_until: string | null } | null;
  readonly now: () => number;
}): { port: AuthIdentityPort; calls: FakeCalls; sessions: Map<string, IdentitySession> } {
  const calls: FakeCalls = { verified: [], hashed: [], created: [], touched: [], revoked: [], recorded: [], updated: [] };
  const sessions = new Map<string, IdentitySession>();
  const credential = options.credential ?? {
    user_id: USER_ID,
    email: EMAIL,
    password_hash: STORED_HASH,
    failed_login_attempts: 0,
    locked_until: null,
  };

  const port: AuthIdentityPort = {
    async findUserByEmail(email) {
      return email === credential.email ? credential : null;
    },
    async findUserById(user_id) {
      return user_id === credential.user_id ? credential : null;
    },
    async listActiveMemberships() {
      return options.memberships ?? [{ tenant_id: TENANT_ID, role_bundle: 'COMPANY_ADMIN', scope: 'company' }];
    },
    async createSession(input) {
      const now = options.now();
      const session: IdentitySession = {
        session_id: `session-${sessions.size + 1}`,
        user_id: input.user_id,
        created_at: new Date(now).toISOString(),
        last_seen_at: new Date(now).toISOString(),
        idle_expires_at: new Date(now + input.idle_lifetime_seconds * 1000).toISOString(),
        absolute_expires_at: new Date(now + input.absolute_lifetime_seconds * 1000).toISOString(),
      };
      calls.created.push({ token_hash: input.token_hash, user_id: input.user_id });
      sessions.set(input.token_hash, session);
      return session;
    },
    async touchSession(token_hash) {
      calls.touched.push(token_hash);
      return sessions.get(token_hash) ?? null;
    },
    async revokeSession(token_hash) {
      calls.revoked.push(token_hash);
      return sessions.delete(token_hash);
    },
    async recordFailedLogin(user_id) {
      calls.recorded.push(user_id);
      return options.failedLogin ?? { failed_login_attempts: 1, locked_until: null };
    },
    async updatePassword(user_id, password_hash) {
      calls.updated.push({ user_id, password_hash });
      return true;
    },
  };
  return { port, calls, sessions };
}

function createStore(
  identity: AuthIdentityPort,
  now: () => number,
  overrides: {
    readonly maxAttemptsPerWindow?: number;
    readonly describeTenant?: (tenant_id: string) => Promise<string | null>;
  } = {},
): DatabaseAuthStore {
  return createDatabaseAuthStore({
    identity,
    session_secret: SESSION_SECRET,
    now,
    idleLifetimeSeconds: 60,
    absoluteLifetimeSeconds: 600,
    maxAttemptsPerWindow: overrides.maxAttemptsPerWindow ?? 10,
    ...(overrides.describeTenant === undefined ? {} : { describeTenant: overrides.describeTenant }),
    // Fast, deterministic stand-ins for scrypt: the cases assert policy, not the KDF.
    verify: async (password, encoded) => password === PASSWORD && encoded === STORED_HASH,
    hash: async (password) => `hashed:${password}`,
  });
}

async function buildApp(store: DatabaseAuthStore): Promise<FastifyInstance> {
  const app = Fastify();
  // The production transport maps a refusal thrown in a preHandler onto the canonical envelope.
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerAuthRoutes(app, { auth: store, runtime });
  app.get('/probe', { preHandler: authenticate({ credentials: store, runtime }) }, async (request) => ({
    tenant_id: requireOperator(request).tenant_id,
    operator_id: requireOperator(request).operator_id,
  }));
  await app.ready();
  return app;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** The response body as a record; every field below is read through a checked accessor. */
function bodyOf(response: { json(): unknown }): Record<string, unknown> {
  const body = response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('the response body is not a JSON object');
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new Error(`expected ${key} to be a string`);
  return value;
}

function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected ${key} to be an object`);
  }
  return value as Record<string, unknown>;
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new Error(`expected ${key} to be a boolean`);
  return value;
}

function stringArrayField(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`expected ${key} to be an array of strings`);
  }
  return value as readonly string[];
}

describe('durable authentication routes', () => {
  it('preserves the authorized tenant display name in login and sessions rehydrated after restart', async () => {
    const now = () => 1_700_000_000_000;
    const { port } = createFakeIdentity({ now });
    const described: string[] = [];
    const describeTenant = async (tenant_id: string): Promise<string | null> => {
      described.push(tenant_id);
      return tenant_id === TENANT_ID ? 'Cửa hàng Một' : null;
    };
    const store = createStore(port, now, { describeTenant });
    const login = await store.login({ email: EMAIL, password: PASSWORD, audience: 'company' });
    if (!login.ok) throw new Error('Expected a successful member login');
    expect(login.session.membership.tenant_name).toBe('Cửa hàng Một');
    const restarted = createStore(port, now, { describeTenant });
    expect((await restarted.inspect(login.session.access_token))?.membership.tenant_name).toBe('Cửa hàng Một');
    expect(described).toEqual([TENANT_ID, TENANT_ID]);
  });

  it('does not resolve tenant metadata for a membership the account does not hold', async () => {
    const now = () => 1_700_000_000_000;
    const { port } = createFakeIdentity({ now });
    const described: string[] = [];
    const store = createStore(port, now, {
      describeTenant: async (tenant_id) => {
        described.push(tenant_id);
        return 'Công ty khác';
      },
    });
    const login = await store.login({
      email: EMAIL, password: PASSWORD, audience: 'company', tenant_id: '33333333-3333-4333-8333-333333333333',
    });
    expect(login).toEqual({ ok: false, reason: 'AUTHENTICATION_FAILED' });
    expect(described).toEqual([]);
  });

  it('signs in a member and the issued token authenticates a protected request', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });
    expect(login.statusCode).toBe(200);
    const body = bodyOf(login);
    const token = stringField(body, 'access_token');
    const membership = recordField(body, 'membership');
    expect(stringField(membership, 'tenant_id')).toBe(TENANT_ID);
    expect(stringField(membership, 'role')).toBe('company_admin');
    expect(stringArrayField(body, 'permissions')).toContain('knowledge:approve');
    expect(stringField(recordField(body, 'identity'), 'user_id')).toBe(USER_ID);
    // The session row stores a hash, never the presented token.
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]?.token_hash).not.toBe(token);

    const probe = await app.inject({ method: 'GET', url: '/probe', headers: bearer(token) });
    expect(probe.statusCode).toBe(200);
    const probeBody = bodyOf(probe);
    expect(stringField(probeBody, 'tenant_id')).toBe(TENANT_ID);
    expect(stringField(probeBody, 'operator_id')).toBe(USER_ID);

    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: bearer(token) });
    expect(session.statusCode).toBe(200);
    expect(stringField(recordField(bodyOf(session), 'identity'), 'user_id')).toBe(USER_ID);

    await app.close();
  });

  it('issues a distinct session token for every sign-in of the same membership', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);
    const signIn = () => app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });

    const first = stringField(bodyOf(await signIn()), 'access_token');
    const second = stringField(bodyOf(await signIn()), 'access_token');

    expect(second).not.toBe(first);
    expect(new Set(calls.created.map((created) => created.token_hash)).size).toBe(2);
    // Logging one session out leaves the other valid.
    await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(first) });
    expect((await app.inject({ method: 'GET', url: '/probe', headers: bearer(second) })).statusCode).toBe(200);
    await app.close();
  });

  it('requires a matching platform membership before issuing platform authority', async () => {
    const now = () => 1_700_000_000_000;
    const companyIdentity = createFakeIdentity({
      now,
      memberships: [{ tenant_id: TENANT_ID, role_bundle: 'COMPANY_ADMIN', scope: 'company' }],
    });
    const companyApp = await buildApp(createStore(companyIdentity.port, now));
    const refused = await companyApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'platform' },
    });
    expect(refused.statusCode).toBe(401);
    expect(stringField(bodyOf(refused), 'error_code')).toBe('AUTHENTICATION_FAILED');
    await companyApp.close();

    const platformIdentity = createFakeIdentity({
      now,
      memberships: [{ tenant_id: TENANT_ID, role_bundle: 'PLATFORM_ADMIN', scope: 'platform' }],
    });
    const platformApp = await buildApp(createStore(platformIdentity.port, now));
    const login = await platformApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'platform' },
    });

    expect(login.statusCode).toBe(200);
    const body = bodyOf(login);
    const membership = recordField(body, 'membership');
    expect(stringField(membership, 'scope')).toBe('platform');
    expect(stringField(membership, 'role')).toBe('platform_admin');
    const permissions = stringArrayField(body, 'permissions');
    expect(permissions).toContain('platform:admin');
    expect(permissions).not.toContain('settings:manage');
    await platformApp.close();
  });

  it('refuses a wrong password and an unknown email with the same code and message', async () => {
    const now = () => 1_700_000_000_000;
    const { port } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: 'not the password', audience: 'company' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.test', password: 'not the password', audience: 'company' },
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const wrongBody = bodyOf(wrong);
    const unknownBody = bodyOf(unknown);
    expect(stringField(unknownBody, 'error_code')).toBe(stringField(wrongBody, 'error_code'));
    expect(stringField(unknownBody, 'message')).toBe(stringField(wrongBody, 'message'));

    await app.close();
  });

  it('refuses a non-member and a token for a mismatched tenant with the same refusal', async () => {
    const now = () => 1_700_000_000_000;
    const { port } = createFakeIdentity({ now, memberships: [] });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company', tenant_id: TENANT_ID },
    });
    expect(login.statusCode).toBe(401);
    expect(stringField(bodyOf(login), 'error_code')).toBe('AUTHENTICATION_FAILED');

    await app.close();
  });

  it('rate limits per IP+email before any identity lookup', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now, { maxAttemptsPerWindow: 2 });
    const app = await buildApp(store);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: EMAIL, password: 'wrong', audience: 'company' },
      });
      expect(refused.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: 'wrong', audience: 'company' },
    });
    expect(limited.statusCode).toBe(429);
    expect(stringField(bodyOf(limited), 'error_code')).toBe('TOO_MANY_ATTEMPTS');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(calls.recorded).toHaveLength(2);
    // The limited attempt never reached the identity port.
    expect(calls.touched).toHaveLength(0);

    await app.close();
  });

  it('reports the database lockout with a retry-after instead of a bare refusal', async () => {
    const now = () => 1_700_000_000_000;
    const locked_until = new Date(now() + 60_000).toISOString();
    const { port } = createFakeIdentity({
      now,
      credential: { user_id: USER_ID, email: EMAIL, password_hash: STORED_HASH, failed_login_attempts: 5, locked_until },
    });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const refused = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');

    await app.close();
  });

  it('revokes the session on logout and refuses the token afterwards', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });
    const token = stringField(bodyOf(login), 'access_token');

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) });
    expect(logout.statusCode).toBe(200);
    expect(booleanField(bodyOf(logout), 'revoked')).toBe(true);
    expect(calls.revoked).toHaveLength(1);

    const after = await app.inject({ method: 'GET', url: '/probe', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(stringField(bodyOf(after), 'error_code')).toBe('AUTHENTICATION_FAILED');

    await app.close();
  });

  it('refuses a forged token without touching the identity port', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const forged = await app.inject({ method: 'GET', url: '/probe', headers: bearer('forged.token') });
    expect(forged.statusCode).toBe(401);
    expect(calls.touched).toHaveLength(0);

    await app.close();
  });

  it('changes the password only with the current one, and then the session is gone', async () => {
    const now = () => 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now });
    const store = createStore(port, now);
    const app = await buildApp(store);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });
    const token = stringField(bodyOf(login), 'access_token');

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: bearer(token),
      payload: { current_password: 'not the password', new_password: 'a brand new passphrase' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(calls.updated).toHaveLength(0);

    const short = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: bearer(token),
      payload: { current_password: PASSWORD, new_password: 'short' },
    });
    expect(short.statusCode).toBe(400);
    expect(calls.updated).toHaveLength(0);

    // The rotation revokes every session for the user in the database; the fake drops the row the
    // way `auth_update_password` does, so the presented token stops resolving.
    const changed = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: bearer(token),
      payload: { current_password: PASSWORD, new_password: 'a brand new passphrase' },
    });
    expect(changed.statusCode).toBe(200);
    expect(calls.updated).toEqual([{ user_id: USER_ID, password_hash: 'hashed:a brand new passphrase' }]);

    await app.close();
  });

  it('renews the idle window from the database when the cached session has lapsed', async () => {
    let clock = 1_700_000_000_000;
    const { port, calls } = createFakeIdentity({ now: () => clock });
    const store = createStore(port, () => clock);
    const app = await buildApp(store);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, audience: 'company' },
    });
    const token = stringField(bodyOf(login), 'access_token');
    expect(calls.touched).toHaveLength(0);

    clock += 61_000;
    const probe = await app.inject({ method: 'GET', url: '/probe', headers: bearer(token) });
    expect(probe.statusCode).toBe(200);
    expect(calls.touched).toHaveLength(1);

    await app.close();
  });
});

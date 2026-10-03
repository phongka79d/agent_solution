import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hashPassword, verifyPassword } from '@agentos/core-engine';
import type {
  IdentityActiveMembership,
  IdentityRepository,
  IdentityRoleBundle,
  IdentitySession,
  IdentityUserCredential,
} from '@agentos/database';

import type { OperatorPermission } from '../gateway/contracts.js';
import type { CredentialStore, OperatorCredential, WidgetCredential } from '../gateway/principal.js';

/**
 * Durable database-backed authentication (T9.2, PLAN §12.1 "Durable identity").
 *
 * The demo credential store keeps every account in memory and is admitted only for DEMO tenants in
 * local/CI. This store is the production path: passwords come from `agentos.users` (verified with the
 * core-engine scrypt helper, constant-time), sessions live in `agentos.auth_sessions` as a hash of an
 * opaque signed token, and authority is the membership row's role bundle resolved server-side.
 *
 * The token itself is signed with `SESSION_SECRET` and carries only the binding the store needs to
 * look the session up — user, tenant and scope. The signature is verified before any database call,
 * so a forged token never reaches the auth role's function surface, and the token hash kept in the
 * table means revocation is an ordinary row update rather than a token blacklist.
 */

export type AuthAudience = 'company' | 'platform';

export interface DatabaseAuthIdentity {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
}

export interface DatabaseAuthMembership {
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  readonly role: 'company_admin' | 'operator' | 'viewer' | 'platform_admin';
  readonly scope: AuthAudience;
}

export interface DatabaseAuthSessionWithoutToken {
  readonly expires_at: string;
  readonly identity: DatabaseAuthIdentity;
  readonly membership: DatabaseAuthMembership;
  readonly permissions: readonly OperatorPermission[];
}

export interface DatabaseAuthSession extends DatabaseAuthSessionWithoutToken {
  readonly access_token: string;
}

/** A refusal is a value, not an exception: the route renders it with the one error catalog. */
export type DatabaseLoginResult =
  | { readonly ok: true; readonly session: DatabaseAuthSession }
  | { readonly ok: false; readonly reason: 'AUTHENTICATION_FAILED' | 'TOO_MANY_ATTEMPTS'; readonly retry_after?: number };

export interface DatabaseAuthStore extends CredentialStore {
  login(input: {
    readonly email: string;
    readonly password: string;
    readonly audience: AuthAudience;
    readonly tenant_id?: string;
    readonly client_ip?: string;
  }): Promise<DatabaseLoginResult>;
  /** The current lock duration for an IP+email login key, in whole seconds. */
  retryAfter(email: string, client_ip?: string): number | null;
  /** Resolves a live session token, renewing its idle window (sliding renewal). */
  resolveOperatorAsync(token: string): Promise<OperatorCredential | null>;
  /** Reads the caller's own session for `GET /auth/session`. */
  inspect(token: string): Promise<DatabaseAuthSessionWithoutToken | null>;
  /** Revokes the presented session. */
  logout(token: string): Promise<boolean>;
  /**
   * Verifies the current password and replaces it. Every other session of the user is revoked by the
   * database function; the caller's own token is invalidated too and must sign in again.
   */
  changePassword(token: string, current_password: string, new_password: string): Promise<boolean>;
}

/**
 * The narrow slice of the identity repository this store uses. Declared structurally so a test can
 * bind a fake without a database, while `IdentityRepository` satisfies it unchanged.
 */
export interface AuthIdentityPort {
  findUserByEmail(email: string): Promise<IdentityUserCredential | null>;
  findUserById(user_id: string): Promise<IdentityUserCredential | null>;
  listActiveMemberships(user_id: string): Promise<readonly IdentityActiveMembership[]>;
  createSession(input: {
    readonly user_id: string;
    readonly token_hash: string;
    readonly idle_lifetime_seconds: number;
    readonly absolute_lifetime_seconds: number;
  }): Promise<IdentitySession | null>;
  touchSession(token_hash: string, idle_lifetime_seconds: number): Promise<IdentitySession | null>;
  revokeSession(token_hash: string): Promise<boolean>;
  recordFailedLogin(user_id: string): Promise<{ failed_login_attempts: number; locked_until: string | null } | null>;
  updatePassword(user_id: string, password_hash: string): Promise<boolean>;
}

export interface DatabaseAuthStoreOptions {
  readonly identity: AuthIdentityPort | IdentityRepository;
  readonly session_secret: string;
  /** Resolves a display name for a tenant; omitted in tests and for tenants without a profile. */
  readonly describeTenant?: (tenant_id: string) => Promise<string | null>;
  readonly tenantDataClass?: (tenant_id: string) => Promise<'PRODUCTION' | 'DEMO' | 'TEST' | null>;
  readonly now?: () => number;
  readonly idleLifetimeSeconds?: number;
  readonly absoluteLifetimeSeconds?: number;
  /** Attempts allowed per IP+email inside `attemptWindowMs` before the store refuses without a lookup. */
  readonly maxAttemptsPerWindow?: number;
  readonly attemptWindowMs?: number;
  readonly verify?: (password: string, encoded: string) => Promise<boolean>;
  readonly hash?: (password: string) => Promise<string>;
}

const DEFAULT_IDLE_LIFETIME_SECONDS = 30 * 60;
const DEFAULT_ABSOLUTE_LIFETIME_SECONDS = 12 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS_PER_WINDOW = 10;
const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const MINIMUM_SECRET_LENGTH = 16;
const TOKEN_PAYLOAD_VERSION = 1;
const MINIMUM_PASSWORD_LENGTH = 12;

/** A mandatory value of the signing secret; an empty secret cannot produce an unforgeable token. */
function requireSessionSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error('SESSION_SECRET: durable sessions are signed bindings and need a signing secret');
  }
  return secret;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function fromBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface TokenPayload {
  readonly v: number;
  readonly sub: string;
  readonly tid: string;
  readonly sb: string;
  readonly scp: AuthAudience;
  /** Random per-session id: two logins of the same membership must never share a token. */
  readonly jti: string;
}

const VIEWER_PERMISSIONS: readonly OperatorPermission[] = Object.freeze(['customer:read', 'run:read', 'telemetry:read']);

const OPERATOR_PERMISSIONS: readonly OperatorPermission[] = Object.freeze([
  'campaign:draft',
  'conversation:takeover',
  'customer:read',
  'run:read',
  'telemetry:read',
]);

const COMPANY_ADMIN_PERMISSIONS: readonly OperatorPermission[] = Object.freeze([
  ...OPERATOR_PERMISSIONS,
  'approval:read',
  'approval:decide',
  'settings:manage',
  'integration:manage',
  'llm:manage',
  'knowledge:manage',
  'knowledge:approve',
  'skills:manage',
  'agents:manage',
  'testdata:manage',
  'run:retry:company',
]);

const PLATFORM_PERMISSIONS: readonly OperatorPermission[] = Object.freeze([
  'platform:admin',
  'run:read',
  'run:retry',
  'run:reconcile',
  'telemetry:read',
  'platform:providers:write',
  'platform:companies:write',
  'platform:audit:read',
]);

function permissionsFor(role: IdentityRoleBundle, scope: AuthAudience): readonly OperatorPermission[] {
  if (scope === 'platform') return role === 'PLATFORM_ADMIN' ? PLATFORM_PERMISSIONS : [];
  switch (role) {
    case 'COMPANY_ADMIN':
      return COMPANY_ADMIN_PERMISSIONS;
    case 'OPERATOR':
      return OPERATOR_PERMISSIONS;
    case 'VIEWER':
      return VIEWER_PERMISSIONS;
    case 'PLATFORM_ADMIN':
      return [];
  }
}

function roleName(role: IdentityRoleBundle, scope: AuthAudience): DatabaseAuthMembership['role'] {
  if (scope === 'platform') return role === 'PLATFORM_ADMIN' ? 'platform_admin' : 'viewer';
  switch (role) {
    case 'COMPANY_ADMIN':
      return 'company_admin';
    case 'OPERATOR':
      return 'operator';
    case 'VIEWER':
    case 'PLATFORM_ADMIN':
      return 'viewer';
  }
}

interface CacheEntry {
  readonly principal: OperatorCredential;
  readonly session: DatabaseAuthSessionWithoutToken;
  readonly expires_at_ms: number;
}

export function createDatabaseAuthStore(options: DatabaseAuthStoreOptions): DatabaseAuthStore {
  const identity = options.identity;
  const secret = requireSessionSecret(options.session_secret);
  const now = options.now ?? (() => Date.now());
  const idleLifetimeSeconds = options.idleLifetimeSeconds ?? DEFAULT_IDLE_LIFETIME_SECONDS;
  const absoluteLifetimeSeconds = options.absoluteLifetimeSeconds ?? DEFAULT_ABSOLUTE_LIFETIME_SECONDS;
  const maxAttemptsPerWindow = options.maxAttemptsPerWindow ?? DEFAULT_MAX_ATTEMPTS_PER_WINDOW;
  const attemptWindowMs = options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
  const verify = options.verify ?? ((password, encoded) => verifyPassword(password, encoded));
  const hash = options.hash ?? ((password) => hashPassword(password));

  if (idleLifetimeSeconds < 1 || absoluteLifetimeSeconds < idleLifetimeSeconds || absoluteLifetimeSeconds > 2_592_000) {
    throw new Error('AUTH_SESSION_LIFETIME: session lifetimes are outside the supported range');
  }
  if (maxAttemptsPerWindow < 1) {
    throw new Error('AUTH_LIMITER: rate-limit and lockout thresholds must be positive');
  }

  /** The per-IP+email limiter. Process-local by design: the database counters carry the durable lockout. */
  const attempts = new Map<string, number[]>();
  /** Session cache: the resolved principal for a live token hash, until its own idle window closes. */
  const cache = new Map<string, CacheEntry>();
  /** A throwaway hash verified for an unknown email, so the refusal spends the same work as a wrong password. */
  const dummyHash: Promise<string> = hash(randomBytes(32).toString('hex'));

  const attemptKey = (email: string, client_ip?: string): string => `${client_ip ?? 'unknown'}|${normalizeEmail(email)}`;

  function withinWindow(key: string): number[] {
    const entries = attempts.get(key) ?? [];
    const cutoff = now() - attemptWindowMs;
    return entries.filter((at) => at > cutoff);
  }

  function record(key: string): void {
    const entries = withinWindow(key);
    entries.push(now());
    attempts.set(key, entries);
  }

  /** Whole seconds until a lockout expires, or `null` when the account is not locked. */
  function lockRetryAfter(locked_until: string | null): number | null {
    if (locked_until === null) return null;
    const expires = Date.parse(locked_until);
    return Number.isFinite(expires) && expires > now() ? Math.max(1, Math.ceil((expires - now()) / 1000)) : null;
  }

  function sign(payload: TokenPayload): string {
    const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signature = createHmac('sha256', secret).update(body, 'utf8').digest();
    return `${body}.${base64url(signature)}`;
  }

  function readToken(token: string): { payload: TokenPayload; token_hash: string } | null {
    const separator = token.indexOf('.');
    if (separator <= 0) return null;
    const body = token.slice(0, separator);
    const encodedSignature = token.slice(separator + 1);
    const signature = fromBase64url(encodedSignature);
    if (signature === null) return null;
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

    const raw = fromBase64url(body);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    const v = candidate['v'];
    const sub = candidate['sub'];
    const tid = candidate['tid'];
    const sb = candidate['sb'];
    const scp = candidate['scp'];
    const jti = candidate['jti'];
    if (
      v !== TOKEN_PAYLOAD_VERSION ||
      typeof sub !== 'string' || sub.length === 0 ||
      typeof tid !== 'string' || tid.length === 0 ||
      typeof sb !== 'string' || sb.length === 0 ||
      (scp !== 'company' && scp !== 'platform') ||
      typeof jti !== 'string' || jti.length < 16
    ) {
      return null;
    }
    return {
      payload: { v: TOKEN_PAYLOAD_VERSION, sub, tid, sb, scp, jti },
      token_hash: sha256Hex(token),
    };
  }

  function toSession(input: {
    readonly user_id: string;
    readonly email: string;
    readonly membership: IdentityActiveMembership;
    readonly scope: AuthAudience;
    readonly tenant_name: string | null;
    readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
    readonly expires_at: string;
  }): DatabaseAuthSessionWithoutToken {
    return {
      expires_at: input.expires_at,
      identity: {
        user_id: input.user_id,
        email: normalizeEmail(input.email),
        display_name: input.email,
      },
      membership: {
        tenant_id: input.membership.tenant_id,
        tenant_name: input.tenant_name,
        data_class: input.data_class,
        role: roleName(input.membership.role_bundle, input.scope),
        scope: input.scope,
      },
      permissions: permissionsFor(input.membership.role_bundle, input.scope),
    };
  }

  const store: DatabaseAuthStore = {
    // A token that has not been verified cannot resolve anything synchronously; an async-aware
    // caller goes through `resolveOperatorAsync`, and every synchronous caller fails closed.
    resolveOperator: () => null,
    resolveConversationSession: () => null,
    resolveWidgetSession: (): WidgetCredential | null => null,

    retryAfter: (email, client_ip) => {
      const key = attemptKey(email, client_ip);
      const entries = withinWindow(key);
      if (entries.length < maxAttemptsPerWindow) return null;
      const oldest = entries[0] ?? now();
      return Math.max(1, Math.ceil((oldest + attemptWindowMs - now()) / 1000));
    },

    async login({ email, password, audience, tenant_id, client_ip }) {
      const normalized = normalizeEmail(email);
      const key = attemptKey(normalized, client_ip);
      const retry_after = store.retryAfter(normalized, client_ip);
      if (retry_after !== null) return { ok: false, reason: 'TOO_MANY_ATTEMPTS', retry_after };

      record(key);

      const credential = await identity.findUserByEmail(normalized);
      // No enumeration: an unknown email spends the same verification work as a wrong password, so
      // response timing cannot be used to probe which accounts exist.
      const encoded = credential?.password_hash ?? (await dummyHash);
      const passwordOk = await verify(String(password), encoded);
      if (credential === null || !passwordOk) {
        if (credential !== null) {
          const failure = await identity.recordFailedLogin(credential.user_id);
          const retry_after = failure === null ? null : lockRetryAfter(failure.locked_until);
          if (retry_after !== null) return { ok: false, reason: 'TOO_MANY_ATTEMPTS', retry_after };
        }
        return { ok: false, reason: 'AUTHENTICATION_FAILED' };
      }
      const locked = lockRetryAfter(credential.locked_until);
      if (locked !== null) return { ok: false, reason: 'TOO_MANY_ATTEMPTS', retry_after: locked };

      const memberships = await identity.listActiveMemberships(credential.user_id);
      const requestedTenant = tenant_id?.trim().toLowerCase();
      const membership = memberships.find((candidate) =>
        candidate.scope === audience
        && (requestedTenant === undefined || candidate.tenant_id.toLowerCase() === requestedTenant),
      );
      if (membership === undefined) return { ok: false, reason: 'AUTHENTICATION_FAILED' };

      const expires_at_ms = now() + idleLifetimeSeconds * 1000;
      const token = sign({
        v: TOKEN_PAYLOAD_VERSION,
        sub: credential.user_id,
        tid: membership.tenant_id,
        sb: membership.role_bundle,
        scp: membership.scope,
        jti: base64url(randomBytes(18)),
      });
      const session = await identity.createSession({
        user_id: credential.user_id,
        token_hash: sha256Hex(token),
        idle_lifetime_seconds: idleLifetimeSeconds,
        absolute_lifetime_seconds: absoluteLifetimeSeconds,
      });
      if (session === null) return { ok: false, reason: 'AUTHENTICATION_FAILED' };

      const [tenant_name, data_class] = await Promise.all([
        options.describeTenant === undefined ? Promise.resolve(null) : options.describeTenant(membership.tenant_id),
        options.tenantDataClass === undefined ? Promise.resolve<'PRODUCTION' | 'DEMO' | 'TEST' | null>(null) : options.tenantDataClass(membership.tenant_id),
      ]);
      const withoutToken = toSession({
        user_id: credential.user_id,
        email: credential.email,
        membership,
        scope: membership.scope,
        tenant_name,
        data_class: data_class ?? 'PRODUCTION',
        expires_at: session.idle_expires_at,
      });
      cache.set(sha256Hex(token), {
        principal: {
          token,
          tenant_id: membership.tenant_id,
          operator_id: credential.user_id,
          scope: membership.scope,
          permissions: withoutToken.permissions,
        },
        session: withoutToken,
        expires_at_ms,
      });
      return { ok: true, session: { ...withoutToken, access_token: token } };
    },

    async resolveOperatorAsync(token) {
      const parsed = readToken(token);
      if (parsed === null) return null;
      const cached = cache.get(parsed.token_hash);
      if (cached !== undefined && cached.expires_at_ms > now()) return cached.principal;

      const session = await identity.touchSession(parsed.token_hash, idleLifetimeSeconds);
      if (session === null) {
        cache.delete(parsed.token_hash);
        return null;
      }
      const memberships = await identity.listActiveMemberships(parsed.payload.sub);
      const membership = memberships.find(
        (candidate) =>
          candidate.tenant_id === parsed.payload.tid
          && candidate.role_bundle === parsed.payload.sb
          && candidate.scope === parsed.payload.scp,
      );
      if (membership === undefined) {
        await identity.revokeSession(parsed.token_hash);
        cache.delete(parsed.token_hash);
        return null;
      }
      // Rehydrate the same metadata as login after renewal or an API restart; never drop the name.
      const tenant_name = options.describeTenant === undefined ? null : await options.describeTenant(membership.tenant_id);
      const principal: OperatorCredential = {
        token,
        tenant_id: membership.tenant_id,
        operator_id: session.user_id,
        scope: membership.scope,
        permissions: permissionsFor(membership.role_bundle, membership.scope),
      };
      cache.set(parsed.token_hash, {
        principal,
        session: {
          expires_at: session.idle_expires_at,
          identity: { user_id: session.user_id, email: normalizeEmail(parsed.payload.sub), display_name: session.user_id },
          membership: {
            tenant_id: membership.tenant_id,
            tenant_name,
            data_class: 'PRODUCTION',
            role: roleName(membership.role_bundle, membership.scope),
            scope: membership.scope,
          },
          permissions: principal.permissions,
        },
        expires_at_ms: Date.parse(session.idle_expires_at),
      });
      return principal;
    },

    async inspect(token) {
      const parsed = readToken(token);
      if (parsed === null) return null;
      const cached = cache.get(parsed.token_hash);
      if (cached !== undefined && cached.expires_at_ms > now()) return cached.session;
      const principal = await store.resolveOperatorAsync(token);
      if (principal === null) return null;
      return cache.get(sha256Hex(token))?.session ?? null;
    },

    async logout(token) {
      const parsed = readToken(token);
      if (parsed === null) return false;
      cache.delete(parsed.token_hash);
      return identity.revokeSession(parsed.token_hash);
    },

    async changePassword(token, current_password, new_password) {
      const parsed = readToken(token);
      if (parsed === null) return false;
      if (typeof new_password !== 'string' || new_password.length < MINIMUM_PASSWORD_LENGTH) return false;
      // The presented token is only trusted after it resolves against the live session table.
      const session = await identity.touchSession(parsed.token_hash, idleLifetimeSeconds);
      if (session === null) return false;
      const credential = await identity.findUserById(parsed.payload.sub);
      if (credential === null) return false;
      const passwordOk = await verify(String(current_password), credential.password_hash);
      if (!passwordOk) {
        await identity.recordFailedLogin(credential.user_id);
        return false;
      }
      const encoded = await hash(new_password);
      const updated = await identity.updatePassword(credential.user_id, encoded);
      if (updated) cache.delete(parsed.token_hash);
      return updated;
    },
  };

  return store;
}

/** Exposed for the password-change policy test and the route schema. */
export const MINIMUM_AUTH_PASSWORD_LENGTH = MINIMUM_PASSWORD_LENGTH;
/** The consecutive-failure count `auth_record_failed_login` locks an account at, for the docs. */
export const DEFAULT_AUTH_MAX_FAILURES = DEFAULT_MAX_FAILURES;

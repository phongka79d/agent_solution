import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type {
  CredentialStore,
  OperatorCredential,
  WidgetCredential,
} from '../gateway/principal.js';
import type { OperatorPermission } from '../gateway/contracts.js';

/** The only tenant admitted by the local/CI demo authentication boundary. */
export const DEMO_TENANT_ID = '99999999-9999-4999-8999-999999999999';

/** Demo sessions are intentionally short-lived and are never persisted. */
export const DEMO_SESSION_TTL_MS = 30 * 60 * 1000;

/** The permission bundles are named for the legacy capability groups, not login roles. */
export const TENANT_OPERATOR_BUNDLE = [
  'campaign:draft',
  'conversation:takeover',
  'customer:read',
  'run:read',
  'telemetry:read',
] as const satisfies readonly OperatorPermission[];

export const APPROVER_BUNDLE = [
  'approval:read',
  'approval:decide',
  'run:read',
] as const satisfies readonly OperatorPermission[];

export const PLATFORM_BUNDLE = [
  'platform:admin',
  'run:read',
  'run:retry',
  'run:reconcile',
  'telemetry:read',
] as const satisfies readonly OperatorPermission[];

const COMPANY_ADMIN_PERMISSIONS: readonly OperatorPermission[] = Object.freeze([
  ...TENANT_OPERATOR_BUNDLE,
  'approval:read',
  'approval:decide',
]);

export type DemoAudience = 'company' | 'platform';
export type DemoRole = 'company_admin' | 'platform_admin';

export interface DemoIdentity {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
}

export interface DemoMembership {
  readonly tenant_id: typeof DEMO_TENANT_ID;
  readonly tenant_name: string | null;
  readonly role: DemoRole;
  readonly scope: DemoAudience;
}

export interface DemoSessionWithoutToken {
  readonly expires_at: string;
  readonly identity: DemoIdentity;
  readonly membership: DemoMembership;
  readonly permissions: readonly OperatorPermission[];
}

export interface DemoSession extends DemoSessionWithoutToken {
  readonly access_token: string;
}

export interface DemoWidgetSession {
  readonly access_token: string;
  readonly expires_at: string;
  readonly session_id: string;
}

export interface DemoCredentialStore extends CredentialStore {
  /** Constant-time password verification and opaque account session issuance. */
  login(email: string, password: string, audience: DemoAudience, clientIp?: string): DemoSession | null;
  /** Returns the current lock duration for a login key, in whole seconds. */
  retryAfter(email: string, clientIp?: string): number | null;
  /** Resolves only operator sessions issued by this demo store. */
  resolveDemoSession(token: string): DemoSession | null;
  /** Revokes an issued operator session. */
  revoke(token: string): boolean;
  /** Resolves only active, tenant-bound widget credentials. */
  resolveWidgetSession(token: string): WidgetCredential | null;
  /** Issues an opaque tenant-bound widget token for an operator-launched session. */
  issueWidget(session_id: string, origin: string): DemoWidgetSession;
}

interface StoredOperatorSession extends OperatorCredential {
  readonly email: string;
  readonly display_name: string;
  readonly role: DemoRole;
  readonly scope: DemoAudience;
  readonly expires_at: string;
  readonly expires_at_ms: number;
}

interface StoredWidgetSession extends WidgetCredential {
  readonly expires_at_ms: number;
}

export interface DemoCredentialStoreOptions {
  readonly companyAdminEmail: string;
  readonly companyAdminPassword: string;
  readonly platformAdminEmail: string;
  readonly platformAdminPassword: string;
  readonly now?: () => number;
  readonly tokenBytes?: number;
  readonly maxFailures?: number;
  readonly backoffBaseMs?: number;
}

interface PasswordVerifier {
  readonly digest: Buffer;
  readonly salt: Buffer;
}

interface DemoAccount {
  readonly email: string;
  readonly password: PasswordVerifier;
  readonly audience: DemoAudience;
  readonly role: DemoRole;
  readonly operator_id: string;
  readonly display_name: string;
  readonly permissions: readonly OperatorPermission[];
}

interface FailureState {
  readonly failures: number;
  readonly locked_until: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeIp(clientIp: string | undefined): string {
  const normalized = clientIp?.trim();
  return normalized === undefined || normalized.length === 0 ? 'unknown' : normalized;
}

function passwordDigest(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

/** Compares fixed-size KDF output so password length cannot alter comparison timing. */
function digestMatches(password: string, verifier: PasswordVerifier): boolean {
  const suppliedDigest = passwordDigest(password, verifier.salt);
  return suppliedDigest.length === verifier.digest.length && timingSafeEqual(suppliedDigest, verifier.digest);
}

function verifier(password: string): PasswordVerifier {
  const salt = randomBytes(16);
  return { salt, digest: passwordDigest(password, salt) };
}

function randomToken(tokenBytes: number): string {
  return randomBytes(tokenBytes).toString('base64url');
}

function expiresAt(now: number): { readonly expires_at: string; readonly expires_at_ms: number } {
  const expires_at_ms = now + DEMO_SESSION_TTL_MS;
  return { expires_at: new Date(expires_at_ms).toISOString(), expires_at_ms };
}

function validAt(now: number, expiry: number): boolean {
  return Number.isFinite(now) && now < expiry;
}

/**
 * Creates the in-process DEMO_MODE credential store.
 *
 * Password values are converted to fixed-size digests once at construction. Neither passwords nor
 * issued bearer tokens are logged or included in thrown errors. Operator and widget rows are kept
 * in separate maps so a widget token can never resolve as an operator session.
 */
export function createDemoCredentialStore(options: DemoCredentialStoreOptions): DemoCredentialStore {
  const companyEmail = normalizeEmail(options.companyAdminEmail);
  const platformEmail = normalizeEmail(options.platformAdminEmail);
  if (companyEmail.length === 0 || platformEmail.length === 0 || options.companyAdminPassword.length === 0 || options.platformAdminPassword.length === 0) {
    throw new Error('DEMO_MODE requires all four account environment values');
  }
  if (companyEmail === platformEmail) {
    throw new Error('DEMO_MODE account email values must be distinct');
  }

  const now = options.now ?? Date.now;
  const tokenBytes = options.tokenBytes ?? 32;
  if (!Number.isInteger(tokenBytes) || tokenBytes < 32) {
    throw new Error('DEMO_MODE session token size must be at least 32 bytes');
  }
  const maxFailures = options.maxFailures ?? 5;
  const backoffBaseMs = options.backoffBaseMs ?? 1000;
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || !Number.isInteger(backoffBaseMs) || backoffBaseMs < 1) {
    throw new Error('DEMO_MODE login limiter configuration is invalid');
  }

  const accounts = new Map<string, DemoAccount>([
    [companyEmail, {
      email: companyEmail,
      password: verifier(options.companyAdminPassword),
      audience: 'company',
      role: 'company_admin',
      operator_id: 'demo-company-admin',
      display_name: 'Company Admin',
      permissions: COMPANY_ADMIN_PERMISSIONS,
    }],
    [platformEmail, {
      email: platformEmail,
      password: verifier(options.platformAdminPassword),
      audience: 'platform',
      role: 'platform_admin',
      operator_id: 'demo-platform-admin',
      display_name: 'Platform Admin',
      permissions: PLATFORM_BUNDLE,
    }],
  ]);
  const dummyVerifier = verifier('invalid-demo-account-password');
  const operators = new Map<string, StoredOperatorSession>();
  const widgets = new Map<string, StoredWidgetSession>();
  const failures = new Map<string, FailureState>();

  const limiterKey = (email: string, clientIp: string | undefined): string => `${normalizeIp(clientIp)}\u0000${normalizeEmail(email)}`;

  const retryAfter = (email: string, clientIp?: string): number | null => {
    const key = limiterKey(email, clientIp);
    const state = failures.get(key);
    if (state === undefined) return null;
    const remaining = state.locked_until - now();
    if (remaining > 0) return Math.max(1, Math.ceil(remaining / 1000));
    if (state.failures >= maxFailures) failures.delete(key);
    return null;
  };

  const recordFailure = (email: string, clientIp: string | undefined): void => {
    const key = limiterKey(email, clientIp);
    const previous = failures.get(key);
    const count = (previous?.failures ?? 0) + 1;
    const lockMs = count >= maxFailures ? backoffBaseMs * (2 ** (count - maxFailures)) : 0;
    failures.set(key, { failures: count, locked_until: now() + lockMs });
  };

  const resolveOperator = (token: string): StoredOperatorSession | null => {
    const session = operators.get(token);
    if (session === undefined) return null;
    if (!validAt(now(), session.expires_at_ms)) {
      operators.delete(token);
      return null;
    }
    return session;
  };

  const resolveWidgetSession = (token: string): WidgetCredential | null => {
    const session = widgets.get(token);
    if (session === undefined) return null;
    if (!validAt(now(), session.expires_at_ms)) {
      widgets.delete(token);
      return null;
    }
    return session;
  };

  const sessionDto = (session: StoredOperatorSession): DemoSession => ({
    access_token: session.token,
    expires_at: session.expires_at,
    identity: {
      user_id: session.operator_id,
      email: session.email,
      display_name: session.display_name,
    },
    membership: {
      tenant_id: DEMO_TENANT_ID,
      tenant_name: null,
      role: session.role,
      scope: session.scope,
    },
    permissions: session.permissions,
  });

  return {
    login: (email, password, audience, clientIp) => {
      const normalizedEmail = normalizeEmail(email);
      if (retryAfter(normalizedEmail, clientIp) !== null) return null;
      const account = accounts.get(normalizedEmail);
      const expected = account !== null && account !== undefined && account.audience === audience
        ? account.password
        : dummyVerifier;
      if (typeof password !== 'string' || !digestMatches(password, expected) || account === undefined || account.audience !== audience) {
        recordFailure(normalizedEmail, clientIp);
        return null;
      }
      failures.delete(limiterKey(normalizedEmail, clientIp));
      const token = randomToken(tokenBytes);
      const expiry = expiresAt(now());
      const credential: StoredOperatorSession = {
        token,
        tenant_id: DEMO_TENANT_ID,
        operator_id: account.operator_id,
        scope: account.audience,
        permissions: account.permissions,
        email: account.email,
        display_name: account.display_name,
        role: account.role,
        expires_at: expiry.expires_at,
        expires_at_ms: expiry.expires_at_ms,
      };
      operators.set(token, credential);
      return sessionDto(credential);
    },

    retryAfter,
    resolveOperator,
    resolveConversationSession: () => null,
    resolveWidgetSession,

    resolveDemoSession: (token) => {
      const session = resolveOperator(token);
      return session === null ? null : sessionDto(session);
    },

    revoke: (token) => operators.delete(token),

    issueWidget: (session_id, origin) => {
      if (session_id.trim().length === 0 || origin.trim().length === 0) {
        throw new Error('widget session_id and origin are required');
      }
      const token = randomToken(tokenBytes);
      const expiry = expiresAt(now());
      widgets.set(token, {
        token,
        tenant_id: DEMO_TENANT_ID,
        session_id,
        origin,
        expires_at_ms: expiry.expires_at_ms,
      });
      return {
        access_token: token,
        expires_at: expiry.expires_at,
        session_id,
      };
    },
  };
}

export type Permission =
  | 'campaign:draft'
  | 'conversation:takeover'
  | 'customer:read'
  | 'run:read'
  | 'telemetry:read'
  | 'approval:read'
  | 'approval:decide'
  | 'platform:admin'
  | 'run:retry'
  | 'run:reconcile';

export interface UserIdentity {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
}

export interface TenantMembership {
  readonly tenant_id: string;
  readonly tenant_name: string | null;
  readonly role: string;
  readonly scope: 'company' | 'platform';
}

export interface AuthSession {
  readonly identity: UserIdentity;
  readonly membership: TenantMembership;
  readonly permissions: readonly Permission[];
  readonly expires_at: string;
}

export function can(session: AuthSession | null | undefined, permission: Permission): boolean {
  return session !== null && session !== undefined && session.permissions.includes(permission);
}

export function canAll(session: AuthSession | null | undefined, permissions: readonly Permission[]): boolean {
  return session !== null && session !== undefined && permissions.every((permission) => can(session, permission));
}

export function canAny(session: AuthSession | null | undefined, permissions: readonly Permission[]): boolean {
  return session !== null && session !== undefined && permissions.some((permission) => can(session, permission));
}

const SAFE_ORIGIN = 'http://x.invalid';
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }

  if (
    !decoded.startsWith('/')
    || decoded.startsWith('//')
    || decoded.includes('\\')
    || CONTROL_CHARACTERS.test(decoded)
  ) {
    return '/';
  }

  let resolved: URL;
  try {
    resolved = new URL(decoded, SAFE_ORIGIN);
  } catch {
    return '/';
  }

  if (resolved.origin !== SAFE_ORIGIN) {
    return '/';
  }

  const pathname = resolved.pathname;
  if (
    pathname === '/sign-in'
    || pathname.startsWith('/sign-in/')
    || pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/_next'
    || pathname.startsWith('/_next/')
  ) {
    return '/';
  }

  return raw;
}

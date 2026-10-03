import type { PoolClient, QueryResultRow } from 'pg';

import { getPool } from '../client.js';
import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export type AuthTransactionRunner = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
export type IdentityMembershipScope = 'company' | 'platform';
export type IdentityRoleBundle = 'COMPANY_ADMIN' | 'OPERATOR' | 'VIEWER' | 'PLATFORM_ADMIN';
export type IdentityMembershipStatus = 'INVITED' | 'ACTIVE' | 'DEACTIVATED';
export interface IdentityUserCredential {
  readonly user_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly failed_login_attempts: number;
  readonly locked_until: string | null;
}

export interface IdentitySession {
  readonly session_id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
}

export interface IdentityActiveMembership {
  readonly tenant_id: string;
  readonly role_bundle: IdentityRoleBundle;
  readonly scope: IdentityMembershipScope;
}

export interface IdentityMembership {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly role_bundle: IdentityRoleBundle;
  readonly status: IdentityMembershipStatus;
  readonly scope: IdentityMembershipScope;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One member projection exposed to company admins. */
export interface IdentityTenantMember {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role_bundle: IdentityRoleBundle;
  readonly status: IdentityMembershipStatus;
  readonly last_sign_in_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One platform administrator, including an outstanding invitation when the user is not yet known. */
export interface IdentityPlatformAdmin {
  readonly user_id: string | null;
  readonly email: string;
  readonly display_name: string | null;
  readonly status: IdentityMembershipStatus;
  readonly last_sign_in_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Result of issuing an invitation: the opaque id and the hard expiry bound. */
export interface IdentityInvitation {
  readonly invitation_id: string;
  readonly expires_at: string;
}

/** The membership scope activated by an accepted invitation. */
export interface IdentityAcceptedInvitation {
  readonly user_id: string;
  readonly email: string;
  readonly tenant_id: string;
  readonly role_bundle: IdentityRoleBundle;
  readonly scope: IdentityMembershipScope;
}

/** A still-usable invitation as the accept page may inspect it (never the token). */
export interface IdentityInvitationInspection {
  readonly email: string;
  readonly tenant_id: string;
  readonly role_bundle: IdentityRoleBundle;
  readonly scope: IdentityMembershipScope;
  readonly expires_at: string;
}


interface CredentialRow extends QueryResultRow {
  user_id: string;
  email: string;
  password_hash: string;
  failed_login_attempts: number;
  locked_until: Date | string | null;
}

interface SessionRow extends QueryResultRow {
  session_id: string;
  user_id: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
}

interface FailedLoginRow extends QueryResultRow {
  failed_login_attempts: number;
  locked_until: Date | string | null;
}

interface ActiveMembershipRow extends QueryResultRow {
  tenant_id: string;
  role_bundle: IdentityRoleBundle;
  scope: IdentityMembershipScope;
}

interface MembershipRow extends QueryResultRow {
  tenant_id: string;
  user_id: string;
  role_bundle: IdentityRoleBundle;
  status: IdentityMembershipStatus;
  scope: IdentityMembershipScope;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantMemberRow extends QueryResultRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role_bundle: IdentityRoleBundle;
  status: IdentityMembershipStatus;
  last_sign_in_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PlatformAdminRow extends QueryResultRow {
  user_id: string | null;
  email: string;
  display_name: string | null;
  status: IdentityMembershipStatus;
  last_sign_in_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface InvitationRow extends QueryResultRow {
  invitation_id: string;
  expires_at: Date | string;
}

interface AcceptedInvitationRow extends QueryResultRow {
  user_id: string;
  email: string;
  tenant_id: string;
  role_bundle: IdentityRoleBundle;
  scope: IdentityMembershipScope;
}

interface InvitationInspectionRow extends QueryResultRow {
  email: string;
  tenant_id: string;
  role_bundle: IdentityRoleBundle;
  scope: IdentityMembershipScope;
  expires_at: Date | string;
}

function toTenantMember(row: TenantMemberRow): IdentityTenantMember {
  return {
    user_id: row.user_id,
    email: row.email,
    role_bundle: row.role_bundle,
    status: row.status,
    display_name: row.display_name,
    last_sign_in_at: nullableIso(row.last_sign_in_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export interface IdentityRepositoryOptions {
  readonly authTransaction?: AuthTransactionRunner;
  readonly tenantTransaction?: TenantTransactionRunner;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function toSession(row: SessionRow): IdentitySession {
  return {
    session_id: row.session_id,
    user_id: row.user_id,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
    idle_expires_at: iso(row.idle_expires_at),
    absolute_expires_at: iso(row.absolute_expires_at),
  };
}

async function withAuthRole<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE agentos_auth');
    await client.query('SET LOCAL search_path TO agentos, public');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the originating authentication error if the connection is broken.
    }
    throw error;
  } finally {
    client.release();
  }
}

function requireTokenHash(token_hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(token_hash)) throw new TypeError('AUTH_TOKEN_HASH_INVALID');
}

/** Uses only the auth role's narrow SECURITY DEFINER function surface for global identity data. */
export class IdentityRepository {
  private readonly authTransaction: AuthTransactionRunner;
  private readonly tenantTransaction: TenantTransactionRunner;

  constructor(options: IdentityRepositoryOptions = {}) {
    this.authTransaction = options.authTransaction ?? withAuthRole;
    this.tenantTransaction = options.tenantTransaction ?? withTenantContext;
  }

  async findUserByEmail(email: string): Promise<IdentityUserCredential | null> {
    if (typeof email !== 'string' || email.trim().length === 0) throw new TypeError('IDENTITY_EMAIL_REQUIRED');
    return this.authTransaction(async (client) => {
      const result = await client.query<CredentialRow>(
        'SELECT * FROM agentos.auth_find_user_by_email($1)',
        [email.trim().toLowerCase()],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        user_id: row.user_id,
        email: row.email,
        password_hash: row.password_hash,
        failed_login_attempts: row.failed_login_attempts,
        locked_until: nullableIso(row.locked_until),
      };
    });
  }

  async findUserById(user_id: string): Promise<IdentityUserCredential | null> {
    if (typeof user_id !== 'string' || user_id.length === 0) throw new TypeError('IDENTITY_USER_REQUIRED');
    return this.authTransaction(async (client) => {
      const result = await client.query<CredentialRow>(
        'SELECT * FROM agentos.auth_find_user_by_id($1::uuid)',
        [user_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        user_id: row.user_id,
        email: row.email,
        password_hash: row.password_hash,
        failed_login_attempts: row.failed_login_attempts,
        locked_until: nullableIso(row.locked_until),
      };
    });
  }

  async createSession(input: {
    readonly user_id: string;
    readonly token_hash: string;
    readonly idle_lifetime_seconds: number;
    readonly absolute_lifetime_seconds: number;
  }): Promise<IdentitySession | null> {
    requireTokenHash(input.token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<SessionRow>(
        'SELECT * FROM agentos.auth_create_session($1::uuid, $2, $3, $4)',
        [input.user_id, input.token_hash, input.idle_lifetime_seconds, input.absolute_lifetime_seconds],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSession(row);
    });
  }

  async touchSession(token_hash: string, idle_lifetime_seconds: number): Promise<IdentitySession | null> {
    requireTokenHash(token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<SessionRow>(
        'SELECT * FROM agentos.auth_touch_session($1, $2)',
        [token_hash, idle_lifetime_seconds],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSession(row);
    });
  }

  async revokeSession(token_hash: string): Promise<boolean> {
    requireTokenHash(token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<{ revoked: boolean }>(
        'SELECT agentos.auth_revoke_session($1) AS revoked',
        [token_hash],
      );
      return result.rows[0]?.revoked === true;
    });
  }

  async recordFailedLogin(user_id: string): Promise<{ failed_login_attempts: number; locked_until: string | null } | null> {
    return this.authTransaction(async (client) => {
      const result = await client.query<FailedLoginRow>(
        'SELECT * FROM agentos.auth_record_failed_login($1::uuid)',
        [user_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        failed_login_attempts: row.failed_login_attempts,
        locked_until: nullableIso(row.locked_until),
      };
    });
  }

  async consumeInvitation(token_hash: string, user_id: string): Promise<{ tenant_id: string; role_bundle: IdentityRoleBundle } | null> {
    requireTokenHash(token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<{ tenant_id: string; role_bundle: IdentityRoleBundle }>(
        'SELECT * FROM agentos.auth_consume_invitation($1, $2::uuid)',
        [token_hash, user_id],
      );
      return result.rows[0] ?? null;
    });
  }

  /** Every ACTIVE membership of a user, resolved only through the auth role's function surface. */
  async listActiveMemberships(user_id: string): Promise<readonly IdentityActiveMembership[]> {
    if (typeof user_id !== 'string' || user_id.length === 0) throw new TypeError('IDENTITY_USER_REQUIRED');
    return this.authTransaction(async (client) => {
      const result = await client.query<ActiveMembershipRow>(
        'SELECT tenant_id::text AS tenant_id, role_bundle, scope FROM agentos.auth_find_active_memberships($1::uuid)',
        [user_id],
      );
      return result.rows.map((row) => ({ tenant_id: row.tenant_id, role_bundle: row.role_bundle, scope: row.scope }));
    });
  }

  /** Replaces the password hash and revokes every live session for the user; `false` for an unknown user. */
  async updatePassword(user_id: string, password_hash: string): Promise<boolean> {
    if (typeof password_hash !== 'string' || password_hash.length === 0) {
      throw new TypeError('IDENTITY_PASSWORD_HASH_REQUIRED');
    }
    return this.authTransaction(async (client) => {
      const result = await client.query<{ updated: boolean }>(
        'SELECT agentos.auth_update_password($1::uuid, $2) AS updated',
        [user_id, password_hash],
      );
      return result.rows[0]?.updated === true;
    });
  }

  async listMemberships(tenant_id: string, user_id: string): Promise<readonly IdentityMembership[]> {
    return this.tenantTransaction(tenant_id, async (client) => {
      const result = await client.query<MembershipRow>(
        `SELECT tenant_id::text AS tenant_id, user_id::text AS user_id, role_bundle, status, scope, created_at, updated_at
           FROM agentos.tenant_memberships
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid
          ORDER BY created_at, user_id, scope`,
        [tenant_id, user_id],
      );
      return result.rows.map((row) => ({
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        role_bundle: row.role_bundle,
        status: row.status,
        scope: row.scope,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      }));
    });
  }

  /**
   * Issues a single-use invitation. The raw token never reaches this layer: the caller hashes it and
   * passes only the digest, so a stored invitation cannot be replayed even with database access.
   */
  async createInvitation(input: {
    readonly tenant_id: string;
    readonly email: string;
    readonly role_bundle: IdentityRoleBundle;
    readonly scope?: IdentityMembershipScope;
    readonly token_hash: string;
    readonly created_by: string;
    readonly expires_at: string;
  }): Promise<IdentityInvitation | null> {
    if (typeof input.email !== 'string' || input.email.trim().length === 0) {
      throw new TypeError('IDENTITY_EMAIL_REQUIRED');
    }
    const scope = input.scope ?? 'company';
    if (
      scope !== 'company' && scope !== 'platform'
      || scope === 'platform' && input.role_bundle !== 'PLATFORM_ADMIN'
      || scope === 'company' && input.role_bundle === 'PLATFORM_ADMIN'
    ) {
      throw new TypeError('IDENTITY_INVITATION_SCOPE_INVALID');
    }
    requireTokenHash(input.token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<InvitationRow>(
        'SELECT * FROM agentos.auth_create_invitation($1::uuid, $2, $3, $4, $5, $6::uuid, $7::timestamptz)',
        [
          input.tenant_id,
          input.email.trim().toLowerCase(),
          input.role_bundle,
          scope,
          input.token_hash,
          input.created_by,
          input.expires_at,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : { invitation_id: row.invitation_id, expires_at: iso(row.expires_at) };
    });
  }

  /**
   * Redeems an invitation: creates or resets the user's password and activates the membership in one
   * transaction. Returns `null` for an unknown, expired or already-consumed token.
   */
  async acceptInvitation(
    token_hash: string,
    password_hash: string,
    display_name?: string | null,
  ): Promise<IdentityAcceptedInvitation | null> {
    requireTokenHash(token_hash);
    if (typeof password_hash !== 'string' || password_hash.length === 0) {
      throw new TypeError('IDENTITY_PASSWORD_HASH_REQUIRED');
    }
    return this.authTransaction(async (client) => {
      const result = await client.query<AcceptedInvitationRow>(
        'SELECT * FROM agentos.auth_accept_invitation($1, $2, $3)',
        [token_hash, password_hash, display_name ?? null],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        user_id: row.user_id,
        email: row.email,
        tenant_id: row.tenant_id,
        role_bundle: row.role_bundle,
        scope: row.scope,
      };
    });
  }

  /** Reads a still-usable invitation without consuming it; `null` when it cannot be accepted. */
  async inspectInvitation(token_hash: string): Promise<IdentityInvitationInspection | null> {
    requireTokenHash(token_hash);
    return this.authTransaction(async (client) => {
      const result = await client.query<InvitationInspectionRow>(
        'SELECT * FROM agentos.auth_inspect_invitation($1)',
        [token_hash],
      );
      const row = result.rows[0];
      return row === undefined ? null : {
        email: row.email,
        tenant_id: row.tenant_id,
        role_bundle: row.role_bundle,
        scope: row.scope,
        expires_at: iso(row.expires_at),
      };
    });
  }

  /** Lists platform-scoped memberships and outstanding platform invitations via the auth function surface. */
  async listPlatformAdmins(): Promise<readonly IdentityPlatformAdmin[]> {
    return this.authTransaction(async (client) => {
      const result = await client.query<PlatformAdminRow>(
        'SELECT user_id::text AS user_id, email, display_name, status, last_sign_in_at, created_at, updated_at FROM agentos.auth_list_platform_admins()',
      );
      return result.rows.map((row) => ({
        user_id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        status: row.status,
        last_sign_in_at: nullableIso(row.last_sign_in_at),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      }));
    });
  }

  /** Company members plus live company invitations; INVITED rows use their invitation id as user_id. */
  async listTenantMembers(tenant_id: string): Promise<readonly IdentityTenantMember[]> {
    if (typeof tenant_id !== 'string' || tenant_id.length === 0) throw new TypeError('IDENTITY_TENANT_REQUIRED');
    return this.authTransaction(async (client) => {
      const result = await client.query<TenantMemberRow>(
        'SELECT * FROM agentos.auth_list_tenant_members($1::uuid)',
        [tenant_id],
      );
      return result.rows.map(toTenantMember);
    });
  }

  /**
   * Changes a member's bundle and/or status. Deactivating revokes every live session for the user;
   * `null` means no such membership exists in the company.
   */
  async updateMembership(input: {
    readonly tenant_id: string;
    readonly user_id: string;
    readonly role_bundle?: IdentityRoleBundle;
    readonly status?: IdentityMembershipStatus;
  }): Promise<IdentityTenantMember | null> {
    return this.authTransaction(async (client) => {
      const result = await client.query<TenantMemberRow>(
        'SELECT * FROM agentos.auth_update_membership($1::uuid, $2::uuid, $3, $4)',
        [input.tenant_id, input.user_id, input.role_bundle ?? null, input.status ?? null],
      );
      const row = result.rows[0];
      return row === undefined ? null : toTenantMember(row);
    });
  }
}

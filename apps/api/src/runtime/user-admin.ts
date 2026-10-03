/**
 * @file Company user administration and invitation redemption (T9.3, workflow §4).
 *
 * Two ports live here, both over the identity repository's `agentos_auth` function surface:
 *
 * - {@link CompanyUserAdminPort} issues single-use invitations, lists a company's members and
 *   changes a member's bundle/status. The raw invitation token is minted here, hashed before it
 *   touches the database, and handed to the email sender; nothing else ever sees it.
 * - {@link InvitationAcceptPort} redeems a token from the public accept page: it hashes the chosen
 *   password and lets the database transaction create or unlock the user and activate the
 *   membership.
 */

import { createHash, randomBytes } from 'node:crypto';

import { hashPassword } from '@agentos/core-engine';
import type {
  IdentityAcceptedInvitation,
  IdentityInvitation,
  IdentityInvitationInspection,
  IdentityMembershipScope,
  IdentityPlatformAdmin,
  IdentityRoleBundle,
  IdentityTenantMember,
} from '@agentos/database';

import type {
  CompanyInvitationRecord,
  CompanyUserAdminPort,
  CompanyUserRecord,
  CompanyUserRole,
  CompanyUserStatus,
  EmailSenderPort,
  InvitationAcceptPort,
  PlatformAdminInvitationRecord,
  PlatformAdminsPort,
} from '../gateway/ports.js';

/** Invitations are valid for 72 hours; the database CHECK enforces the same ceiling. */
export const INVITATION_TTL_HOURS = 72;

/** The narrow slice of the identity repository these ports use; tests bind a fake unchanged. */
export interface UserAdminIdentityPort {
  createInvitation(input: {
    readonly tenant_id: string;
    readonly email: string;
    readonly role_bundle: IdentityRoleBundle;
    readonly scope?: IdentityMembershipScope;
    readonly token_hash: string;
    readonly created_by: string;
    readonly expires_at: string;
  }): Promise<IdentityInvitation | null>;
  acceptInvitation(token_hash: string, password_hash: string, display_name?: string | null): Promise<IdentityAcceptedInvitation | null>;
  inspectInvitation(token_hash: string): Promise<IdentityInvitationInspection | null>;
  listTenantMembers(tenant_id: string): Promise<readonly IdentityTenantMember[]>;
  updateMembership(input: {
    readonly tenant_id: string;
    readonly user_id: string;
    readonly role_bundle?: IdentityRoleBundle;
    readonly status?: CompanyUserStatus;
  }): Promise<IdentityTenantMember | null>;
}
export interface PlatformAdminIdentityPort extends UserAdminIdentityPort {
  listPlatformAdmins(): Promise<readonly IdentityPlatformAdmin[]>;
}

export interface PlatformAdminsPortOptions {
  readonly identity: PlatformAdminIdentityPort;
  readonly email: EmailSenderPort;
  /** Platform console origin used to build the accept link; no trailing slash required. */
  readonly console_base_url: string;
  readonly now?: () => Date;
}

export interface CompanyUserAdminPortOptions {
  readonly identity: UserAdminIdentityPort;
  readonly email: EmailSenderPort;
  /** Tenant console origin used to build the accept link; no trailing slash required. */
  readonly console_base_url: string;
  readonly now?: () => Date;
}

function toCompanyUser(member: IdentityTenantMember): CompanyUserRecord {
  if (member.role_bundle === 'PLATFORM_ADMIN') {
    throw new Error('IDENTITY_COMPANY_ROLE_INVALID');
  }
  const role_bundle: CompanyUserRole = member.role_bundle;
  return {
    user_id: member.user_id,
    display_name: member.display_name,
    email: member.email,
    role_bundle,
    status: member.status,
    last_sign_in_at: member.last_sign_in_at,
    created_at: member.created_at,
    updated_at: member.updated_at,
  };
}

/** Hashes an opaque invitation token with SHA-256 to the 64-hex form the schema stores. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mints the raw single-use token. Only its hash is persisted; only the raw value is emailed. */
export function createInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

export function createCompanyUserAdminPort(options: CompanyUserAdminPortOptions): CompanyUserAdminPort {
  const now = options.now ?? (() => new Date());
  const base = options.console_base_url.replace(/\/+$/, '');

  return {
    async listUsers(tenant_id) {
      const members = await options.identity.listTenantMembers(tenant_id);
      return members.map(toCompanyUser);
    },

    async invite(input) {
      const token = createInvitationToken();
      const token_hash = hashInvitationToken(token);
      const expires = new Date(now().getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
      const invitation = await options.identity.createInvitation({
        tenant_id: input.tenant_id,
        email: input.email,
        role_bundle: input.role_bundle,
        scope: 'company',
        token_hash,
        created_by: input.created_by,
        expires_at: expires.toISOString(),
      });
      if (invitation === null) return null;
      await options.email.sendInvitation({
        to: input.email.trim().toLowerCase(),
        tenant_id: input.tenant_id,
        role_bundle: input.role_bundle,
        scope: 'company',
        invitation_url: `${base}/accept-invite?token=${encodeURIComponent(token)}`,
        expires_at: invitation.expires_at,
      });
      return {
        invitation_id: invitation.invitation_id,
        email: input.email.trim().toLowerCase(),
        role_bundle: input.role_bundle,
        expires_at: invitation.expires_at,
      } satisfies CompanyInvitationRecord;
    },

    async updateUser(input) {
      const updated = await options.identity.updateMembership({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        ...(input.role_bundle === undefined ? {} : { role_bundle: input.role_bundle }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      return updated === null ? null : toCompanyUser(updated);
    },
  };
}
export function createPlatformAdminsPort(options: PlatformAdminsPortOptions): PlatformAdminsPort {
  const now = options.now ?? (() => new Date());
  const base = options.console_base_url.replace(/\/+$/, '');

  return {
    async list() {
      return options.identity.listPlatformAdmins();
    },

    async invite(input) {
      const email = input.email.trim().toLowerCase();
      const token = createInvitationToken();
      const expires = new Date(now().getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
      const invitation = await options.identity.createInvitation({
        tenant_id: input.tenant_id,
        email,
        role_bundle: 'PLATFORM_ADMIN',
        scope: 'platform',
        token_hash: hashInvitationToken(token),
        created_by: input.created_by,
        expires_at: expires.toISOString(),
      });
      if (invitation === null) return null;
      await options.email.sendInvitation({
        to: email,
        tenant_id: input.tenant_id,
        role_bundle: 'PLATFORM_ADMIN',
        scope: 'platform',
        invitation_url: `${base}/accept-invite?token=${encodeURIComponent(token)}`,
        expires_at: invitation.expires_at,
      });
      return {
        invitation_id: invitation.invitation_id,
        email,
        expires_at: invitation.expires_at,
      } satisfies PlatformAdminInvitationRecord;
    },
  };
}


export interface InvitationAcceptPortOptions {
  readonly identity: UserAdminIdentityPort;
}

export function createInvitationAcceptPort(options: InvitationAcceptPortOptions): InvitationAcceptPort {
  return {
    async inspect(token) {
      const inspection = await options.identity.inspectInvitation(hashInvitationToken(token));
      return inspection === null
        ? null
        : {
            email: inspection.email,
            tenant_id: inspection.tenant_id,
            role_bundle: inspection.role_bundle,
            scope: inspection.scope,
            expires_at: inspection.expires_at,
          };
    },

    async accept(input) {
      const password_hash = await hashPassword(input.password);
      const accepted = await options.identity.acceptInvitation(
        hashInvitationToken(input.token),
        password_hash,
        input.display_name ?? null,
      );
      return accepted === null
        ? null
        : {
            user_id: accepted.user_id,
            email: accepted.email,
            tenant_id: accepted.tenant_id,
            role_bundle: accepted.role_bundle,
            scope: accepted.scope,
          };
    },
  };
}

/** Re-exported so the route layer can name the wire vocabulary without importing ports plumbing. */
export type { CompanyUserRole };

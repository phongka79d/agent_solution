/**
 * @file Behavioral contract of company user management and invitation redemption (T9.3).
 *
 * These cases drive real Fastify requests through the real route groups and the real
 * `createCompanyUserAdminPort` / `createInvitationAcceptPort` bindings. The identity repository is a
 * fake that models the migration's invitation semantics (single-use digest, 72 h expiry, membership
 * activation, session revocation on deactivation); the raw-token hashing, the email seam and the
 * permission/audit behaviour are the production ones. The database functions themselves are proven
 * separately by `packages/database/src/invitations.rehearsal.test.ts`.
 */

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  IdentityAcceptedInvitation,
  IdentityInvitation,
  IdentityInvitationInspection,
  IdentityMembershipScope,
  IdentityRoleBundle,
  IdentityTenantMember,
} from '@agentos/database';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import type { EmailSenderPort, GatewayRuntime } from '../../gateway/ports.js';
import { createLogOnlyEmailSender } from '../../runtime/email.js';
import {
  createCompanyUserAdminPort,
  createInvitationAcceptPort,
  type UserAdminIdentityPort,
} from '../../runtime/user-admin.js';
import { registerCompanyUserRoutes } from './company-users.js';
import { registerPlatformInvitationRoutes } from './platform-invitations.js';
import { registerInvitationRoutes } from './invitations.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_TOKEN = 'company-admin-token';
const PLATFORM_TOKEN = 'platform-writer-token';
const PLATFORM_READER_TOKEN = 'platform-reader-token';
const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredInvitation {
  readonly invitation_id: string;
  readonly token_hash: string;
  email: string;
  role_bundle: IdentityRoleBundle;
  expires_at: number;
  scope: IdentityMembershipScope;
  consumed: boolean;
  tenant_id: string;
}

interface FakeIdentity extends UserAdminIdentityPort {
  readonly invitations: Map<string, StoredInvitation>;
  readonly members: Map<string, IdentityTenantMember>;
  readonly revokedSessions: string[];
  readonly sessions: Set<string>;
}

function fakeIdentity(): FakeIdentity {
  const invitations = new Map<string, StoredInvitation>();
  const members = new Map<string, IdentityTenantMember>();
  const sessions = new Set<string>(['existing-session']);
  const revokedSessions: string[] = [];
  return {
    invitations,
    members,
    sessions,
    revokedSessions,
    async createInvitation(input): Promise<IdentityInvitation | null> {
      for (const [key, stored] of invitations) {
        if (stored.tenant_id === input.tenant_id && stored.email === input.email && !stored.consumed) {
          stored.consumed = true;
          invitations.set(key, stored);
        }
      }
      const invitation_id = `00000000-0000-4000-8000-${String(invitations.size + 1).padStart(12, '0')}`;
      invitations.set(input.token_hash, {
        invitation_id,
        token_hash: input.token_hash,
        email: input.email,
        role_bundle: input.role_bundle,
        expires_at: Date.parse(input.expires_at),
        consumed: false,
        scope: input.scope ?? 'company',
        tenant_id: input.tenant_id,
      });
      return { invitation_id, expires_at: input.expires_at };
    },
    async inspectInvitation(token_hash): Promise<IdentityInvitationInspection | null> {
      const stored = invitations.get(token_hash);
      if (stored === undefined || stored.consumed || stored.expires_at <= NOW.getTime()) return null;
      return {
        email: stored.email,
        tenant_id: stored.tenant_id,
        role_bundle: stored.role_bundle,
        expires_at: new Date(stored.expires_at).toISOString(),
        scope: stored.scope,
      };
    },
    async acceptInvitation(token_hash, _password_hash, display_name): Promise<IdentityAcceptedInvitation | null> {
      const stored = invitations.get(token_hash);
      if (stored === undefined || stored.consumed || stored.expires_at <= NOW.getTime()) return null;
      stored.consumed = true;
      invitations.set(token_hash, stored);
      const user_id = `user-${stored.email}`;
      if (stored.scope === 'company') {
        members.set(`${stored.tenant_id}:${user_id}`, {
          user_id,
          email: stored.email,
          display_name: display_name ?? null,
          role_bundle: stored.role_bundle,
          status: 'ACTIVE',
          last_sign_in_at: NOW.toISOString(),
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        });
      }
      return {
        user_id,
        email: stored.email,
        tenant_id: stored.tenant_id,
        role_bundle: stored.role_bundle,
        scope: stored.scope,
      };
    },
    async listTenantMembers(tenant_id) {
      const tenantMembers = [...members.values()].filter((member) => members.has(`${tenant_id}:${member.user_id}`));
      const pendingInvitations = [...invitations.values()]
        .filter((invitation) =>
          invitation.scope === 'company'
          && invitation.tenant_id === tenant_id
          && !invitation.consumed
          && invitation.expires_at > NOW.getTime(),
        )
        .map((invitation): IdentityTenantMember => ({
          user_id: invitation.invitation_id,
          email: invitation.email,
          display_name: null,
          role_bundle: invitation.role_bundle,
          status: 'INVITED',
          last_sign_in_at: null,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        }));
      return [...tenantMembers, ...pendingInvitations];
    },
    async updateMembership(input) {
      const key = `${input.tenant_id}:${input.user_id}`;
      const existing = members.get(key);
      if (existing === undefined) return null;
      const updated: IdentityTenantMember = {
        ...existing,
        role_bundle: input.role_bundle ?? existing.role_bundle,
        status: input.status ?? existing.status,
        updated_at: NOW.toISOString(),
      };
      members.set(key, updated);
      if (input.status === 'DEACTIVATED') {
        for (const session of sessions) revokedSessions.push(session);
        sessions.clear();
      }
      return updated;
    },
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly identity: FakeIdentity;
  readonly logs: string[];
  readonly invitationUrls: string[];
  readonly auditRecord: Mock;
}

function rawTokenOf(harness: Harness): string {
  const url = harness.invitationUrls[harness.invitationUrls.length - 1];
  expect(url).toBeDefined();
  const token = new URL(url as string).searchParams.get('token');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token as string;
}

function buildHarness(): Harness {
  const identity = fakeIdentity();
  const logs: string[] = [];
  const invitationUrls: string[] = [];
  const auditRecord = vi.fn(async () => undefined);
  const runtime = {
    ids: () => 'corr-invitations',
    clock: () => NOW,
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const logOnly = createLogOnlyEmailSender({ log: (message) => logs.push(message) });
  const email: EmailSenderPort = {
    async sendInvitation(input) {
      invitationUrls.push(input.invitation_url);
      await logOnly.sendInvitation(input);
    },
  };
  const userAdmin = createCompanyUserAdminPort({
    identity,
    email,
    console_base_url: 'http://console.test',
    now: () => NOW,
  });
  const invitationAccept = createInvitationAcceptPort({ identity });
  const credentials = createCredentialStore({
    operators: [
      {
        token: COMPANY_TOKEN,
        tenant_id: TENANT_ID,
        operator_id: 'company-admin-user',
        scope: 'company',
        permissions: ['settings:manage'],
      },
      {
        token: PLATFORM_TOKEN,
        tenant_id: '99999999-9999-9999-9999-999999999999',
        operator_id: 'platform-writer',
        scope: 'platform',
        permissions: ['platform:companies:write'],
      },
      {
        token: PLATFORM_READER_TOKEN,
        tenant_id: '99999999-9999-9999-9999-999999999999',
        operator_id: 'platform-reader',
        scope: 'platform',
        permissions: ['platform:admin'],
      },
    ],
    sessions: [],
    widgets: [],
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) =>
    replyFailure(reply, error, correlationIdOf(request, runtime)),
  );
  registerCompanyUserRoutes(app, { userAdmin, credentials, runtime });
  registerPlatformInvitationRoutes(app, { userAdmin, credentials, runtime });
  registerInvitationRoutes(app, { invitationAccept, runtime });
  return { app, identity, logs, invitationUrls, auditRecord };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('company user administration (T9.3)', () => {
  it('invites a user: stores only the token hash, emails the link, and audits the operator', async () => {
    const harness = buildHarness();
    const { app, identity, logs, auditRecord } = harness;
    const response = await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: '  New.User@Example.test ', role_bundle: 'OPERATOR' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { email: string; role_bundle: string; expires_at: string; invitation_id: string };
    expect(body.email).toBe('new.user@example.test');
    expect(body.role_bundle).toBe('OPERATOR');
    expect(body.expires_at).toBe(new Date(NOW.getTime() + 72 * 60 * 60 * 1000).toISOString());

    // The stored invitation is keyed by the SHA-256 digest of the raw token held in the email link.
    const raw = rawTokenOf(harness);
    const hash = sha256(raw);
    const stored = identity.invitations.get(hash);
    expect(stored?.email).toBe('new.user@example.test');

    // The delivery log exposes scope only; neither the recipient nor the tenant or replayable token data may appear.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('company scope');
    expect(logs[0]).not.toContain('new.user@example.test');
    expect(logs[0]).not.toContain(TENANT_ID);
    expect(logs[0]).not.toContain(raw);
    expect(logs[0]).not.toContain(hash);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'users.invite', outcome: 'ACCEPTED', tenant_id: TENANT_ID }),
    );
    await app.close();
  });

  it('refuses a company invite without settings:manage', async () => {
    const { app } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${PLATFORM_READER_TOKEN}` },
      payload: { email: 'nobody@example.test', role_bundle: 'VIEWER' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error_code: string }).error_code).toBe('INSUFFICIENT_AUTHORITY');
    await app.close();
  });


  it('shows and resends a pending company invitation with a replacement token and audit event', async () => {
    const harness = buildHarness();
    const { app, auditRecord } = harness;
    await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'pending-company@example.test', role_bundle: 'VIEWER' },
    });
    const previousToken = rawTokenOf(harness);
    const listed = await app.inject({
      method: 'GET',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
    });
    expect(listed.json()).toMatchObject({
      items: [expect.objectContaining({
        email: 'pending-company@example.test',
        role_bundle: 'VIEWER',
        status: 'INVITED',
      })],
    });

    const resent = await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'pending-company@example.test', role_bundle: 'VIEWER' },
    });
    expect(resent.statusCode).toBe(201);
    const replacementToken = rawTokenOf(harness);
    expect(replacementToken).not.toBe(previousToken);
    expect(await harness.identity.inspectInvitation(sha256(previousToken))).toBeNull();
    expect(await harness.identity.inspectInvitation(sha256(replacementToken))).toMatchObject({
      email: 'pending-company@example.test',
      tenant_id: TENANT_ID,
      role_bundle: 'VIEWER',
    });
    expect(auditRecord).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: 'users.invitation_resent',
      outcome: 'ACCEPTED',
      detail: expect.objectContaining({ target_user: expect.any(String), role_bundle: 'VIEWER' }),
    }));
    await app.close();
  });
  it('lets a platform writer invite the first company admin and audits actor + target', async () => {
    const { app, identity, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'first.admin@example.test', role_bundle: 'COMPANY_ADMIN' },
    });
    expect(response.statusCode).toBe(201);
    expect(identity.invitations.size).toBe(1);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'companies.invite_user',
        operator_id: 'platform-writer',
        detail: expect.objectContaining({ target_tenant: TENANT_ID, role_bundle: 'COMPANY_ADMIN' }),
      }),
    );
    await app.close();
  });

  it('lists member name and latest sign-in for platform and company users routes', async () => {
    const harness = buildHarness();
    const { app } = harness;
    await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'company.admin@example.test', role_bundle: 'COMPANY_ADMIN' },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token: rawTokenOf(harness), password: 'a-long-enough-password', display_name: 'Cynthia Admin' },
    });
    expect(accepted.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: `/platform/companies/${TENANT_ID}/users`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [expect.objectContaining({
        email: 'company.admin@example.test',
        display_name: 'Cynthia Admin',
        role_bundle: 'COMPANY_ADMIN',
        status: 'ACTIVE',
        last_sign_in_at: NOW.toISOString(),
      })],
    });

    const companyResponse = await app.inject({
      method: 'GET',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
    });
    expect(companyResponse.statusCode).toBe(200);
    expect(companyResponse.json()).toEqual({
      items: [expect.objectContaining({
        email: 'company.admin@example.test',
        display_name: 'Cynthia Admin',
        last_sign_in_at: NOW.toISOString(),
      })],
    });

    const forbidden = await app.inject({
      method: 'GET',
      url: `/platform/companies/${TENANT_ID}/users`,
      headers: { authorization: `Bearer ${PLATFORM_READER_TOKEN}` },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
  it('refuses a platform invite from a principal without platform:companies:write', async () => {
    const { app } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_READER_TOKEN}` },
      payload: { email: 'first.admin@example.test', role_bundle: 'COMPANY_ADMIN' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });


  it('reissues an invitation so the previous pending token can no longer be used', async () => {
    const harness = buildHarness();
    const { app, auditRecord } = harness;
    const first = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'pending@example.test', role_bundle: 'OPERATOR' },
    });
    expect(first.statusCode).toBe(201);
    const listed = await app.inject({
      method: 'GET',
      url: `/platform/companies/${TENANT_ID}/users`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    });
    expect(listed.json()).toMatchObject({
      items: [expect.objectContaining({
        email: 'pending@example.test',
        role_bundle: 'OPERATOR',
        status: 'INVITED',
      })],
    });
    const previousToken = rawTokenOf(harness);

    const resent = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'pending@example.test', role_bundle: 'OPERATOR' },
    });
    expect(resent.statusCode).toBe(201);
    const replacementToken = rawTokenOf(harness);
    expect(replacementToken).not.toBe(previousToken);
    expect(await harness.identity.inspectInvitation(sha256(previousToken))).toBeNull();
    expect(await harness.identity.inspectInvitation(sha256(replacementToken))).toMatchObject({
      email: 'pending@example.test',
      tenant_id: TENANT_ID,
      role_bundle: 'OPERATOR',
    });
    expect(auditRecord).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: 'companies.resend_invitation',
      outcome: 'ACCEPTED',
      detail: expect.objectContaining({ target_tenant: TENANT_ID, role_bundle: 'OPERATOR' }),
    }));
    await app.close();
  });

  it('lets a platform writer deactivate a company member and audits the target', async () => {
    const harness = buildHarness();
    const { app, identity, auditRecord } = harness;
    await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'member@example.test', role_bundle: 'OPERATOR' },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token: rawTokenOf(harness), password: 'a-long-enough-password' },
    });
    expect(accepted.statusCode).toBe(200);
    const members = await app.inject({
      method: 'GET',
      url: `/platform/companies/${TENANT_ID}/users`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    });
    const payload: unknown = members.json();
    if (typeof payload !== 'object' || payload === null || !('items' in payload) || !Array.isArray(payload.items)) {
      throw new Error('the company member response has no item list');
    }
    const firstMember: unknown = payload.items[0];
    if (typeof firstMember !== 'object' || firstMember === null || !('user_id' in firstMember) || typeof firstMember.user_id !== 'string') {
      throw new Error('the company member response has no user id');
    }
    const userId = firstMember.user_id;
    expect(userId).toBeDefined();

    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/users/${userId}/deactivate`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user_id: userId, status: 'DEACTIVATED' });
    expect(identity.sessions.size).toBe(0);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'companies.deactivate_user',
      operator_id: 'platform-writer',
      detail: expect.objectContaining({ target_tenant: TENANT_ID, target_user: userId, status: 'DEACTIVATED' }),
    }));
    await app.close();
  });

  it('refuses platform-side member deactivation without platform:companies:write', async () => {
    const { app } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/users/22222222-2222-4222-8222-222222222222/deactivate`,
      headers: { authorization: `Bearer ${PLATFORM_READER_TOKEN}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
  it('deactivates a member and revokes their sessions', async () => {
    const harness = buildHarness();
    const { app, identity, auditRecord } = harness;
    // Seed an ACTIVE member via a platform-issued invitation + acceptance.
    await app.inject({
      method: 'POST',
      url: `/platform/companies/${TENANT_ID}/invitations`,
      headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      payload: { email: 'operator@example.test', role_bundle: 'OPERATOR' },
    });
    const token = rawTokenOf(harness);
    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'a-long-enough-password' },
    });
    expect(accepted.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
    });
    const member = (list.json() as { items: readonly { user_id: string }[] }).items[0];
    expect(member).toBeDefined();

    const response = await app.inject({
      method: 'PATCH',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { user_id: member?.user_id, status: 'DEACTIVATED' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('DEACTIVATED');
    expect(identity.sessions.size).toBe(0);
    expect(identity.revokedSessions).toContain('existing-session');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'users.update', detail: expect.objectContaining({ status: 'DEACTIVATED' }) }),
    );
    await app.close();
  });
});

describe('invitation redemption (T9.3)', () => {
  it('accepts an invitation once, activating the membership', async () => {
    const harness = buildHarness();
    const { app, identity } = harness;
    await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'invitee@example.test', role_bundle: 'OPERATOR' },
    });
    const token = rawTokenOf(harness);

    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'a-long-enough-password' },
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { accepted: boolean }).accepted).toBe(true);
    expect(identity.members.get(`${TENANT_ID}:user-invitee@example.test`)?.status).toBe('ACTIVE');
    await app.close();
  });

  it('refuses reuse of an already-consumed token', async () => {
    const harness = buildHarness();
    const { app } = harness;
    await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'invitee@example.test', role_bundle: 'OPERATOR' },
    });
    const token = rawTokenOf(harness);
    await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'a-long-enough-password' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'a-long-enough-password' },
    });
    expect(replay.statusCode).toBe(422);
    expect((replay.json() as { error_code: string }).error_code).toBe('INVITATION_INVALID');
    await app.close();
  });

  it('refuses an expired token', async () => {
    const harness = buildHarness();
    const { app, identity } = harness;
    await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'invitee@example.test', role_bundle: 'OPERATOR' },
    });
    const token = rawTokenOf(harness);
    const stored = identity.invitations.get(sha256(token));
    if (stored !== undefined) stored.expires_at = NOW.getTime() - DAY_MS;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'a-long-enough-password' },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error_code: string }).error_code).toBe('INVITATION_INVALID');
    await app.close();
  });

  it('refuses a password below the minimum length before touching the token', async () => {
    const harness = buildHarness();
    const { app, identity } = harness;
    await app.inject({
      method: 'POST',
      url: '/company/users',
      headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      payload: { email: 'invitee@example.test', role_bundle: 'OPERATOR' },
    });
    const token = rawTokenOf(harness);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error_code: string }).error_code).toBe('VALIDATION_FAILED');
    expect(identity.invitations.get(sha256(token))?.consumed).toBe(false);
    await app.close();
  });

  it('reports an unknown token as INVITATION_INVALID without revealing the address', async () => {
    const { app } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/invitations/inspect',
      payload: { token: sha256('no-such-token') },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error_code: string }).error_code).toBe('INVITATION_INVALID');
    await app.close();
  });
});

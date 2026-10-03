/**
 * @file Company user management (T9.3, PLAN §9.1 "Users and roles").
 *
 * The company admin's "Người dùng" surface: list the company's members, invite a new one, change a
 * member's bundle, and deactivate a member. Every route is gated by `settings:manage` and scoped to
 * the caller's own tenant; the tenant id comes from the authenticated principal, never the body.
 * Deactivation revokes the member's live sessions inside the repository transaction.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { CompanyUserAdminPort, CompanyUserRole, CompanyUserStatus, GatewayRuntime } from '../../gateway/ports.js';
import {
  companyUserResponseRouteSchema,
  companyUsersRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

export interface CompanyUserRoutesDependencies {
  readonly userAdmin: CompanyUserAdminPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

const ROLE_BUNDLES: readonly CompanyUserRole[] = ['COMPANY_ADMIN', 'OPERATOR', 'VIEWER'];
const USER_STATUSES: readonly CompanyUserStatus[] = ['INVITED', 'ACTIVE', 'DEACTIVATED'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredOperatorId(request: FastifyRequest): { readonly tenant_id: string; readonly operator_id: string } {
  const principal = requireOperator(request, 'settings:manage');
  const operator_id = principal.operator_id;
  if (operator_id === undefined || operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
  }
  return { tenant_id: principal.tenant_id, operator_id };
}

function parseRoleBundle(value: unknown): CompanyUserRole {
  if (typeof value !== 'string' || !ROLE_BUNDLES.includes(value as CompanyUserRole)) {
    fail('VALIDATION_FAILED', 'role_bundle must be one of COMPANY_ADMIN, OPERATOR, VIEWER');
  }
  return value as CompanyUserRole;
}

export function parseInviteBody(body: unknown): { readonly email: string; readonly role_bundle: CompanyUserRole } {
  if (!isPlainRecord(body)) fail('VALIDATION_FAILED', 'an invitation requires an email and a role bundle');
  const email = body['email'];
  if (typeof email !== 'string' || email.trim().length === 0 || email.length > 320 || !email.includes('@')) {
    fail('VALIDATION_FAILED', 'an invitation requires an email and a role bundle');
  }
  return { email: email.trim().toLowerCase(), role_bundle: parseRoleBundle(body['role_bundle']) };
}

function parseUpdateBody(body: unknown): {
  readonly user_id: string;
  readonly role_bundle: CompanyUserRole | undefined;
  readonly status: CompanyUserStatus | undefined;
} {
  if (!isPlainRecord(body)) fail('VALIDATION_FAILED', 'a user change requires a user_id');
  const user_id = body['user_id'];
  if (typeof user_id !== 'string' || user_id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'a user change requires a user_id');
  }
  const role_bundle = body['role_bundle'] === undefined ? undefined : parseRoleBundle(body['role_bundle']);
  const rawStatus = body['status'];
  if (rawStatus !== undefined && (typeof rawStatus !== 'string' || !USER_STATUSES.includes(rawStatus as CompanyUserStatus))) {
    fail('VALIDATION_FAILED', 'status must be one of INVITED, ACTIVE, DEACTIVATED');
  }
  const status = rawStatus === undefined ? undefined : (rawStatus as CompanyUserStatus);
  if (role_bundle === undefined && status === undefined) {
    fail('VALIDATION_FAILED', 'a user change needs a role_bundle or a status');
  }
  return { user_id: user_id.trim(), role_bundle, status };
}

/** Registers the company user management routes. */
export function registerCompanyUserRoutes(app: FastifyInstance, deps: CompanyUserRoutesDependencies): void {
  registerOpenApiSchemas(app);

  const preHandler = authenticate({ credentials: deps.credentials, runtime: deps.runtime });

  app.get('/company/users', { preHandler, schema: companyUsersRouteSchema }, async (request, reply) => {
    try {
      const { tenant_id } = requiredOperatorId(request);
      const items = await deps.userAdmin.listUsers(tenant_id);
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.post('/company/users', { preHandler }, async (request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    try {
      const { tenant_id, operator_id } = requiredOperatorId(request);
      const parsed = parseInviteBody(request.body);
      const pending = (await deps.userAdmin.listUsers(tenant_id)).find(
        (user) => user.status === 'INVITED' && user.email.toLowerCase() === parsed.email,
      );
      const invitation = await deps.userAdmin.invite({
        tenant_id,
        email: parsed.email,
        role_bundle: parsed.role_bundle,
        created_by: operator_id,
      });
      if (invitation === null) fail('NOT_FOUND', 'the company was not found');

      const operation = pending === undefined ? 'users.invite' : 'users.invitation_resent';

      await deps.runtime.audit.record({
        tenant_id,
        correlation_id,
        operation,
        principal_kind: 'OPERATOR',
        operator_id,
        outcome: 'ACCEPTED',
        detail: {
          target_email: invitation.email,
          role_bundle: invitation.role_bundle,
          ...(pending === undefined ? {} : { target_user: pending.user_id }),
          expires_at: invitation.expires_at,
        },
      });

      return reply.code(201).send(invitation);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.patch('/company/users', { preHandler, schema: companyUserResponseRouteSchema }, async (request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    try {
      const { tenant_id, operator_id } = requiredOperatorId(request);
      const parsed = parseUpdateBody(request.body);
      const updated = await deps.userAdmin.updateUser({
        tenant_id,
        user_id: parsed.user_id,
        ...(parsed.role_bundle === undefined ? {} : { role_bundle: parsed.role_bundle }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
      });
      if (updated === null) fail('NOT_FOUND', 'the company member was not found');

      await deps.runtime.audit.record({
        tenant_id,
        correlation_id,
        operation: 'users.update',
        principal_kind: 'OPERATOR',
        operator_id,
        outcome: 'ACCEPTED',
        detail: {
          target_user: updated.user_id,
          role_bundle: updated.role_bundle,
          status: updated.status,
        },
      });

      return reply.code(200).send(updated);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });
}

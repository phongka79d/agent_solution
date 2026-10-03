/**
 * @file Platform-issued company invitations (T9.3, workflow §4 "Company Admin first login").
 *
 * The "Tạo công ty" wizard's second step: after provisioning, a platform operator invites the
 * company's first administrator. The command is gated by `platform:companies:write`, executed under
 * the platform principal (the issuer becomes the invitation author), and audited with actor + target.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { CompanyUserAdminPort, GatewayRuntime } from '../../gateway/ports.js';

import { parseInviteBody } from './company-users.js';
import { companyUserResponseRouteSchema, platformCompanyUsersRouteSchema, registerOpenApiSchemas } from './openapi-schemas.js';

export interface PlatformInvitationRoutesDependencies {
  readonly userAdmin: CompanyUserAdminPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlatformWriter(request: FastifyRequest): { readonly tenant_id: string; readonly operator_id: string } {
  const principal = requireOperator(request, 'platform:companies:write');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
  const operator_id = principal.operator_id;
  if (operator_id === undefined || operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated principal carries no operator identifier');
  }
  return { tenant_id: principal.tenant_id, operator_id };
}

function companyIdParam(request: FastifyRequest): string {
  const params = isPlainRecord(request.params) ? request.params : {};
  const id = params['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'company id is required');
  }
  return id.trim();
}

function companyUserIdParam(request: FastifyRequest): string {
  const params = isPlainRecord(request.params) ? request.params : {};
  const id = params['userId'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'company user id is required');
  }
  return id.trim();
}

/** Registers the platform company invitation command. */
export function registerPlatformInvitationRoutes(
  app: FastifyInstance,
  deps: PlatformInvitationRoutesDependencies,
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate({ credentials: deps.credentials, runtime: deps.runtime });

  app.get('/platform/companies/:id/users', { preHandler, schema: platformCompanyUsersRouteSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'platform:companies:write');
      if (principal.scope !== 'platform') {
        fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
      }
      const tenant_id = companyIdParam(request);
      const items = await deps.userAdmin.listUsers(tenant_id);
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.post('/platform/companies/:id/invitations', { preHandler }, async (request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    try {
      const { operator_id } = requirePlatformWriter(request);
      const tenant_id = companyIdParam(request);
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
      if (invitation === null) fail('NOT_FOUND', 'the requested company was not found');
      const operation = pending === undefined ? 'companies.invite_user' : 'companies.resend_invitation';

      await deps.runtime.audit.record({
        tenant_id,
        correlation_id,
        operation,
        principal_kind: 'OPERATOR',
        operator_id,
        outcome: 'ACCEPTED',
        detail: {
          target_tenant: tenant_id,
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

  app.post('/platform/companies/:id/users/:userId/deactivate', { preHandler, schema: companyUserResponseRouteSchema }, async (request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    try {
      const { operator_id } = requirePlatformWriter(request);
      const tenant_id = companyIdParam(request);
      const user_id = companyUserIdParam(request);
      const member = await deps.userAdmin.updateUser({ tenant_id, user_id, status: 'DEACTIVATED' });
      if (member === null) fail('NOT_FOUND', 'the company member was not found');

      await deps.runtime.audit.record({
        tenant_id,
        correlation_id,
        operation: 'companies.deactivate_user',
        principal_kind: 'OPERATOR',
        operator_id,
        outcome: 'ACCEPTED',
        detail: { target_tenant: tenant_id, target_user: member.user_id, status: member.status },
      });
      return reply.code(200).send(member);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });
}

/**
 * Platform administrator directory and platform-scoped invitations (T8.9).
 * Email addresses are masked at the route boundary for both listings and mutation responses.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { PlatformAdminsPort } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

import { platformAdminInvitationRouteSchema, platformAdminsRouteSchema, registerOpenApiSchemas } from './openapi-schemas.js';

export interface PlatformAdminRoutesDependencies {
  readonly platformAdmins: PlatformAdminsPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
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

function requirePlatformAdmin(request: FastifyRequest): void {
  const principal = requireOperator(request, 'platform:admin');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseEmail(body: unknown): string {
  const raw = isPlainRecord(body) ? body['email'] : undefined;
  if (typeof raw !== 'string') fail('VALIDATION_FAILED', 'email is required');
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('VALIDATION_FAILED', 'a valid email address is required');
  }
  return email;
}

function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator < 1 || separator === email.length - 1) return '***';
  return `${email.slice(0, 1)}***@${email.slice(separator + 1)}`;
}

/** Registers the platform administrator listing and invitation endpoints. */
export function registerPlatformAdminRoutes(
  app: FastifyInstance,
  deps: PlatformAdminRoutesDependencies,
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate({ credentials: deps.credentials, runtime: deps.runtime });

  app.get('/platform/admins', { preHandler, schema: platformAdminsRouteSchema }, async (request, reply) => {
    try {
      requirePlatformAdmin(request);
      const items = await deps.platformAdmins.list();
      return reply.code(200).send({
        items: items.map((item) => ({ ...item, email: maskEmail(item.email), role: 'PLATFORM_ADMIN' })),
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.post('/platform/admins', { preHandler, schema: platformAdminInvitationRouteSchema }, async (request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    try {
      const { tenant_id, operator_id } = requirePlatformWriter(request);
      const email = parseEmail(request.body);
      const invitation = await deps.platformAdmins.invite({ tenant_id, email, created_by: operator_id });
      if (invitation === null) fail('NOT_FOUND', 'the platform administrator invitation could not be created');

      await deps.runtime.audit.record({
        tenant_id,
        correlation_id,
        operation: 'platform_admins.invite',
        principal_kind: 'OPERATOR',
        operator_id,
        outcome: 'ACCEPTED',
        detail: { invitation_id: invitation.invitation_id, scope: 'platform', expires_at: invitation.expires_at },
      });

      return reply.code(201).send({
        invitation_id: invitation.invitation_id,
        email: maskEmail(invitation.email),
        expires_at: invitation.expires_at,
      });
    } catch (error) {
      return replyFailure(reply, error, correlation_id);
    }
  });
}

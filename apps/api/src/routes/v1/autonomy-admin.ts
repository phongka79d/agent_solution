import type { FastifyInstance } from 'fastify';

import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';

export interface AutonomyAdminCommand {
  readonly tenant_id: string;
  readonly operator_id?: string;
  readonly skill_id?: string;
  readonly reason?: string;
}

/** The only autonomy operations exposed to this route group. */
export interface AutonomyAdminPort {
  pauseTenant(command: AutonomyAdminCommand): Promise<unknown> | unknown;
  resumeTenant(command: AutonomyAdminCommand): Promise<unknown> | unknown;
  demote(command: AutonomyAdminCommand): Promise<unknown> | unknown;
  inspect(command: { readonly tenant_id: string }): Promise<unknown> | unknown;
}

export interface AutonomyAdminRouteDependencies {
  readonly autonomyAdmin: AutonomyAdminPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function commandOf(
  requestBody: unknown,
  tenant_id: string,
  operator_id: string | undefined,
  requiresSkill: boolean,
): AutonomyAdminCommand {
  if (requestBody !== undefined && requestBody !== null && !isPlainRecord(requestBody)) {
    fail('VALIDATION_FAILED', 'the request body must be a JSON object when supplied');
  }
  const body = isPlainRecord(requestBody) ? requestBody : {};
  const reason = body['reason'];
  const skill_id = typeof body['skill_id'] === 'string' ? body['skill_id'] : undefined;
  if (requiresSkill && (skill_id === undefined || skill_id.trim().length === 0)) {
    fail('VALIDATION_FAILED', 'skill_id is required for demotion');
  }
  return {
    tenant_id,
    ...(operator_id === undefined ? {} : { operator_id }),
    ...(requiresSkill && skill_id !== undefined ? { skill_id } : {}),
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason } : {}),
  };
}

/** Registers tenant-scoped pause, resume, demotion and inspection operations. */
export function registerAutonomyAdminRoutes(
  app: FastifyInstance,
  deps: AutonomyAdminRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  app.post('/admin/autonomy/pause', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      const command = commandOf(request.body, principal.tenant_id, principal.operator_id, false);
      const result = await deps.autonomyAdmin.pauseTenant(command);
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'autonomy.pause',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { reason: command.reason ?? null },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.post('/admin/autonomy/resume', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      const command = commandOf(request.body, principal.tenant_id, principal.operator_id, false);
      const result = await deps.autonomyAdmin.resumeTenant(command);
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'autonomy.resume',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { reason: command.reason ?? null },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.post('/admin/autonomy/demote', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      const command = commandOf(request.body, principal.tenant_id, principal.operator_id, true);
      const result = await deps.autonomyAdmin.demote(command);
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'autonomy.demote',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { skill_id: command.skill_id, reason: command.reason ?? null },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });


  app.get('/admin/autonomy', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      const result = await deps.autonomyAdmin.inspect({ tenant_id: principal.tenant_id });
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

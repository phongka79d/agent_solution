/**
 * @file Platform company directory, overview and tenant-targeted lifecycle commands (T8.1, D9).
 *
 * The platform operator selects a company by id. Lifecycle commands use the dedicated platform
 * runner and a tenant-fenced SECURITY DEFINER function; autonomy commands use the selected tenant's
 * RLS context. Platform scope is proven first, and accepted commands audit actor and target company.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime, PlatformCompanyCommandsPort, PlatformDirectoryPort } from '../../gateway/ports.js';
import type { AutonomyAdminPort } from './autonomy-admin.js';
import { platformCompanyAutonomyRouteSchema } from './openapi-schemas.js';

export interface PlatformCompaniesRouteDependencies {
  readonly platform: PlatformDirectoryPort;
  readonly companyCommands: PlatformCompanyCommandsPort;
  readonly autonomyAdmin: AutonomyAdminPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlatformAdmin(request: FastifyRequest) {
  const principal = requireOperator(request, 'platform:admin');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
  const operator_id = principal.operator_id;
  if (operator_id === undefined || operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated principal carries no operator identifier');
  }
  return { principal, operator_id };
}

function companyIdParam(request: FastifyRequest): string {
  const params = isPlainRecord(request.params) ? request.params : {};
  const id = params['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'company id is required');
  }
  return id;
}

function reasonOf(request: FastifyRequest): string {
  if (!isPlainRecord(request.body)) fail('VALIDATION_FAILED', 'a reason is required');
  const reason = request.body['reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    fail('VALIDATION_FAILED', 'a reason is required');
  }
  return reason.trim();
}

/** Registers the platform company directory and its audited tenant-targeted commands. */
export function registerPlatformCompaniesRoutes(
  app: FastifyInstance,
  deps: PlatformCompaniesRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  app.get('/platform/companies', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const items = await deps.platform.listTenants();
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/companies/:id/overview', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const overview = await deps.platform.companyOverview(companyIdParam(request));
      if (overview === null) fail('NOT_FOUND', 'the requested company was not found');
      return reply.code(200).send(overview);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/companies/:id/autonomy', { preHandler, schema: platformCompanyAutonomyRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const tenant_id = companyIdParam(request);
      const inspection = await deps.autonomyAdmin.inspect({ tenant_id });
      return reply.code(200).send(inspection);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  const autonomyCommand = (
    operation: 'autonomy.pause' | 'autonomy.resume' | 'autonomy.demote',
    path: string,
    run: (command: {
      tenant_id: string;
      operator_id: string;
      reason: string;
      skill_id?: string;
    }) => unknown,
    requiresSkill: boolean,
  ): void => {
    app.post(`/platform/companies/:id/${path}`, { preHandler }, async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const { operator_id } = requirePlatformAdmin(request);
        const tenant_id = companyIdParam(request);
        const body = isPlainRecord(request.body) ? request.body : {};
        const skill_id = typeof body['skill_id'] === 'string' ? body['skill_id'] : undefined;
        if (requiresSkill && (skill_id === undefined || skill_id.trim().length === 0)) {
          fail('VALIDATION_FAILED', 'skill_id is required for demotion');
        }
        const reason = reasonOf(request);

        const result = await run({
          tenant_id,
          operator_id,
          reason,
          ...(requiresSkill && skill_id !== undefined ? { skill_id } : {}),
        });

        await runtime.audit.record({
          tenant_id,
          correlation_id,
          operation,
          principal_kind: 'OPERATOR',
          operator_id,
          outcome: 'ACCEPTED',
          detail: {
            target_tenant: tenant_id,
            reason,
            ...(requiresSkill && skill_id !== undefined ? { skill_id } : {}),
          },
        });

        return reply.code(200).send(result);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    });
  };

  autonomyCommand('autonomy.pause', 'autonomy/pause', (command) => deps.autonomyAdmin.pauseTenant(command), false);
  autonomyCommand('autonomy.resume', 'autonomy/resume', (command) => deps.autonomyAdmin.resumeTenant(command), false);
  autonomyCommand('autonomy.demote', 'autonomy/demote', (command) => deps.autonomyAdmin.demote(command), true);

  const lifecycleCommand = (
    operation: 'companies.suspend' | 'companies.resume',
    path: string,
    run: (input: { tenant_id: string; reason?: string }) => Promise<{ readonly tenant_id: string; readonly status: string }>,
  ): void => {
    app.post(`/platform/companies/:id/${path}`, { preHandler }, async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const { operator_id } = requirePlatformAdmin(request);
        const tenant_id = companyIdParam(request);
        const reason = reasonOf(request);

        const result = await run({ tenant_id, reason });

        await runtime.audit.record({
          tenant_id,
          correlation_id,
          operation,
          principal_kind: 'OPERATOR',
          operator_id,
          outcome: 'ACCEPTED',
          detail: { target_tenant: tenant_id, status: result.status, reason },
        });

        return reply.code(200).send(result);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    });
  };

  lifecycleCommand('companies.suspend', 'suspend', (input) => deps.companyCommands.suspend(input));
  lifecycleCommand('companies.resume', 'resume', (input) => deps.companyCommands.resume(input));
}

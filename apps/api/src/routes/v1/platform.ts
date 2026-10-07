import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type {
  GatewayRuntime,
  PlatformDirectoryPort,
  PlatformProvidersPort,
} from '../../gateway/ports.js';
import type { CredentialStore } from '../../gateway/principal.js';
import {
  platformProvidersRouteSchema,
  platformReadinessRouteSchema,
  platformTenantRouteSchema,
  platformTenantsRouteSchema,
  platformUsageRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

export interface PlatformRouteDependencies {
  readonly platform: PlatformDirectoryPort;
  readonly providers: PlatformProvidersPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasTenantAssertion(request: FastifyRequest): boolean {
  if (request.headers['x-tenant-id'] !== undefined) return true;
  const query = isPlainRecord(request.query) && request.query['tenant_id'] !== undefined;
  const body = isPlainRecord(request.body) && request.body['tenant_id'] !== undefined;
  return query || body;
}

function tenantIdParam(request: FastifyRequest): string {
  const params = request.params;
  const id = isPlainRecord(params) ? params['id'] : undefined;
  if (typeof id !== 'string' || id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'tenant id is required');
  }
  return id;
}

function requirePlatformAdmin(request: FastifyRequest) {
  const principal = requireOperator(request, 'platform:admin');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
  return principal;
}

function usageWindow(request: FastifyRequest): { readonly from: string; readonly to: string } {
  const query = isPlainRecord(request.query) ? request.query : {};
  const from = query['from'];
  const to = query['to'];
  if (typeof from !== 'string' || typeof to !== 'string') {
    fail('VALIDATION_FAILED', 'from and to are required');
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    fail('VALIDATION_FAILED', 'from and to must form a non-empty time window');
  }
  return { from, to };
}

/** Registers platform-only, cross-tenant directory and aggregate projections. */
export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDependencies): void {
  registerOpenApiSchemas(app);
  const authenticateRequest = authenticate(deps);
  const preHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (hasTenantAssertion(request)) {
      fail('VALIDATION_FAILED', 'platform routes do not accept tenant binding assertions');
    }
    await authenticateRequest(request, reply);
  };

  app.get('/platform/tenants', { preHandler, schema: platformTenantsRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const items = await deps.platform.listTenants();
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/tenants/:id', { preHandler, schema: platformTenantRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const tenant = await deps.platform.getTenant(tenantIdParam(request));
      if (tenant === null) fail('NOT_FOUND', 'the requested tenant was not found');
      return reply.code(200).send(tenant);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/tenants/:id/readiness', { preHandler, schema: platformReadinessRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const readiness = await deps.platform.readiness(tenantIdParam(request));
      if (readiness === null) fail('NOT_FOUND', 'the requested tenant was not found');
      return reply.code(200).send(readiness);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/usage', { preHandler, schema: platformUsageRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const { from, to } = usageWindow(request);
      const items = await deps.platform.usage(from, to);
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/providers', { preHandler, schema: platformProvidersRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const items = await deps.providers.list();
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

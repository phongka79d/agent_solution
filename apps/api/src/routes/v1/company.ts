import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { CompanyProjectionSources } from '@agentos/database';
import type { CompanyProjectionPort, PlatformProvidersPort } from '../../gateway/ports.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { DemoReadinessPort } from './demo-readiness.js';
import type { ProvisioningRoutePort } from './provisioning.js';
import { mapAiTeam } from '../../projections/ai-team.js';
import { mapAttention } from '../../projections/attention.js';
import { mapActivity } from '../../projections/activity.js';
import { mapIntegrations } from '../../projections/integrations.js';
import { mapOverview } from '../../projections/overview.js';
import {
  companyActivityRouteSchema,
  companyAiTeamRouteSchema,
  companyAttentionRouteSchema,
  companyIntegrationsRouteSchema,
  companyOverviewRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

export interface CompanyRouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly projections: CompanyProjectionPort;
  readonly readiness?: DemoReadinessPort;
  readonly provisioning?: ProvisioningRoutePort;
  readonly providers?: PlatformProvidersPort;
  readonly enabledModules?: readonly string[];
}

function queryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    fail('VALIDATION_FAILED', 'limit must be an integer between 1 and 200');
  }
  return parsed;
}


type CompanyRouteSources = CompanyProjectionSources & {
  readonly provider?: { readonly configured: boolean; readonly provider: string | null; readonly demo?: boolean };
  readonly readiness_connectors?: readonly { readonly key: string; readonly class: string }[];
  readonly enabled_modules?: readonly string[];
  readonly module_capabilities?: readonly { readonly capability_id: string; readonly status: string }[];
};

interface CompanyReadinessSource {
  readonly provider: { readonly configured: boolean; readonly provider: string | null; readonly demo?: boolean };
  readonly readiness_connectors: readonly { readonly key: string; readonly class: string }[];
}

function capabilityRows(value: unknown): readonly { readonly capability_id: string; readonly status: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: { capability_id: string; status: string }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record['capability_id'] !== 'string' || typeof record['status'] !== 'string') continue;
    rows.push({ capability_id: record['capability_id'], status: record['status'] });
  }
  return rows;
}

async function readinessSource(
  dependencies: CompanyRouteDependencies,
  tenant_id: string,
): Promise<CompanyReadinessSource | undefined> {
  const [snapshot, providerRows] = await Promise.all([
    dependencies.readiness === undefined
      ? Promise.resolve(null)
      : dependencies.readiness.snapshot({ tenant_id }),
    dependencies.providers === undefined ? Promise.resolve([]) : dependencies.providers.list(),
  ]);
  const configuredProvider = providerRows[0];
  if (snapshot === null && configuredProvider === undefined) return undefined;
  const providerName = configuredProvider?.provider ?? snapshot?.provider.provider ?? null;
  return {
    provider: {
      configured: configuredProvider?.configured ?? snapshot?.provider.configured ?? false,
      provider: providerName,
      ...(configuredProvider?.mode === 'DEMO_MOCK' ? { demo: true } : {}),
    },
    readiness_connectors: snapshot === null
      ? []
      : [
          { key: 'erp', class: snapshot.connectors.erp.class },
          { key: 'events', class: snapshot.connectors.events.class },
        ],
  };
}

async function sourceWithShell(
  dependencies: CompanyRouteDependencies,
  tenant_id: string,
  enrich = true,
): Promise<CompanyRouteSources> {
  const sources = await dependencies.projections.getSources(tenant_id);
  if (!enrich) return sources;
  const [readiness, shell] = await Promise.all([
    readinessSource(dependencies, tenant_id),
    dependencies.provisioning === undefined ? Promise.resolve(null) : dependencies.provisioning.getShell(tenant_id),
  ]);
  const ownerById: Record<string, { readonly input_id: string; readonly status: 'UNRESOLVED' }> = {};
  for (const owner of sources.owner_inputs) {
    if (owner.status === 'UNRESOLVED') ownerById[owner.input_id] = { input_id: owner.input_id, status: 'UNRESOLVED' };
  }
  for (const input_id of shell?.unresolved_owner_inputs ?? []) {
    if (ownerById[input_id] === undefined) ownerById[input_id] = { input_id, status: 'UNRESOLVED' };
  }
  const capabilities = capabilityRows(shell?.capabilities);
  return {
    ...sources,
    ...(readiness === undefined ? {} : { provider: readiness.provider, readiness_connectors: readiness.readiness_connectors }),
    ...(dependencies.enabledModules === undefined ? {} : { enabled_modules: dependencies.enabledModules }),
    ...(capabilities === undefined ? {} : { module_capabilities: capabilities }),
    owner_inputs: Object.values(ownerById),
  };
}

async function audit(
  request: FastifyRequest,
  runtime: GatewayRuntime,
  tenant_id: string,
  operation: string,
  detail: Record<string, unknown>,
  principal_kind: string,
  operator_id: string | undefined,
): Promise<void> {
  await runtime.audit.record({
    tenant_id,
    correlation_id: correlationIdOf(request, runtime),
    operation,
    principal_kind,
    ...(operator_id === undefined ? {} : { operator_id }),
    outcome: 'ACCEPTED',
    detail,
  });
}

/** Registers the five tenant company-console projections. */
export function registerCompanyRoutes(app: FastifyInstance, dependencies: CompanyRouteDependencies): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(dependencies);
  app.get('/company/attention', { preHandler, schema: companyAttentionRouteSchema }, async (request, reply) => {
    const runtime = dependencies.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const sources = await sourceWithShell(dependencies, principal.tenant_id);
      const items = mapAttention(sources);
      await audit(request, runtime, principal.tenant_id, 'company.attention', { count: items.length }, principal.kind, principal.operator_id);
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/company/ai-team', { preHandler, schema: companyAiTeamRouteSchema }, async (request, reply) => {
    const runtime = dependencies.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const sources = await sourceWithShell(dependencies, principal.tenant_id);
      const agents = mapAiTeam(sources);
      await audit(request, runtime, principal.tenant_id, 'company.ai-team', { count: agents.length }, principal.kind, principal.operator_id);
      return reply.code(200).send({ agents });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/company/activity', { preHandler, schema: companyActivityRouteSchema }, async (request, reply) => {
    const runtime = dependencies.runtime;
    try {
      const principal = requireOperator(request, 'run:read');
      const limit = queryLimit(request.query.limit);
      const sources = await sourceWithShell(dependencies, principal.tenant_id, false);
      const activity = mapActivity(sources, {
        ...(limit === undefined ? {} : { limit }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      });
      await audit(request, runtime, principal.tenant_id, 'company.activity', { count: activity.items.length }, principal.kind, principal.operator_id);
      return reply.code(200).send(activity);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/company/integrations', { preHandler, schema: companyIntegrationsRouteSchema }, async (request, reply) => {
    const runtime = dependencies.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const sources = await sourceWithShell(dependencies, principal.tenant_id);
      const items = mapIntegrations(sources);
      await audit(request, runtime, principal.tenant_id, 'company.integrations', { count: items.length }, principal.kind, principal.operator_id);
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/company/overview', { preHandler, schema: companyOverviewRouteSchema }, async (request, reply) => {
    const runtime = dependencies.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const sources = await sourceWithShell(dependencies, principal.tenant_id);
      const overview = mapOverview({
        ...sources,
        ...(sources.runs_today.length === 0 ? {} : { metrics: { runs: sources.runs_today.length } }),
      });
      await audit(request, runtime, principal.tenant_id, 'company.overview', {
        attention_count: overview.attention.length,
        activity_count: overview.activity.length,
      }, principal.kind, principal.operator_id);
      return reply.code(200).send(overview);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}


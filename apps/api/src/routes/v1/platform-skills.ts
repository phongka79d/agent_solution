/**
 * @file Platform skill-catalog API (T4.4, `10.4` Platform "Danh mục kỹ năng").
 *
 * The catalog itself is code-owned: it is a boot-synced projection of `packages/skills` and the
 * platform API only reads it. The one writable platform action is the per-company entitlement
 * toggle, which flips the company's `enabled` binding inside that company's RLS context (D9) so the
 * platform never performs an unscoped cross-tenant write.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { SkillCatalogRecord } from '@agentos/database';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { SkillsActor } from './skills.js';
import { platformSkillCatalogRouteSchema, registerOpenApiSchemas } from './openapi-schemas.js';

export interface PlatformSkillFleetHealth {
  readonly skill_id: string;
  readonly runs_24h: number;
  readonly success_rate_24h: number | null;
  readonly p95_ms_24h: number | null;
}

export interface PlatformSkillsPort {
  listCatalog(): Promise<readonly SkillCatalogRecord[]>;
  fleetHealth(): Promise<readonly PlatformSkillFleetHealth[]>;
  setEntitlement(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly entitled: boolean;
    readonly expected_version: string | null;
    readonly actor: SkillsActor;
  }): Promise<{ readonly tenant_id: string; readonly skill_id: string; readonly enabled: boolean; readonly version: string }>;
}

export interface PlatformSkillsRouteDependencies {
  readonly platformSkills: PlatformSkillsPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function requirePlatformAdmin(request: FastifyRequest) {
  const principal = requireOperator(request, 'platform:admin');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
  if (principal.operator_id === undefined || principal.operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated principal carries no operator identifier');
  }
  return { principal, operator_id: principal.operator_id };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Registers the platform catalog read and the per-company entitlement toggle. */
export function registerPlatformSkillsRoutes(
  app: FastifyInstance,
  deps: PlatformSkillsRouteDependencies,
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);

  app.get('/platform/skill-catalog', { preHandler, schema: platformSkillCatalogRouteSchema }, async (request, reply) => {
    try {
      requirePlatformAdmin(request);
      const [catalog, fleetHealth] = await Promise.all([
        deps.platformSkills.listCatalog(),
        deps.platformSkills.fleetHealth(),
      ]);
      const healthBySkill: Record<string, PlatformSkillFleetHealth> = Object.fromEntries(
        fleetHealth.map((item) => [item.skill_id, item]),
      );
      const items = catalog.map((entry) => {
        const health = healthBySkill[entry.skill_id];
        return {
          ...entry,
          runs_24h: health?.runs_24h ?? 0,
          success_rate_24h: health?.success_rate_24h ?? null,
          p95_ms_24h: health?.p95_ms_24h ?? null,
        };
      });
      return reply.code(200).send({ catalog: items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.put<{ Params: { id: string; tenant_id: string } }>(
    '/platform/skill-catalog/:id/entitlement/:tenant_id',
    { preHandler },
    async (request, reply) => {
      try {
        const { principal, operator_id } = requirePlatformAdmin(request);
        const skill_id = request.params.id;
        const tenant_id = request.params.tenant_id;
        if (typeof skill_id !== 'string' || skill_id.length === 0) fail('VALIDATION_FAILED', 'skill id is required');
        if (typeof tenant_id !== 'string' || tenant_id.length === 0) fail('VALIDATION_FAILED', 'tenant id is required');
        if (!isPlainRecord(request.body) || typeof request.body['entitled'] !== 'boolean') {
          fail('VALIDATION_FAILED', 'entitled must be a boolean');
        }
        const rawVersion = request.body['version'];
        const result = await deps.platformSkills.setEntitlement({
          tenant_id,
          skill_id,
          entitled: request.body['entitled'],
          expected_version: typeof rawVersion === 'string' ? rawVersion : null,
          actor: {
            actor_kind: principal.kind,
            actor_id: operator_id,
            correlation_id: correlationIdOf(request, deps.runtime),
          },
        });
        return reply.code(200).send({ entitlement: result });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );
}

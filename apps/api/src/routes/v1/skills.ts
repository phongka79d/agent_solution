/**
 * @file Company-scoped Skill Management API (T4.4, `10.1`-`10.5`).
 *
 * A company may only *narrow* a skill's immutable contract: enable/disable, set declared config,
 * bind a connector and assign among the allowed agents. Effect class, authority requirement and the
 * contract digest are never writable; they are absent from every request schema and a body that
 * carries them is refused rather than ignored.
 *
 * Availability is the effective AND of the company binding and the contract. T4.3's live
 * `SkillGate` is not part of this build, so the port derives the status from `skill_catalog` +
 * `tenant_skill_settings` + `tenant_skill_agents` using the same stable reason vocabulary.
 */

import type { FastifyInstance, FastifySchema } from 'fastify';

import type { SkillHealthSnapshot } from '@agentos/database';
import type { SkillAvailabilityReason as RuntimeSkillAvailabilityReason } from '@agentos/skills';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

/** Stable skill status vocabulary, a subset of the shared UI `skill` status domain (T1.10). */
export type SkillStatus = 'READY' | 'DISABLED' | 'NOT_READY' | 'DEPRECATED';

/** Availability reasons, canonical with the T4.3 vocabulary where one exists. */
export type SkillAvailabilityReason =
  | RuntimeSkillAvailabilityReason
  | 'NOT_CONFIGURED'
  | 'MISSING_CONFIGURATION'
  | 'RETIRED';

export interface SkillAvailability {
  readonly available: boolean;
  readonly status: SkillStatus;
  readonly reason: SkillAvailabilityReason;
}

/** The company projection of one catalog entry plus its binding and effective availability. */
export interface CompanySkillView {
  readonly skill_id: string;
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: 'READ' | 'EFFECT' | 'APPROVAL' | 'INTERNAL';
  readonly required_authority: string;
  readonly autonomy_class: 'NEVER' | 'PROMOTABLE';
  readonly completion: 'SYNC' | 'AWAITS_HUMAN';
  readonly connector_kinds: readonly string[];
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly allowed_agents: readonly string[];
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly connector_id: string | null;
  readonly version: string | null;
  readonly assigned_agents: readonly string[];
  readonly availability: SkillAvailability;
}

export interface SkillTestResultView {
  readonly test_id: string;
  readonly skill_id: string;
  readonly mode: 'READ_DISPATCH' | 'CONNECTOR_DRY_RUN';
  readonly outcome: 'PASS' | 'FAIL' | 'REFUSED';
  readonly latency_ms: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly tested_by: string;
  readonly tested_at: string;
}

export interface SkillsActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly reason?: string | null;
}

/**
 * Every skill operation the company routes need. One port, implemented in the composition root,
 * so the routes stay storage-agnostic and a test can bind an alternate implementation.
 */
export interface SkillsPort {
  list(tenant_id: string): Promise<readonly CompanySkillView[]>;
  get(tenant_id: string, skill_id: string): Promise<CompanySkillView | null>;
  updateSettings(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly enabled: boolean;
    readonly config: Readonly<Record<string, unknown>>;
    readonly connector_id: string | null;
    readonly expected_version: string | null;
    readonly actor: SkillsActor;
  }): Promise<CompanySkillView>;
  replaceAgents(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly agents: readonly string[];
    readonly actor: SkillsActor;
  }): Promise<readonly string[]>;
  test(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly actor: SkillsActor;
  }): Promise<SkillTestResultView>;
  health(tenant_id: string, skill_id: string, window_start: Date): Promise<SkillHealthSnapshot>;
  /** Last N stored test outcomes, newest first (`10.4` "Chạy thử" history). */
  testHistory(tenant_id: string, skill_id: string, limit: number): Promise<readonly SkillTestResultView[]>;
  /** `agentos.tenants.data_class`; gates the READ test dispatch (`10.4`). */
  dataClass(tenant_id: string): Promise<'PRODUCTION' | 'DEMO' | 'TEST' | null>;
}

export interface SkillsRouteDependencies {
  readonly skills: SkillsPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

interface SkillParams {
  readonly id: string;
}

function skillIdParam(request: { params: unknown }): string {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const id = params['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'skill id is required');
  }
  return id;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const FORBIDDEN_SETTINGS_FIELDS = ['effect_class', 'required_authority', 'authority', 'contract_digest', 'contract_version'] as const;

function readVersion(request: { headers: Record<string, unknown>; body: unknown }): string | null {
  const raw = request.headers['if-match'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (isPlainRecord(request.body) && typeof request.body['version'] === 'string') return request.body['version'];
  return null;
}

const listSchema: FastifySchema = {};
const settingsSchema: FastifySchema = {};
const agentsSchema: FastifySchema = {};
const testSchema: FastifySchema = {};

/** Registers the company skill-management surface. */
export function registerSkillRoutes(app: FastifyInstance, deps: SkillsRouteDependencies): void {
  const preHandler = authenticate(deps);

  app.get('/skills', { preHandler, schema: listSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const skills = await deps.skills.list(principal.tenant_id);
      return reply.code(200).send({ skills });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.get<{ Params: SkillParams }>('/skills/:id', { preHandler, schema: listSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const skill = await deps.skills.get(principal.tenant_id, skillIdParam(request));
      if (skill === null) fail('NOT_FOUND', 'the skill is not in the catalog');
      return reply.code(200).send({ skill });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.patch<{ Params: SkillParams }>('/skills/:id/settings', { preHandler, schema: settingsSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'skills:manage');
      if (!isPlainRecord(request.body)) fail('VALIDATION_FAILED', 'a settings body is required');
      const body = request.body;
      const forbidden = FORBIDDEN_SETTINGS_FIELDS.find((field) => field in body);
      if (forbidden !== undefined) {
        fail('VALIDATION_FAILED', 'the skill contract is immutable: authority and effect class cannot be changed through this API', {
          field: forbidden,
        });
      }
      if (typeof body['enabled'] !== 'boolean') fail('VALIDATION_FAILED', 'enabled must be a boolean');
      if (!isPlainRecord(body['config'])) fail('VALIDATION_FAILED', 'config must be an object');
      const connector_id = body['connector_id'];
      if (connector_id !== null && connector_id !== undefined && typeof connector_id !== 'string') {
        fail('VALIDATION_FAILED', 'connector_id must be a string or null');
      }
      if (principal.operator_id === undefined || principal.operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
      }
      const skill = await deps.skills.updateSettings({
        tenant_id: principal.tenant_id,
        skill_id: skillIdParam(request),
        enabled: body['enabled'],
        config: body['config'],
        connector_id: typeof connector_id === 'string' && connector_id.length > 0 ? connector_id : null,
        expected_version: readVersion(request),
        actor: {
          actor_kind: principal.kind,
          actor_id: principal.operator_id,
          correlation_id: correlationIdOf(request, deps.runtime),
        },
      });
      return reply.code(200).send({ skill });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.put<{ Params: SkillParams }>('/skills/:id/agents', { preHandler, schema: agentsSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'skills:manage');
      if (!isPlainRecord(request.body) || !Array.isArray(request.body['agents'])) {
        fail('VALIDATION_FAILED', 'agents must be an array of agent codes');
      }
      const agents = request.body['agents'];
      if (!agents.every((agent): agent is string => typeof agent === 'string' && agent.length > 0)) {
        fail('VALIDATION_FAILED', 'every assigned agent must be a non-empty agent code');
      }
      if (principal.operator_id === undefined || principal.operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
      }
      const assigned = await deps.skills.replaceAgents({
        tenant_id: principal.tenant_id,
        skill_id: skillIdParam(request),
        agents,
        actor: {
          actor_kind: principal.kind,
          actor_id: principal.operator_id,
          correlation_id: correlationIdOf(request, deps.runtime),
        },
      });
      return reply.code(200).send({ assigned_agents: assigned });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.post<{ Params: SkillParams }>('/skills/:id/test', { preHandler, schema: testSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'skills:manage');
      if (principal.operator_id === undefined || principal.operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
      }
      const body = isPlainRecord(request.body) ? request.body : {};
      const input = isPlainRecord(body['input']) ? body['input'] : {};
      const result = await deps.skills.test({
        tenant_id: principal.tenant_id,
        skill_id: skillIdParam(request),
        input,
        actor: {
          actor_kind: principal.kind,
          actor_id: principal.operator_id,
          correlation_id: correlationIdOf(request, deps.runtime),
        },
      });
      return reply.code(200).send({ result });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

  app.get<{ Params: SkillParams }>('/skills/:id/health', { preHandler, schema: listSchema }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const skill_id = skillIdParam(request);
      const [health, recent_tests, data_class] = await Promise.all([
        deps.skills.health(principal.tenant_id, skill_id, new Date(deps.runtime.clock().getTime() - 24 * 60 * 60 * 1000)),
        deps.skills.testHistory(principal.tenant_id, skill_id, 5),
        deps.skills.dataClass(principal.tenant_id),
      ]);
      return reply.code(200).send({ health, recent_tests, data_class });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });
}

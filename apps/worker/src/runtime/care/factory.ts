/**
 * @file Care Orchestrator Factory (implement/04 §3.2, implement/06 §8.1).
 *
 * Invariant:
 * Assembles the Customer Care domain-specific RevenueOrchestrator from:
 *   1. CareContextAggregator (server-side customer identity resolution)
 *   2. CareAgentRuntime (deterministic, non-LLM Care agent logic)
 *   3. DomainPolicyEngine / createCarePolicyEngine (validates drafts and adapts PEP authority)
 *   4. Durable workflow & evidence adapters over PostgreSQL/Redis
 *   5. Skill-based adapter dispatcher for Customer Care skills
 *
 * Missing audit secret, missing grant row, and missing correlation id fail closed
 * with declared refusal errors rather than synthesizing invented defaults.
 */

import { randomUUID } from 'node:crypto';
import {
  EffectGuard,
  RevenueOrchestrator,
  type ApprovalQueuePort,
  type PolicyAuditPort,
  type PolicyEnforcementOptions,
  type PolicyEnforcementPoint,
} from '@agentos/core-engine';
import type {
  AssignableAuthority,
  ICrossDomainHandoffBroker,
  DurableLeaseManager,
  IAdapterDispatcher,
  IAgentRuntime,
  IAuditTrail,
  IContextAggregator,
  IEffectGuard,
  IEvidenceLogger,
  IPolicyEngine,
  ISessionControl,
  IStatefulWorkflowEngine,
} from '@agentos/core-engine/contracts';
import {
  ApprovalRepository,
  AuditRepository,
  ConversationRepository,
  DurableWorkflowRepository,
  EffectReservationRepository,
  EvidenceRepository,
  withTenantContext,
  type TenantTransactionRunner,
} from '@agentos/database';
import { DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT } from '@agentos/skills';

import { CareAgentRuntime, type SkillRegistryResolver } from './agent-runtime.js';
import { CareContextAggregator, type CareContextAggregatorRepositories } from './context-aggregator.js';
import { createDurableAdapters, type DurableAdapters } from '../shared/adapters.js';
import {
  createPolicyAuditSink,
} from '../shared/policy-audit.js';
import { DomainPolicyEngine } from '../shared/policy-engine.js';
import { CARE_SKILLS, CARE_ALLOWED_PAYLOAD_FIELDS } from './policy-registry.js';
import {
  createCareSkillServices,
  type CareSkillEnv,
  type CareSkillOptions,
  type CareSkillServices,
} from './skills/index.js';
import type { ErpReadPort } from '../connectors.js';

export const DEFAULT_P1B_CARE_SKILL_ENABLEMENT: NonNullable<CareSkillOptions['skill_enablement']> = Object.freeze({
  enabled_skill_ids: Object.freeze([
    ...DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT.enabled_skill_ids,
    'skill.care.escalate_to_human',
  ]),
});

export type { CareSkillEnv };

export interface CareAdaptersShape extends DurableAdapters {
  readonly unbound?: readonly string[] | undefined;
}

export interface CareOrchestratorFactoryOptions {
  readonly workerId?: string | undefined;
  readonly contextAggregator?: IContextAggregator | undefined;
  readonly agentRuntime?: IAgentRuntime | undefined;
  readonly policyEngine?: IPolicyEngine | undefined;
  readonly workflowEngine?: IStatefulWorkflowEngine | undefined;
  readonly evidenceLogger?: IEvidenceLogger | undefined;
  readonly auditTrail?: IAuditTrail | undefined;
  readonly adapterDispatcher?: IAdapterDispatcher | undefined;
  readonly effectGuard?: IEffectGuard | undefined;
  readonly sessionControl?: ISessionControl | undefined;
  readonly leaseManager?: DurableLeaseManager | undefined;
  /**
   * The brokered cross-domain handoff binding (plans/customer-lifecycle.md §3). Absent ⇒ a plan
   * that declares a handoff refuses (`HANDOFF_BROKER_UNBOUND`) instead of completing a journey leg
   * whose successor cannot be admitted.
   */
  readonly crossDomainHandoff?: ICrossDomainHandoffBroker | undefined;
  readonly effectReservationRepository?: EffectReservationRepository | undefined;
  readonly adapters?: Partial<CareAdaptersShape> | undefined;
  readonly skillServices?: CareSkillServices | undefined;
  readonly registry?: SkillRegistryResolver | undefined;
  readonly aggregatorRepositories?: CareContextAggregatorRepositories | undefined;
  readonly workflowRepository?: DurableWorkflowRepository | undefined;
  readonly approvalRepository?: ApprovalRepository | undefined;
  readonly evidenceRepository?: EvidenceRepository | undefined;
  readonly auditRepository?: AuditRepository | undefined;
  readonly conversationRepository?: ConversationRepository | undefined;
  readonly auditSecret?: string | undefined;
  readonly erp_read?: ErpReadPort | null | undefined;
  readonly env?: CareSkillEnv | undefined;
  readonly case_sla_target_hours?: CareSkillOptions['case_sla_target_hours'] | undefined;
  readonly handoff_repository?: CareSkillOptions['handoff_repository'] | undefined;
  readonly skill_enablement?: CareSkillOptions['skill_enablement'] | undefined;
  readonly now?: (() => Date) | undefined;
  readonly resolve_grant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly resolve_correlation_id?: ((tenant_id: string, run_id: string) => Promise<string>) | undefined;
  readonly audit?: PolicyAuditPort | null | undefined;
}
export interface CreateCarePolicyEngineOptions {
  readonly pep?: PolicyEnforcementPoint | undefined;
  readonly resolveGrant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly approvals?: ApprovalQueuePort | undefined;
  readonly auditSecret?: string | undefined;
  readonly audit?: PolicyEnforcementOptions['audit'] | null | undefined;
  readonly auditTrail?: IAuditTrail | undefined;
  readonly auditRepository?: AuditRepository | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Creates a Customer Care policy engine bound to the Care policy registry and durable audit boundary.
 */
export function createCarePolicyEngine(options: CreateCarePolicyEngineOptions = {}): DomainPolicyEngine {
  const durableAuditTarget = options.auditTrail ?? options.auditRepository;
  const policyAuditSink =
    options.audit === null
      ? undefined
      : options.audit ?? (durableAuditTarget ? createPolicyAuditSink(durableAuditTarget) : undefined);

  return new DomainPolicyEngine({
    skills: CARE_SKILLS,
    allowed_payload_fields: CARE_ALLOWED_PAYLOAD_FIELDS,
    ...(options.pep ? { pep: options.pep } : {}),
    ...(options.resolveGrant ? { resolveGrant: options.resolveGrant } : {}),
    defaultGrant: (agent_id: string) => {
      if (agent_id === 'CS-01') return 'AUTH-2';
      if (agent_id === 'CS-02') return 'AUTH-1';
      return null;
    },
    ...(options.approvals ? { approvals: options.approvals } : {}),
    ...(options.auditSecret ? { auditSecret: options.auditSecret } : {}),
    ...(policyAuditSink ? { audit: policyAuditSink } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Resolves the assigned authority for an agent from `agentos.agents.assigned_authority`.
 * Returns null if no active row exists for the tenant and agent code.
 */
export async function defaultResolveGrant(
  tenant_id: string,
  agent_id: string,
  runInTenantTransaction: TenantTransactionRunner = withTenantContext,
): Promise<AssignableAuthority | null> {
  return runInTenantTransaction(tenant_id, async (client) => {
    const result = await client.query(
      `SELECT assigned_authority FROM agentos.agents WHERE tenant_id = $1 AND code = $2 AND is_active = TRUE`,
      [tenant_id, agent_id],
    );
    const row = result.rows[0] as { assigned_authority: string } | undefined;
    if (!row) {
      return null;
    }
    const auth = row.assigned_authority;
    if (auth === 'AUTH-0' || auth === 'AUTH-1' || auth === 'AUTH-2' || auth === 'AUTH-3') {
      return auth;
    }
    return null;
  });
}

/**
 * Resolves the correlation_id for a durable run from `agentos.durable_tasks`.
 * Throws CARE_CORRELATION_REQUIRED if no durable task exists or if correlation_id is missing.
 */
export async function defaultResolveCorrelationId(
  tenant_id: string,
  run_id: string,
  workflowRepo?: { getTask(tenant_id: string, run_id: string): Promise<{ correlation_id: string } | null> },
): Promise<string> {
  const repo = workflowRepo ?? new DurableWorkflowRepository();
  const task = await repo.getTask(tenant_id, run_id);
  if (!task || !task.correlation_id || task.correlation_id.trim().length === 0) {
    throw new Error(
      `CARE_CORRELATION_REQUIRED: durable task for run_id '${run_id}' in tenant '${tenant_id}' was not found or lacks correlation_id.`,
    );
  }
  return task.correlation_id;
}


/**
 * Returns list of capabilities that are unbound in the given configuration.
 */
export function getUnboundCapabilities(options: CareOrchestratorFactoryOptions = {}): readonly string[] {
  const unbound: string[] = [];

  if (!options.adapterDispatcher && !options.skillServices?.dispatcher) {
    if (options.erp_read === null || options.erp_read === undefined) {
      unbound.push('API-001 (ERP read port is not bound)');
    }
  }
  const caseManagementEnabled = (
    options.skill_enablement ?? DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT
  ).enabled_skill_ids.includes('skill.care.manage_case');
  if (
    !options.skillServices
    && !options.adapterDispatcher
    && caseManagementEnabled
    && !options.case_sla_target_hours
  ) {
    unbound.push('PostgreSQL.CaseManagementStore: no tenant-specific SLA policy is bound; case creation and priority changes refuse');
  }

  if (options.skillServices?.unbound && options.skillServices.unbound.length > 0) {
    for (const item of options.skillServices.unbound) {
      unbound.push(item);
    }
  }

  if (options.adapters?.unbound && options.adapters.unbound.length > 0) {
    for (const item of options.adapters.unbound) {
      unbound.push(item);
    }
  }

  return Object.freeze(unbound);
}

/**
 * Creates a per-tenant RevenueOrchestrator factory function.
 */
export function createCareOrchestratorFactory(
  options: CareOrchestratorFactoryOptions = {},
): (tenant_id: string) => Promise<RevenueOrchestrator> {
  const workerId = options.workerId ?? `care_worker_${randomUUID().slice(0, 8)}`;
  const now = options.now ?? (() => new Date());

  const auditSecret = options.auditSecret ?? process.env.AUDIT_HMAC_SECRET;
  if (!auditSecret || auditSecret.trim().length === 0) {
    throw new Error('CARE_AUDIT_SECRET_REQUIRED: audit HMAC secret must be provided or configured in AUDIT_HMAC_SECRET environment variable.');
  }

  // 1. Adapters from createDurableAdapters if not supplied directly
  let workflowEngine = options.workflowEngine ?? options.adapters?.workflowEngine;
  let evidenceLogger = options.evidenceLogger ?? options.adapters?.evidenceLogger;
  let auditTrail = options.auditTrail ?? options.adapters?.auditTrail;
  let sessionControl = options.sessionControl ?? options.adapters?.sessionControl;
  let leaseManager = options.leaseManager ?? options.adapters?.leaseManager;

  if (!options.adapters && (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager)) {
    const generatedAdapters = createDurableAdapters({
      workflowRepository: options.workflowRepository ?? new DurableWorkflowRepository(),
      approvalRepository: options.approvalRepository ?? new ApprovalRepository(),
      evidenceRepository: options.evidenceRepository ?? new EvidenceRepository(),
      auditRepository: options.auditRepository ?? new AuditRepository(),
      conversationRepository: options.conversationRepository ?? new ConversationRepository(),
      auditSecret,
      now,
    });

    workflowEngine ??= generatedAdapters.workflowEngine;
    evidenceLogger ??= generatedAdapters.evidenceLogger;
    auditTrail ??= generatedAdapters.auditTrail;
    sessionControl ??= generatedAdapters.sessionControl;
    leaseManager ??= generatedAdapters.leaseManager;
  }

  // 2. EffectGuard over EffectReservationRepository
  const effectGuard: IEffectGuard = options.effectGuard ?? new EffectGuard({
    repository: options.effectReservationRepository ?? new EffectReservationRepository(),
  });

  // 3. Context aggregator with server-side identity resolution
  const aggregator = options.contextAggregator instanceof CareContextAggregator
    ? options.contextAggregator
    : new CareContextAggregator({
        ...(options.aggregatorRepositories ? { repositories: options.aggregatorRepositories } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
  const contextAggregator: IContextAggregator = options.contextAggregator ?? aggregator;

  const resolveGrant = options.resolve_grant ?? defaultResolveGrant;
  const resolveCorrelationId = options.resolve_correlation_id ?? ((tid, runId) => defaultResolveCorrelationId(tid, runId, options.workflowRepository));

  // 4. Adapter dispatcher from F4's skill services, created before the planner because the planner
  // reads its step metadata (effect class, guarded dependency, required authority, timeout) from
  // the same canonical registry: without it every Care intent falls closed to an empty plan.
  let adapterDispatcher = options.adapterDispatcher ?? options.skillServices?.dispatcher;
  let registry = options.registry ?? options.skillServices?.registry;
  if (!options.skillServices && !options.adapterDispatcher) {
    const skillServices = createCareSkillServices({
      erp_read: options.erp_read ?? null,
      env: options.env ?? {},
      ...(options.now ? { now: options.now } : {}),
      ...(options.case_sla_target_hours ? { case_sla_target_hours: options.case_sla_target_hours } : {}),
      ...(options.handoff_repository ? { handoff_repository: options.handoff_repository } : {}),
      skill_enablement: options.skill_enablement ?? DEFAULT_P1B_CARE_SKILL_ENABLEMENT,
      resolve_correlation_id: resolveCorrelationId,
      resolve_grant: resolveGrant,
    });
    adapterDispatcher = skillServices.dispatcher;
    registry ??= skillServices.registry;
  }

  // 5. Deterministic non-LLM agent runtime wired to aggregator.verificationReferenceFor
  const agentRuntime: IAgentRuntime = options.agentRuntime ?? new CareAgentRuntime({
    ...(options.now ? { now: options.now } : {}),
    ...(registry ? { registry } : {}),
    verificationReference: (correlation_id: string) => aggregator.verificationReferenceFor(correlation_id),
  });

  // 6. Policy engine adapter over PolicyEnforcementPoint bound to the durable audit boundary
  const policyEngine: IPolicyEngine = options.policyEngine ?? createCarePolicyEngine({
    auditSecret,
    ...(options.now ? { now: options.now } : {}),
    resolveGrant,
    audit: options.audit,
    auditTrail,
    auditRepository: options.auditRepository,
  });

  return async (_tenant_id: string): Promise<RevenueOrchestrator> => {
    if (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager) {
      throw new Error('CARE_ORCHESTRATOR_UNBOUND: missing required durable workflow/evidence adapters.');
    }

    if (!adapterDispatcher) {
      throw new Error('CARE_ORCHESTRATOR_UNBOUND: adapterDispatcher is not bound.');
    }

    return new RevenueOrchestrator({
      contextAggregator,
      agentRuntime,
      policyEngine,
      workflowEngine,
      evidenceLogger,
      auditTrail,
      adapterDispatcher,
      effectGuard,
      sessionControl,
      leaseManager,
      workerId,
      ...(options.crossDomainHandoff === undefined
        ? {}
        : { crossDomainHandoff: options.crossDomainHandoff }),
    });
  };
}

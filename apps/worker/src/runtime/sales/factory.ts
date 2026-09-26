/**
 * @file Sales Orchestrator Factory (implement/04 §3.2, implement/05 §4.2, implement/06 §8.1).
 *
 * Invariant:
 * Assembles the Sales domain-specific RevenueOrchestrator from:
 *   1. SalesContextAggregator (server-side customer identity hydration and real session-control takeover)
 *   2. SalesAgentRuntime (deterministic, non-LLM Sales agent logic)
 *   3. SalesPolicyEngine (validates drafts, adapts PEP authority, enforces owner-approved price floors)
 *   4. Durable workflow & evidence adapters over PostgreSQL/Redis (createDurableAdapters)
 *   5. Shared skill dispatcher over Sales skill services (forwarding approval_id and approval_payload_digest)
 *   6. EffectGuard over the durable reservation repository
 *
 * Missing audit secret, missing durable adapters, or missing correlation id fail closed
 * with explicit SALES_* refusal errors. Never authors an approval, never dispatches an effect directly,
 * and never reserves an effect key itself.
 */

import { randomUUID } from 'node:crypto';
import {
  computeEffectKey,
  computeRequestFingerprint,
  evaluateAuthorityVerdict,
  EffectGuard,
  RevenueOrchestrator,
  type PolicyAuditPort,
} from '@agentos/core-engine';
import type {
  AssignableAuthority,
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
import {
  createSkillRuntimeEngine,
  type SkillRegistry,
} from '@agentos/skills';

import {
  SalesAgentRuntime,
  type SalesPurchaseEvidencePort,
} from './agent-runtime.js';
import {
  SalesContextAggregator,
  createCustomerEventPurchaseEvidencePort,
  type SalesContextAggregatorRepositories,
  type SalesSessionControlPort,
} from './context-aggregator.js';
import { createDurableAdapters, type DurableAdapters } from '../shared/adapters.js';
import { createSkillAdapterDispatcher } from '../shared/skill-dispatcher.js';
import { createSalesPolicyEngine } from './policy-engine.js';
import { createSalesSkillServices } from './skills/index.js';
import type {
  ErpReadPort,
  SalesCartPort,
  SalesCommunicationPort,
  SalesConsentPort,
  SalesContextAggregatorLike,
  SalesFrequencyCapPort,
  SalesOrderPort,
  SalesPriceFloorPort,
  SalesRecommendationRevenueEvidencePort,
  SalesReplenishmentPolicyPort,
  SalesSkillServices,
} from './skills/types.js';

export interface SalesAdaptersShape extends DurableAdapters {
  readonly unbound?: readonly string[] | undefined;
}

export interface SalesOrchestratorFactoryOptions {
  readonly workerId?: string | undefined;
  readonly contextAggregator?: IContextAggregator | undefined;
  readonly agentRuntime?: IAgentRuntime | undefined;
  readonly policyEngine?: IPolicyEngine | undefined;
  readonly workflowEngine?: IStatefulWorkflowEngine | undefined;
  readonly evidenceLogger?: IEvidenceLogger | undefined;
  readonly auditTrail?: IAuditTrail | undefined;
  readonly sessionControl?: ISessionControl | undefined;
  readonly leaseManager?: DurableLeaseManager | undefined;
  readonly effectGuard?: IEffectGuard | undefined;
  readonly adapterDispatcher?: IAdapterDispatcher | undefined;
  readonly skillServices?: SalesSkillServices | undefined;
  readonly adapters?: SalesAdaptersShape | undefined;
  readonly registry?: SkillRegistry | undefined;
  readonly effectReservationRepository?: EffectReservationRepository | undefined;
  readonly aggregatorRepositories?: SalesContextAggregatorRepositories | undefined;
  readonly workflowRepository?: DurableWorkflowRepository | undefined;
  readonly approvalRepository?: ApprovalRepository | undefined;
  readonly evidenceRepository?: EvidenceRepository | undefined;
  readonly auditRepository?: AuditRepository | undefined;
  readonly conversationRepository?: ConversationRepository | undefined;
  readonly auditSecret?: string | undefined;
  readonly erp_read?: ErpReadPort | null | undefined;
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  readonly price_floor?: SalesPriceFloorPort | null | undefined;
  readonly cart?: SalesCartPort | null | undefined;
  readonly order?: SalesOrderPort | null | undefined;
  readonly communication?: SalesCommunicationPort | null | undefined;
  readonly consent?: SalesConsentPort | null | undefined;
  readonly frequency_cap?: SalesFrequencyCapPort | null | undefined;
  readonly replenishment_policy?: SalesReplenishmentPolicyPort | null | undefined;
  readonly purchase_evidence?: SalesPurchaseEvidencePort | null | undefined;
  readonly now?: (() => Date) | undefined;
  readonly resolve_grant?: ((tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>) | undefined;
  readonly resolve_correlation_id?: ((tenant_id: string, run_id: string) => Promise<string>) | undefined;
  readonly audit?: PolicyAuditPort | null | undefined;
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
 * Throws SALES_CORRELATION_REQUIRED if no durable task exists or if correlation_id is missing.
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
      `SALES_CORRELATION_REQUIRED: durable task for run_id '${run_id}' in tenant '${tenant_id}' was not found or lacks correlation_id.`,
    );
  }
  return task.correlation_id;
}

/**
 * Returns list of capabilities that are unbound in the given configuration, with reasons.
 */
export function getSalesUnboundCapabilities(options: SalesOrchestratorFactoryOptions = {}): readonly string[] {
  const unbound: string[] = [];

  if (!options.adapterDispatcher && !options.skillServices?.dispatcher) {
    if (options.erp_read === null || options.erp_read === undefined) {
      unbound.push('API-001 (unbound ERP read: no ERP read connector is bound)');
    }
    const priceFloor = options.price_floor;
    if (!priceFloor) {
      unbound.push('API-001.PricingEngine (unbound price/floor: no pricing engine port is bound; skill.sales.check_price refuses)');
    }
    const cart = options.cart;
    if (!cart) {
      unbound.push('API-002.CommerceCartAPI (unbound cart: no cart port is bound; skill.sales.create_cart refuses)');
    }
    const order = options.order;
    if (!order) {
      unbound.push('API-001.OrderConnector (unbound order: no order connector port is bound; skill.sales.create_order refuses)');
    }
    const communication = options.communication;
    if (!communication) {
      unbound.push('API-003.CommunicationConnector (unbound communication: no communication port is bound; skill.sales.send_message refuses)');
    }
    const consent = options.consent;
    if (!consent) {
      unbound.push('SalesConsent (unbound consent: no consent port is bound; skill.sales.send_message refuses)');
    }
    const frequencyCap = options.frequency_cap;
    if (!frequencyCap) {
      unbound.push('SalesFrequencyCap (unbound frequency cap: no frequency cap port is bound; skill.sales.send_message refuses)');
    }
    const replenishmentPolicy = options.replenishment_policy;
    if (!replenishmentPolicy) {
      unbound.push('SalesReplenishmentPolicy (unbound replenishment policy: no replenishment policy port is bound; SAL-05 replenishment refuses)');
    }
    const purchaseEvidence = options.purchase_evidence;
    if (!purchaseEvidence && !options.aggregatorRepositories?.customerEventRepository && !options.aggregatorRepositories?.listTimeline) {
      unbound.push(
        'SalesPurchaseEvidence (unbound purchase evidence: no purchase evidence port is bound; SAL-05 replenishment refuses)',
      );
    }
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
 * Creates a per-tenant RevenueOrchestrator factory function for Sales.
 */
export function createSalesOrchestratorFactory(
  options: SalesOrchestratorFactoryOptions = {},
): (tenant_id: string) => Promise<RevenueOrchestrator> {
  const workerId = options.workerId ?? `sales_worker_${randomUUID().slice(0, 8)}`;
  const now = options.now ?? (() => new Date());

  const auditSecret = options.auditSecret ?? process.env.AUDIT_HMAC_SECRET;
  if (!auditSecret || auditSecret.trim().length === 0) {
    throw new Error('SALES_AUDIT_SECRET_REQUIRED: audit HMAC secret must be provided or configured in AUDIT_HMAC_SECRET environment variable.');
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

  // 3. Context aggregator with session control port so takeover is real
  const sessionControlPort: SalesSessionControlPort | undefined = sessionControl
    ? {
        isTakenOver: async (tenant_id: string, session_id: string) =>
          sessionControl.isTakenOver(tenant_id, session_id),
      }
    : undefined;

  const aggregator = options.contextAggregator instanceof SalesContextAggregator
    ? options.contextAggregator
    : new SalesContextAggregator({
        ...(options.aggregatorRepositories ? { repositories: options.aggregatorRepositories } : {}),
        ...(sessionControlPort ? { sessionControl: sessionControlPort } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
  const contextAggregator: IContextAggregator = options.contextAggregator ?? aggregator;

  const resolveGrant = options.resolve_grant ?? defaultResolveGrant;
  const resolveCorrelationId =
    options.resolve_correlation_id ??
    ((tid, runId) => defaultResolveCorrelationId(tid, runId, options.workflowRepository));

  // 4. Skills services and adapter dispatcher
  const priceFloorPort = options.price_floor ?? null;
  const cartPort = options.cart ?? null;
  const orderPort = options.order ?? null;
  const commPort = options.communication ?? null;
  const consentPort = options.consent ?? null;
  const freqCapPort = options.frequency_cap ?? null;
  const replenishmentPort = options.replenishment_policy ?? null;

  let skillServices = options.skillServices;
  let registry = options.registry ?? skillServices?.registry;

  if (!skillServices && (!options.adapterDispatcher || !registry)) {
    const skillContext: SalesContextAggregatorLike =
      options.contextAggregator &&
      'takeoverActiveFor' in options.contextAggregator &&
      typeof (options.contextAggregator as Record<string, unknown>).takeoverActiveFor === 'function'
        ? (options.contextAggregator as unknown as SalesContextAggregatorLike)
        : aggregator;

    skillServices = createSalesSkillServices({
      erp_read: options.erp_read ?? null,
      context: skillContext,
      ...(options.revenue_evidence ? { revenue_evidence: options.revenue_evidence } : {}),
      price_floor: priceFloorPort,
      cart: cartPort,
      order: orderPort,
      communication: commPort,
      consent: consentPort,
      frequency_cap: freqCapPort,
      replenishment_policy: replenishmentPort,
      resolve_correlation_id: resolveCorrelationId,
      resolve_grant: resolveGrant,
      now,
    });
    registry ??= skillServices.registry;
  }

  let adapterDispatcher = options.adapterDispatcher;
  if (!adapterDispatcher) {
    const runtimeEngine = skillServices?.engine ?? (registry ? createSkillRuntimeEngine({
      registry,
      digestPayload: (payload) => computeRequestFingerprint(payload as Record<string, unknown>),
      deriveEffectKey: (identity) => computeEffectKey(identity),
      evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
      now: () => now().getTime(),
    }) : undefined);

    if (runtimeEngine) {
      adapterDispatcher = createSkillAdapterDispatcher({
        engine: runtimeEngine,
        resolve_correlation_id: resolveCorrelationId,
        resolve_grant: resolveGrant,
      });
    }
  }
  const purchaseEvidenceOpt = options.purchase_evidence;
  let purchaseEvidencePort: SalesPurchaseEvidencePort | undefined;

  if (purchaseEvidenceOpt !== null && purchaseEvidenceOpt !== undefined) {
    purchaseEvidencePort = purchaseEvidenceOpt;
  } else if (purchaseEvidenceOpt === undefined) {
    if (aggregator instanceof SalesContextAggregator) {
      purchaseEvidencePort = aggregator.createPurchaseEvidencePort();
    } else if (options.aggregatorRepositories?.listTimeline) {
      purchaseEvidencePort = createCustomerEventPurchaseEvidencePort(options.aggregatorRepositories.listTimeline);
    } else if (options.aggregatorRepositories?.customerEventRepository) {
      const repo = options.aggregatorRepositories.customerEventRepository;
      purchaseEvidencePort = createCustomerEventPurchaseEvidencePort((query) => repo.listTimeline(query));
    }
  }

  // 5. Agent runtime wired with registry, replenishment_policy, and purchase_evidence
  const agentRuntime: IAgentRuntime = options.agentRuntime ?? new SalesAgentRuntime({
    ...(options.now ? { now: options.now } : {}),
    ...(registry ? { registry } : {}),
    ...(replenishmentPort ? { replenishment_policy: replenishmentPort } : {}),
    ...(purchaseEvidencePort ? { purchase_evidence: purchaseEvidencePort } : {}),
  });

  // 6. Policy engine adapter
  const policyEngine: IPolicyEngine = options.policyEngine ?? createSalesPolicyEngine({
    price_floor: priceFloorPort,
    consent: consentPort,
    auditSecret,
    ...(options.now ? { now: options.now } : {}),
    resolveGrant,
    audit: options.audit,
    auditTrail,
    auditRepository: options.auditRepository,
  });

  return async (_tenant_id: string): Promise<RevenueOrchestrator> => {
    if (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager) {
      throw new Error('SALES_ORCHESTRATOR_UNBOUND: missing required durable workflow/evidence adapters.');
    }

    if (!adapterDispatcher) {
      throw new Error('SALES_ORCHESTRATOR_UNBOUND: adapterDispatcher is not bound.');
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
    });
  };
}

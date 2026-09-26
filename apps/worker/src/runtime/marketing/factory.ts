/**
 * Shared P2 worker factory for Marketing.
 *
 * Marketing does not own a second task runner: this factory assembles the same
 * RevenueOrchestrator, durable adapters, policy boundary, effect guard, and
 * Marketing skill dispatcher used by the Care and Sales factories.
 */

import {
  EffectGuard,
  OrchestratorError,
  RevenueOrchestrator,
  type PolicyEnforcementOptions,
  type PolicyRegistrySkill,
} from '@agentos/core-engine';
import type {
  ActionDraft,
  AssignableAuthority,
  AuthorityLevel,
  HydratedContext,
  IAgentRuntime,
  IContextAggregator,
  IEffectGuard,
  IPolicyEngine,
  IStatefulWorkflowEngine,
  PlatformAgentId,
  RoutingDecision,
  SignalEnvelope,
  SignalSubject,
  HypothesisRecord,
  ExecutionPlan,
} from '@agentos/core-engine/contracts';
import type {
  DurableLeaseManager,
  IAdapterDispatcher,
  IAuditTrail,
  IEvidenceLogger,
  ISessionControl,
} from '@agentos/core-engine/contracts';
import {
  AuditRepository,
  ApprovalRepository,
  ConversationRepository,
  DurableWorkflowRepository,
  EffectReservationRepository,
  EvidenceRepository,
} from '@agentos/database';

import {
  createDurableAdapters,
  type DurableAdapters,
} from '../shared/adapters.js';
import { createPolicyAuditSink } from '../shared/policy-audit.js';
import { DomainPolicyEngine } from '../shared/policy-engine.js';
import {
  defaultResolveCorrelationId,
  defaultResolveGrant,
} from '../sales/factory.js';
import {
  createMarketingSkillServices,
  type MarketingSkillOptions,
  type MarketingSkillServices,
} from './skills/index.js';

const MARKETING_AGENT_BY_SKILL: Readonly<Record<string, PlatformAgentId>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 'MKT-01',
  'skill.mkt.segment_audience': 'MKT-02',
  'skill.mkt.check_consent': 'MKT-02',
  'skill.mkt.generate_content': 'MKT-03',
  'skill.mkt.audit_brand_compliance': 'MKT-04',
  'skill.mkt.dispatch_campaign': 'MKT-05',
  'skill.mkt.evaluate_attribution': 'MKT-06',
});

const MARKETING_ADAPTER_BY_SKILL: Readonly<Record<string, string>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 'API-002.EventIngestion',
  'skill.mkt.segment_audience': 'PostgreSQL.Customer360Store',
  'skill.mkt.check_consent': 'API-002.ConsentStore',
  'skill.mkt.generate_content': 'Core.LLMContentEngine',
  'skill.mkt.audit_brand_compliance': 'SecondBrain.BrandGuard',
  'skill.mkt.dispatch_campaign': 'API-003.CommunicationConnector',
  'skill.mkt.evaluate_attribution': 'PostgreSQL.AnalyticsStore',
});

const MARKETING_AUTHORITY_BY_SKILL: Readonly<Record<string, AuthorityLevel>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 'AUTH-1',
  'skill.mkt.segment_audience': 'AUTH-1',
  'skill.mkt.check_consent': 'AUTH-3',
  'skill.mkt.generate_content': 'AUTH-2',
  'skill.mkt.audit_brand_compliance': 'AUTH-1',
  'skill.mkt.dispatch_campaign': 'AUTH-4',
  'skill.mkt.evaluate_attribution': 'AUTH-1',
});

const MARKETING_MUTATING: Readonly<Record<string, boolean>> = Object.freeze({
  'skill.mkt.dispatch_campaign': true,
});

const MARKETING_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 5000,
  'skill.mkt.segment_audience': 5000,
  'skill.mkt.check_consent': 3000,
  'skill.mkt.generate_content': 10000,
  'skill.mkt.audit_brand_compliance': 5000,
  'skill.mkt.dispatch_campaign': 5000,
  'skill.mkt.evaluate_attribution': 5000,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function signalInput(signal: SignalEnvelope, tenant_id: string): Record<string, unknown> {
  const raw = asRecord(signal.payload['input']) ?? { ...signal.payload };
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'module' && key !== 'skill_id' && key !== 'agent_id' && value !== undefined) {
      input[key] = value;
    }
  }
  if (input['tenant_id'] === undefined) {
    input['tenant_id'] = tenant_id;
  }
  return input;
}

function skillId(signal: SignalEnvelope): string {
  const value = signal.payload['skill_id'];
  if (typeof value !== 'string' || !Object.hasOwn(MARKETING_AGENT_BY_SKILL, value)) {
    throw new Error('MARKETING_SIGNAL_INVALID: payload.skill_id must name a canonical Marketing skill');
  }
  return value;
}

class MarketingContextAggregator implements IContextAggregator {
  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    return {
      tenant_id,
      correlation_id,
      customer: null,
      working_memory: {
        session_id: subject.session_id,
        ...(subject.conversation_id === undefined ? {} : { conversation_id: subject.conversation_id }),
        last_touch_channel: subject.channel_type,
        turn_count: 0,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: new Date().toISOString(),
    };
  }
}

class MarketingAgentRuntime implements IAgentRuntime {
  private readonly signals = new Map<string, SignalEnvelope>();

  async deriveHypothesis(signal: SignalEnvelope, _context: HydratedContext): Promise<HypothesisRecord> {
    const id = skillId(signal);
    this.signals.set(signal.signal_id, signal);
    return {
      classification: 'HYPOTHESIS',
      intent: 'marketing:' + id,
      confidence: 1,
      churn_risk_score: 0,
      purchase_propensity: 0,
      reasoning: 'Marketing routing is selected from the server-validated canonical skill id.',
      derived_from_signals: [signal.signal_id],
    };
  }

  async resolveRouting(
    signal: SignalEnvelope,
    _context: HydratedContext,
    _hypothesis: HypothesisRecord,
  ): Promise<RoutingDecision> {
    const id = skillId(signal);
    return {
      target_agent: MARKETING_AGENT_BY_SKILL[id]!,
      requires_clarification: false,
      rationalization: 'Shared Marketing runtime route for ' + id + '.',
    };
  }

  async formulatePlan(
    _routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const signalId = hypothesis.derived_from_signals[0];
    const signal = typeof signalId === 'string' ? this.signals.get(signalId) : undefined;
    if (!signal) {
      throw new Error('MARKETING_SIGNAL_CONTEXT_LOST: signal was not retained across shared planning stages');
    }
    this.signals.delete(signal.signal_id);
    const id = skillId(signal);
    const agent_id = MARKETING_AGENT_BY_SKILL[id]!;
    const input_parameters = signalInput(signal, context.tenant_id);
    return {
      plan_id: 'plan_' + signal.signal_id,
      steps: [{
        step_index: 1,
        agent_id,
        skill_id: id,
        adapter_target: MARKETING_ADAPTER_BY_SKILL[id]!,
        input_parameters,
        required_authority: MARKETING_AUTHORITY_BY_SKILL[id]!,
        mutating: MARKETING_MUTATING[id] === true,
        price_bearing: id === 'skill.mkt.dispatch_campaign' && (
          typeof input_parameters['proposed_price'] === 'number'
          || typeof input_parameters['discount_percent'] === 'number'
          || typeof input_parameters['discount_amount'] === 'number'
          || typeof input_parameters['offer_id'] === 'string'
        ),
        idempotent: id !== 'skill.mkt.dispatch_campaign',
        timeout_ms: MARKETING_TIMEOUT_MS[id]!,
      }],
      fallback_strategy: 'FAIL_CLOSED',
    };
  }
}

function policySkills(): Readonly<Record<string, PolicyRegistrySkill>> {
  const result: Record<string, PolicyRegistrySkill> = {};
  for (const skill_id of Object.keys(MARKETING_AGENT_BY_SKILL)) {
    result[skill_id] = {
      skill_id,
      allowed_agents: Object.freeze([MARKETING_AGENT_BY_SKILL[skill_id]!]),
      required_authority: MARKETING_AUTHORITY_BY_SKILL[skill_id]!,
      mutating: MARKETING_MUTATING[skill_id] === true,
      // Price-bearing is an action-level property; a dispatch row may carry no price at all.
      price_bearing: false,
      idempotent: skill_id !== 'skill.mkt.dispatch_campaign',
      epistemic_class: skill_id === 'skill.mkt.dispatch_campaign' ? 'ACTION' : 'HYPOTHESIS',
      write_target: skill_id === 'skill.mkt.dispatch_campaign' ? 'FACT' : 'HYPOTHESIS',
      // Consent is rechecked by the canonical Marketing communication tool immediately before provider dispatch.
      requires_consent: false,
      requires_verified_identity: false,
      timeout_ms: MARKETING_TIMEOUT_MS[skill_id]!,
    };
  }
  return Object.freeze(result);
}

export interface MarketingAuthoritativeValidationResult {
  readonly computed_price_floor?: number;
  readonly floor_source?: string;
  readonly proposed_price?: number;
}

export type MarketingAuthoritativeValidation = (
  payload: Readonly<Record<string, unknown>>,
  context: HydratedContext,
) => void | MarketingAuthoritativeValidationResult | Promise<void | MarketingAuthoritativeValidationResult>;

class SharedMarketingPolicyEngine implements IPolicyEngine {
  constructor(
    private readonly base: IPolicyEngine,
    private readonly validateAuthoritative?: MarketingAuthoritativeValidation,
  ) {}

  async validateAction(action: ActionDraft, context: HydratedContext): Promise<ActionDraft> {
    const validated = await this.base.validateAction(action, context);
    if (action.skill_id !== 'skill.mkt.dispatch_campaign') {
      return validated;
    }
    const payload = validated.payload;
    const proposedPrice = payload['proposed_price'];
    const hasPromotionClaim = payload['offer_id'] !== undefined
      || payload['discount_percent'] !== undefined
      || payload['discount_amount'] !== undefined;
    if (proposedPrice !== undefined) {
      if (typeof proposedPrice !== 'number' || !Number.isFinite(proposedPrice)) {
        throw new OrchestratorError('SCHEMA_VALIDATION_ERROR', 'proposed_price must be a finite number');
      }
      const source = payload['price_source'];
      if (typeof source !== 'string' || source.trim().length === 0) {
        throw new OrchestratorError('PRICE_PROVENANCE_REQUIRED', 'price_source is required for price-bearing Marketing dispatch');
      }
    }
    if (hasPromotionClaim) {
      const provenance = payload['promotion_provenance'] ?? payload['promotion_source'];
      if (typeof provenance !== 'string' || provenance.trim().length === 0) {
        throw new OrchestratorError('PROMOTION_PROVENANCE_REQUIRED', 'promotion provenance is required for offer or discount claims');
      }
    }
    if ((proposedPrice !== undefined || hasPromotionClaim) && !this.validateAuthoritative) {
      throw new OrchestratorError(
        proposedPrice !== undefined ? 'PRICE_PROVENANCE_REQUIRED' : 'PROMOTION_PROVENANCE_REQUIRED',
        'authoritative Marketing pricing/promotion validation is unavailable; dispatch refused',
      );
    }
    if ((proposedPrice !== undefined || hasPromotionClaim) && this.validateAuthoritative) {
      const authoritative = await this.validateAuthoritative(payload, context);
      if (proposedPrice !== undefined) {
        if (authoritative === undefined || typeof authoritative !== 'object') {
          throw new OrchestratorError('PRICE_PROVENANCE_REQUIRED', 'authoritative floor/source data is required for price-bearing Marketing dispatch');
        }
        if (authoritative.proposed_price !== proposedPrice) {
          throw new OrchestratorError('PRICE_MISMATCH', 'proposed_price does not match the authoritative price');
        }
        if (typeof authoritative.computed_price_floor !== 'number' || !Number.isFinite(authoritative.computed_price_floor)
          || typeof authoritative.floor_source !== 'string' || authoritative.floor_source.trim().length === 0) {
          throw new OrchestratorError('PRICE_PROVENANCE_REQUIRED', 'authoritative floor and floor_source are required for price-bearing Marketing dispatch');
        }
        return {
          ...validated,
          computed_price_floor: authoritative.computed_price_floor,
          floor_source: authoritative.floor_source.trim(),
          proposed_price: authoritative.proposed_price,
        };
      }
    }
    return validated;
  }

  evaluateAuthority(action: ActionDraft, context: HydratedContext) {
    return this.base.evaluateAuthority(action, context);
  }
}

function allowedPayloadFields(
  services: MarketingSkillServices,
): Readonly<Record<string, Readonly<Record<string, true>>>> {
  const result: Record<string, Readonly<Record<string, true>>> = {};
  for (const skill_id of Object.keys(MARKETING_AGENT_BY_SKILL)) {
    const row = services.registry.resolve(skill_id);
    const rowRecord = asRecord(row);
    const schema = asRecord(rowRecord?.['input_schema']);
    const properties = asRecord(schema?.['properties']);
    if (!properties) {
      throw new Error(`MARKETING_SCHEMA_UNBOUND: canonical input schema missing for ${skill_id}`);
    }
    const fields = Object.fromEntries(Object.keys(properties).map((key) => [key, true as const]));
    if (skill_id === 'skill.mkt.dispatch_campaign') {
      fields['effect_key'] = true;
    }
    result[skill_id] = Object.freeze(fields);
  }
  return Object.freeze(result);
}

export interface MarketingOrchestratorFactoryOptions {
  readonly workerId?: string;
  readonly contextAggregator?: IContextAggregator;
  readonly agentRuntime?: IAgentRuntime;
  readonly policyEngine?: IPolicyEngine;
  readonly workflowEngine?: IStatefulWorkflowEngine;
  readonly evidenceLogger?: IEvidenceLogger;
  readonly auditTrail?: IAuditTrail;
  readonly sessionControl?: ISessionControl;
  readonly leaseManager?: DurableLeaseManager;
  readonly effectGuard?: IEffectGuard;
  readonly adapterDispatcher?: IAdapterDispatcher;
  readonly skillServices?: MarketingSkillServices;
  readonly skillOptions?: Partial<MarketingSkillOptions>;
  readonly adapters?: DurableAdapters;
  readonly workflowRepository?: DurableWorkflowRepository;
  readonly approvalRepository?: ApprovalRepository;
  readonly evidenceRepository?: EvidenceRepository;
  readonly auditRepository?: AuditRepository;
  readonly conversationRepository?: ConversationRepository;
  readonly effectReservationRepository?: EffectReservationRepository;
  readonly auditSecret?: string;
  readonly now?: () => Date;
  readonly resolve_grant?: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  readonly resolve_correlation_id?: (tenant_id: string, run_id: string) => Promise<string>;
  readonly audit?: PolicyEnforcementOptions['audit'] | null;
  readonly validateAuthoritative?: MarketingAuthoritativeValidation;
}

/**
 * Creates the Marketing RevenueOrchestrator factory used by the shared P2 worker registry.
 * Missing provider ports remain fail-closed in the canonical Marketing skill dispatcher.
 */
export function createMarketingOrchestratorFactory(
  options: MarketingOrchestratorFactoryOptions = {},
): (tenant_id: string) => Promise<RevenueOrchestrator> {
  const auditSecret = options.auditSecret ?? process.env.AUDIT_HMAC_SECRET;
  if (!auditSecret || auditSecret.trim().length === 0) {
    throw new Error('MARKETING_AUDIT_SECRET_REQUIRED: audit HMAC secret must be provided or configured in AUDIT_HMAC_SECRET.');
  }

  const now = options.now ?? (() => new Date());
  const workflowRepository = options.workflowRepository ?? new DurableWorkflowRepository();
  let workflowEngine = options.workflowEngine ?? options.adapters?.workflowEngine;
  let evidenceLogger = options.evidenceLogger ?? options.adapters?.evidenceLogger;
  let auditTrail = options.auditTrail ?? options.adapters?.auditTrail;
  let sessionControl = options.sessionControl ?? options.adapters?.sessionControl;
  let leaseManager = options.leaseManager ?? options.adapters?.leaseManager;

  if (!options.adapters && (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager)) {
    const durable = createDurableAdapters({
      workflowRepository,
      approvalRepository: options.approvalRepository ?? new ApprovalRepository(),
      evidenceRepository: options.evidenceRepository ?? new EvidenceRepository(),
      auditRepository: options.auditRepository ?? new AuditRepository(),
      conversationRepository: options.conversationRepository ?? new ConversationRepository(),
      auditSecret,
      now,
    });
    workflowEngine ??= durable.workflowEngine;
    evidenceLogger ??= durable.evidenceLogger;
    auditTrail ??= durable.auditTrail;
    sessionControl ??= durable.sessionControl;
    leaseManager ??= durable.leaseManager;
  }

  const effectGuard = options.effectGuard ?? new EffectGuard({
    repository: options.effectReservationRepository ?? new EffectReservationRepository(),
  });
  const resolveGrant = options.resolve_grant ?? defaultResolveGrant;
  const resolveCorrelationId = options.resolve_correlation_id
    ?? ((tenant_id, run_id) => defaultResolveCorrelationId(tenant_id, run_id, workflowRepository));

  const skillOptions: MarketingSkillOptions = {
    ...(options.skillOptions ?? {}),
    resolve_correlation_id: resolveCorrelationId,
    resolve_grant: resolveGrant,
    ...(options.now === undefined ? {} : { now }),
  };
  const services = options.skillServices ?? createMarketingSkillServices(skillOptions);
  const adapterDispatcher = options.adapterDispatcher ?? services.dispatcher;
  const contextAggregator = options.contextAggregator ?? new MarketingContextAggregator();
  const agentRuntime = options.agentRuntime ?? new MarketingAgentRuntime();
  const policyAudit = options.audit === null
    ? undefined
    : options.audit ?? (auditTrail ? createPolicyAuditSink(auditTrail) : undefined);
  const basePolicyEngine = options.policyEngine ?? new DomainPolicyEngine({
    skills: policySkills(),
    allowed_payload_fields: allowedPayloadFields(services),
    resolveGrant,
    auditSecret,
    ...(policyAudit ? { audit: policyAudit } : {}),
    ...(options.now === undefined ? {} : { now }),
  });
  const policyEngine: IPolicyEngine = new SharedMarketingPolicyEngine(
    basePolicyEngine,
    options.validateAuthoritative,
  );

  return async (_tenant_id: string): Promise<RevenueOrchestrator> => {
    if (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager) {
      throw new Error('MARKETING_ORCHESTRATOR_UNBOUND: missing shared durable workflow/evidence adapters.');
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
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    });
  };
}

/** Exposed for worker composition and focused routing tests. */
export const MARKETING_SIGNAL_CONTRACT_DEFAULTS = Object.freeze({
  source_channels: Object.freeze(['MARKETING_CAMPAIGN']),
  event_types: Object.freeze(['campaign.requested']),
});


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
  type AutonomyAdmissionPort,
  type PolicyRegistrySkill,
} from '@agentos/core-engine';
import type {
  ActionDraft,
  AssignableAuthority,
  AuthorityLevel,
  Customer360Fact,
  HydratedContext,
  IAgentRuntime,
  IContextAggregator,
  IEffectGuard,
  IPolicyEngine,
  IResponseFinalizer,
  IRunResponseStore,
  IRunStageRecorder,
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
  HandoffIntent,
  IAdapterDispatcher,
  IAuditTrail,
  ICrossDomainHandoffBroker,
  IEvidenceLogger,
  IPlanInputResolver,
  ISessionControl,
} from '@agentos/core-engine/contracts';
import type { WorkerConnectorEnv } from '../connectors.js';
import {
  AuditRepository,
  ApprovalRepository,
  ConversationRepository,
  DurableWorkflowRepository,
  EffectReservationRepository,
  EvidenceRepository,
  RunResponseRepository,
  getProfile as dbGetProfile,
  type CustomerProfileRow,
} from '@agentos/database';

import {
  createDurableAdapters,
  DEFAULT_PLAN_INPUT_RESOLVER,
  type DurableAdapters,
} from '../shared/adapters.js';
import {
  createResponseFinalizer,
  createRunResponseStore,
} from '../shared/response.js';
import { DomainPolicyEngine } from '../shared/policy-engine.js';
import { createPolicyAuditSink } from '../shared/policy-audit.js';
import {
  defaultResolveCorrelationId,
  defaultResolveGrant,
} from '../sales/factory.js';
import {
  createMarketingSkillServices,
  type InputMktGenerateContent,
  type MarketingSkillOptions,
  type MarketingSkillServices,
} from './skills/index.js';
import { createMarketingKnowledgePort } from './knowledge-adapter.js';
import type { MarketingPolicyPort } from './contracts.js';
type MarketingFactoryEnv = WorkerConnectorEnv & {
  readonly AUDIT_HMAC_SECRET?: string;
};

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
  'skill.mkt.analyze_market_signal': 3000,
  'skill.mkt.segment_audience': 2500,
  'skill.mkt.check_consent': 1000,
  'skill.mkt.generate_content': 18000,
  'skill.mkt.audit_brand_compliance': 2000,
  'skill.mkt.dispatch_campaign': 5000,
  'skill.mkt.evaluate_attribution': 4000,
});

const DEFAULT_CAMPAIGN_THEME = 'Customer reactivation campaign';
/**
 * Safe fallback when no tenant owner policy is available. This is intentionally conservative;
 * callers requesting more recipients must supply an owner-approved policy value.
 */
const DEFAULT_MARKETING_AUDIENCE_LIMIT = 100;
const DEFAULT_CONTENT_CHANNEL: InputMktGenerateContent['channel'] = 'EMAIL_HTML';
const DEFAULT_CONTENT_LOCALE: InputMktGenerateContent['locale'] = 'en-US';
const CONTENT_CHANNELS: readonly InputMktGenerateContent['channel'][] = Object.freeze([
  'LINE_FLEX',
  'WHATSAPP_TEMPLATE',
  'EMAIL_HTML',
  'SMS_TEXT',
  'ZALO_ZNS',
  'TIKTOK_CARD',
  'MESSENGER_GENERIC',
  'INSTAGRAM_DIRECT',
]);
const CONTENT_LOCALES: readonly InputMktGenerateContent['locale'][] = Object.freeze([
  'zh-TW',
  'en-US',
  'vi-VN',
  'ja-JP',
]);

type MarketingDispatchChannel =
  | 'LINE'
  | 'WHATSAPP'
  | 'EMAIL'
  | 'SMS'
  | 'ZALO'
  | 'TIKTOK'
  | 'MESSENGER'
  | 'INSTAGRAM';
const DISPATCH_CHANNEL_BY_CONTENT_CHANNEL: Readonly<Record<InputMktGenerateContent['channel'], MarketingDispatchChannel>> = Object.freeze({
  LINE_FLEX: 'LINE',
  WHATSAPP_TEMPLATE: 'WHATSAPP',
  EMAIL_HTML: 'EMAIL',
  SMS_TEXT: 'SMS',
  ZALO_ZNS: 'ZALO',
  TIKTOK_CARD: 'TIKTOK',
  MESSENGER_GENERIC: 'MESSENGER',
  INSTAGRAM_DIRECT: 'INSTAGRAM',
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
    throw new OrchestratorError('MARKETING_SIGNAL_INVALID', 'payload.skill_id must name a canonical Marketing skill');
  }
  return value;
}
function isCampaignRequest(signal: SignalEnvelope): boolean {
  const payload = asRecord(signal.payload['input']) ?? signal.payload;
  if (typeof payload['objective'] !== 'string') return false;
  return signal.event_type === 'campaign.requested' || payload['module'] === 'marketing';
}

interface NormalizedCampaignRequest {
  readonly campaign_id: string;
  readonly segment_id: string;
  readonly objective: 'reactivation';
  readonly min_days_inactive: number;
  readonly max_segment_size?: number;
  readonly instruction: string;
  readonly content_channel: InputMktGenerateContent['channel'];
  readonly content_locale: InputMktGenerateContent['locale'];
}

function normalizedContentConstraints(
  raw: Readonly<Record<string, unknown>>,
): Pick<NormalizedCampaignRequest, 'content_channel' | 'content_locale'> {
  const constraints = raw['content_constraints'];
  if (constraints === undefined) {
    return {
      content_channel: DEFAULT_CONTENT_CHANNEL,
      content_locale: DEFAULT_CONTENT_LOCALE,
    };
  }
  const record = asRecord(constraints);
  if (record === null) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested content_constraints must be an object when supplied',
    );
  }
  const channel = record['channel'];
  const locale = record['locale'];
  if (
    typeof channel !== 'string'
    || !CONTENT_CHANNELS.includes(channel as InputMktGenerateContent['channel'])
    || typeof locale !== 'string'
    || !CONTENT_LOCALES.includes(locale as InputMktGenerateContent['locale'])
  ) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested content_constraints must name a supported channel and locale',
    );
  }
  return {
    content_channel: channel as InputMktGenerateContent['channel'],
    content_locale: locale as InputMktGenerateContent['locale'],
  };
}

function normalizedCampaignRequest(signal: SignalEnvelope, tenant_id: string): NormalizedCampaignRequest {
  const raw = signalInput(signal, tenant_id);
  const objective = raw['objective'];
  if (objective !== 'reactivation' && objective !== 'winback') {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested objective must be reactivation or its server-normalized winback alias',
    );
  }
  const segment_id = raw['segment_id'];
  if (typeof segment_id !== 'string' || !/^inactive_[1-9][0-9]*d$/.test(segment_id)) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested segment_id must be a server-normalized inactive_Nd segment',
    );
  }
  const parsedDays = Number(segment_id.slice('inactive_'.length, -1));
  const rawDays = raw['min_days_inactive'];
  const min_days_inactive = rawDays === undefined ? parsedDays : rawDays;
  if (
    typeof min_days_inactive !== 'number'
    || !Number.isSafeInteger(min_days_inactive)
    || min_days_inactive !== parsedDays
    || min_days_inactive < 1
  ) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested inactivity threshold is not bound to its segment identifier',
    );
  }
  const instruction = raw['instruction'];
  if (instruction !== undefined && (typeof instruction !== 'string' || instruction.trim().length === 0 || instruction.length > 2000)) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested instruction must be a bounded non-empty string <= 2000 chars when supplied',
    );
  }
  const requestedSize = raw['max_segment_size'];
  if (
    requestedSize !== undefined
    && (
      typeof requestedSize !== 'number'
      || !Number.isSafeInteger(requestedSize)
      || requestedSize < 1
    )
  ) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested max_segment_size must be a positive safe integer when supplied',
    );
  }
  const campaign_id = raw['campaign_id'];
  const contentConstraints = normalizedContentConstraints(raw);
  return {
    campaign_id: typeof campaign_id === 'string' && campaign_id.trim().length > 0
      ? campaign_id
      : `campaign-${signal.signal_id}`,
    segment_id,
    objective: 'reactivation',
    min_days_inactive,
    ...(requestedSize === undefined ? {} : { max_segment_size: requestedSize }),
    instruction: typeof instruction === 'string'
      ? instruction.trim()
      : DEFAULT_CAMPAIGN_THEME,
    ...contentConstraints,
  };
}

async function campaignPlan(
  signal: SignalEnvelope,
  context: HydratedContext,
  audiencePolicy?: MarketingPolicyPort,
): Promise<ExecutionPlan> {
  const campaign = normalizedCampaignRequest(signal, context.tenant_id);
  const ownerLimit = await audiencePolicy?.getApprovedAudienceLimit(context.tenant_id);
  const audienceLimit = ownerLimit === undefined ? DEFAULT_MARKETING_AUDIENCE_LIMIT : ownerLimit;
  if (!Number.isSafeInteger(audienceLimit) || audienceLimit < 1) {
    throw new OrchestratorError(
      'ASM_003_UNAVAILABLE',
      'Owner-approved ASM-003 audience limit is unavailable or invalid',
    );
  }
  if (campaign.max_segment_size !== undefined && campaign.max_segment_size > audienceLimit) {
    throw new OrchestratorError(
      'AUDIENCE_LIMIT_EXCEEDED',
      `Requested audience size ${campaign.max_segment_size} exceeds owner-approved limit ${audienceLimit}; refusing campaign`,
    );
  }
  const requestedAudienceSize = campaign.max_segment_size ?? audienceLimit;
  const channel = campaign.content_channel;
  const dispatchChannel = DISPATCH_CHANNEL_BY_CONTENT_CHANNEL[campaign.content_channel];
  return {
    plan_id: 'plan_' + signal.signal_id,
    steps: [
      {
        step_index: 1,
        agent_id: 'MKT-02',
        skill_id: 'skill.mkt.segment_audience',
        adapter_target: 'PostgreSQL.Customer360Store',
        input_parameters: {
          tenant_id: context.tenant_id,
          rfm_criteria: 'HIBERNATING',
          min_days_inactive: campaign.min_days_inactive,
          max_segment_size: requestedAudienceSize,
          channel: dispatchChannel,
        },
        required_authority: 'AUTH-1',
        mutating: false,
        price_bearing: false,
        idempotent: true,
        timeout_ms: MARKETING_TIMEOUT_MS['skill.mkt.segment_audience']!,
      },
      {
        step_index: 2,
        agent_id: 'MKT-03',
        skill_id: 'skill.mkt.generate_content',
        adapter_target: 'Core.LLMContentEngine',
        input_parameters: {
          tenant_id: context.tenant_id,
          campaign_theme: campaign.instruction,
          channel,
          locale: campaign.content_locale,
        },
        required_authority: 'AUTH-2',
        mutating: false,
        price_bearing: false,
        idempotent: true,
        timeout_ms: MARKETING_TIMEOUT_MS['skill.mkt.generate_content']!,
        depends_on_steps: [1],
      },
      {
        step_index: 3,
        agent_id: 'MKT-04',
        skill_id: 'skill.mkt.audit_brand_compliance',
        adapter_target: 'SecondBrain.BrandGuard',
        input_parameters: {
          tenant_id: context.tenant_id,
          draft_text: '',
          channel,
        },
        required_authority: 'AUTH-1',
        mutating: false,
        price_bearing: false,
        idempotent: true,
        timeout_ms: MARKETING_TIMEOUT_MS['skill.mkt.audit_brand_compliance']!,
        depends_on_steps: [2],
        input_bindings: {
          draft_text: { source_step_index: 2, response_path: 'brand_audit_text' },
        },
      },
      {
        step_index: 4,
        agent_id: 'MKT-05',
        skill_id: 'skill.mkt.dispatch_campaign',
        adapter_target: 'API-003.CommunicationConnector',
        input_parameters: {
          tenant_id: context.tenant_id,
          campaign_id: campaign.campaign_id,
          segment_id: '',
          channel: dispatchChannel,
          approved_content_id: '',
        },
        required_authority: 'AUTH-4',
        mutating: true,
        price_bearing: false,
        idempotent: false,
        timeout_ms: MARKETING_TIMEOUT_MS['skill.mkt.dispatch_campaign']!,
        depends_on_steps: [1, 2, 3],
        input_bindings: {
          segment_id: { source_step_index: 1, response_path: 'segment_id' },
          approved_content_id: { source_step_index: 2, response_path: 'draft_id' },
        },
      },
    ],
    fallback_strategy: 'FAIL_CLOSED',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MarketingContextAggregator implements IContextAggregator {
  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    let customer: Customer360Fact | null = null;
    const customer_id = subject.verified_customer_id;

    // The subject is gateway-resolved; reject malformed ids before consulting the authoritative
    // projection, then require the returned row to bind both tenant and customer exactly.
    if (typeof customer_id === 'string' && UUID.test(customer_id)) {
      try {
        const profile: CustomerProfileRow | null = await dbGetProfile(tenant_id, customer_id);
        if (profile?.tenant_id === tenant_id && profile.customer_id === customer_id) {
          customer = {
            customer_id: profile.customer_id,
            tenant_id: profile.tenant_id,
            verified_phone: profile.verified_phone ?? null,
            verified_email: profile.verified_email ?? null,
            total_spent: Number(profile.total_spent),
            order_count: profile.order_count,
            rfm_segment_hypothesis: profile.rfm_segment_hypothesis,
            consent_marketing: profile.consent_marketing,
            consent_updated_at: profile.consent_updated_at?.toISOString() ?? null,
            suppression_active: profile.suppression_active,
            created_at: profile.created_at.toISOString(),
          };
        }
      } catch {
        // A failed or unavailable authoritative read does not produce partial customer context.
        customer = null;
      }
    }

    return {
      tenant_id,
      correlation_id,
      customer,
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

  private static signalKey(tenant_id: string, signal_id: string): string {
    return `${tenant_id}\u0000${signal_id}`;
  }

  /**
   * @param journeyEntry Whether this deployment brokered the cross-domain journey. When false the
   * planner is exactly what it was before P4: it plans its own leg and hands off to nobody.
   */
  constructor(
    private readonly journeyEntry: boolean = false,
    private readonly audiencePolicy?: MarketingPolicyPort,
  ) {}

  async deriveHypothesis(signal: SignalEnvelope, _context: HydratedContext): Promise<HypothesisRecord> {
    const id = isCampaignRequest(signal) ? 'campaign.requested' : skillId(signal);
    this.signals.set(MarketingAgentRuntime.signalKey(signal.tenant_id, signal.signal_id), signal);
    return {
      classification: 'HYPOTHESIS',
      intent: 'marketing:' + id,
      confidence: 1,
      churn_risk_score: 0,
      purchase_propensity: 0,
      reasoning: isCampaignRequest(signal)
        ? 'Server-normalized campaign request enters the fixed segment/content/brand/approval plan.'
        : 'Marketing routing is selected from the server-validated canonical skill id.',
      derived_from_signals: [signal.signal_id],
    };
  }

  async resolveRouting(
    signal: SignalEnvelope,
    _context: HydratedContext,
    _hypothesis: HypothesisRecord,
  ): Promise<RoutingDecision> {
    if (isCampaignRequest(signal)) {
      return {
        target_agent: 'MKT-02',
        requires_clarification: false,
        rationalization: 'Server-normalized campaign request enters the fixed Marketing campaign plan.',
      };
    }
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
    const signal = typeof signalId === 'string'
      ? this.signals.get(MarketingAgentRuntime.signalKey(context.tenant_id, signalId))
      : undefined;
    if (!signal) {
      throw new OrchestratorError('MARKETING_SIGNAL_CONTEXT_LOST', 'signal was not retained across shared planning stages');
    }
    this.signals.delete(MarketingAgentRuntime.signalKey(context.tenant_id, signal.signal_id));
    if (isCampaignRequest(signal)) {
      return campaignPlan(signal, context, this.audiencePolicy);
    }
    const id = skillId(signal);
    const agent_id = MARKETING_AGENT_BY_SKILL[id]!;
    const input_parameters = signalInput(signal, context.tenant_id);
    const handoff_intent = this.journeyEntryIntent(signal, context);

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
      ...(handoff_intent === undefined ? {} : { handoff_intent }),
    };
  }

  /**
   * The journey entry: a marketing run that completed its own leg hands the customer to Sales
   * (implement/09 §1.1 Gate P4, plans/customer-lifecycle.md §3).
   *
   * The intent is produced only when the journey is bound, the run is an ENTRY (a run admitted BY
   * a handoff continues the journey and never re-enters it), and the run's own hydrated context
   * carries a server-verified customer. Nothing in the inbound payload can produce, address or
   * re-reason an intent: a customer id or a reason a caller asserted is never read here.
   */
  private journeyEntryIntent(
    signal: SignalEnvelope,
    context: HydratedContext,
  ): HandoffIntent | undefined {
    if (!this.journeyEntry) return undefined;
    if (signal.payload['handoff'] !== undefined) return undefined;
    if (!context.customer?.customer_id) return undefined;

    return {
      source_domain: 'marketing',
      target_domain: 'sales',
      target_agent: 'SAL-02',
      reason: 'Marketing leg completed for a verified customer; Sales consultation is the next leg',
    };
  }
}

/**
 * Epistemic classification per row, mirroring the Care/Sales convention: a read or a real external
 * write produces `FACT` into a derived (`HYPOTHESIS`) projection, while a mutating dispatch is a
 * `FACT` write to `FACT`. A non-`FACT` source targeting `FACT` is rejected by the shared
 * promotion guard before AUTH-4, so the two columns must agree with that contract.
 */
const MARKETING_EPISTEMIC_CLASS: Readonly<Record<string, PolicyRegistrySkill['epistemic_class']>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 'FACT',
  'skill.mkt.segment_audience': 'HYPOTHESIS',
  'skill.mkt.check_consent': 'FACT',
  'skill.mkt.generate_content': 'HYPOTHESIS',
  'skill.mkt.audit_brand_compliance': 'DECISION',
  'skill.mkt.dispatch_campaign': 'FACT',
  'skill.mkt.evaluate_attribution': 'FACT',
});

const MARKETING_WRITE_TARGET: Readonly<Record<string, PolicyRegistrySkill['write_target']>> = Object.freeze({
  'skill.mkt.analyze_market_signal': 'HYPOTHESIS',
  'skill.mkt.segment_audience': 'HYPOTHESIS',
  'skill.mkt.check_consent': 'HYPOTHESIS',
  'skill.mkt.generate_content': 'HYPOTHESIS',
  'skill.mkt.audit_brand_compliance': 'HYPOTHESIS',
  'skill.mkt.dispatch_campaign': 'FACT',
  'skill.mkt.evaluate_attribution': 'HYPOTHESIS',
});

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
      epistemic_class: MARKETING_EPISTEMIC_CLASS[skill_id]!,
      write_target: MARKETING_WRITE_TARGET[skill_id]!,
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
    // MKT-06 is refused here, before any schema or approval work: the shared route has no
    // Revenue attribution is admitted only when matched authoritative downstream order/payment
    // evidence is present; dispatch receipts alone never establish revenue.
    if (action.skill_id === 'skill.mkt.evaluate_attribution') {
      throw new OrchestratorError(
        'MKT06_EVIDENCE_BINDING_REQUIRED',
        'the shared route has no evidence-bound analytics contract: MKT-06 counts revenue only from matched authoritative downstream order/payment evidence, which this runtime cannot verify yet',
      );
    }
    const validated = await this.base.validateAction(action, context);
    if (action.skill_id !== 'skill.mkt.dispatch_campaign') {
      return validated;
    }
    const payload = validated.payload;
    // Required dispatch identity is refused BEFORE the shared AUTH-4 pause, so a malformed action
    // never creates an approval row and never reaches the provider seam.
    const segment_id = payload['segment_id'];
    if (typeof segment_id !== 'string' || segment_id.trim().length === 0) {
      throw new OrchestratorError('SEGMENT_REQUIRED', 'segment_id is required for campaign dispatch; no fallback segment is allowed');
    }
    for (const field of ['campaign_id', 'approved_content_id', 'channel'] as const) {
      const value = payload[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new OrchestratorError('SCHEMA_VALIDATION_ERROR', field + ' is required for campaign dispatch');
      }
    }
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
  readonly autonomy?: AutonomyAdmissionPort;
  readonly workflowEngine?: IStatefulWorkflowEngine;
  readonly evidenceLogger?: IEvidenceLogger;
  /** Optional override for the canonical receipt-binding resolver. */
  readonly planInputResolver?: IPlanInputResolver;
  readonly responseFinalizer?: IResponseFinalizer;
  readonly responseStore?: IRunResponseStore;
  /** Durable response repository; when supplied, grounded defaults are installed. */
  readonly runResponseRepository?: RunResponseRepository;
  readonly runStageRecorder?: IRunStageRecorder;
  readonly auditTrail?: IAuditTrail;
  readonly sessionControl?: ISessionControl;
  readonly leaseManager?: DurableLeaseManager;
  /**
   * The brokered cross-domain handoff binding (plans/customer-lifecycle.md §3). Absent ⇒ a plan
   * that declares a handoff refuses (`HANDOFF_BROKER_UNBOUND`) instead of completing a journey leg
   * whose successor cannot be admitted.
   */
  readonly crossDomainHandoff?: ICrossDomainHandoffBroker;
  readonly effectGuard?: IEffectGuard;
  readonly adapterDispatcher?: IAdapterDispatcher;
  readonly skillServices?: MarketingSkillServices;
  readonly skillOptions?: Partial<MarketingSkillOptions>;
  readonly knowledge_root_dir?: string;
  /** Alias retained for callers that name the configured root `knowledge_root`. */
  readonly knowledge_root?: string;
  readonly knowledge_tenant_ids?: readonly string[];
  readonly knowledge_tenant_id?: string;
  /** Owner-approved audience cap used by campaign planning; absent uses the documented safe default. */
  readonly audiencePolicy?: MarketingPolicyPort;
  /**
   * Optional tenant-bound skill adapter factory. The callback is invoked with the orchestrator's
   * server-resolved tenant and may return the seven connector ports plus the aggregate consent
   * guard. No provider or tenant is inferred when it is absent.
   */
  readonly tenantSkillOptions?: (
    tenant_id: string,
  ) => Partial<MarketingSkillOptions> | Promise<Partial<MarketingSkillOptions>>;
  readonly adapters?: DurableAdapters;
  readonly workflowRepository?: DurableWorkflowRepository;
  readonly approvalRepository?: ApprovalRepository;
  readonly evidenceRepository?: EvidenceRepository;
  readonly auditRepository?: AuditRepository;
  readonly conversationRepository?: ConversationRepository;
  readonly effectReservationRepository?: EffectReservationRepository;
  readonly auditSecret?: string;
  readonly blockers?: string[];
  readonly assertExecutionLease?: (tenant_id: string, run_id: string) => Promise<void>;
  readonly env?: MarketingFactoryEnv;
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
  options: MarketingOrchestratorFactoryOptions & { readonly auditSecret: string },
): (tenant_id: string) => Promise<RevenueOrchestrator>;
export function createMarketingOrchestratorFactory(
  options?: MarketingOrchestratorFactoryOptions,
): (tenant_id: string) => Promise<RevenueOrchestrator | null>;
export function createMarketingOrchestratorFactory(
  options: MarketingOrchestratorFactoryOptions = {},
): (tenant_id: string) => Promise<RevenueOrchestrator | null> {
  const auditSecret = options.auditSecret ?? options.env?.AUDIT_HMAC_SECRET ?? process.env.AUDIT_HMAC_SECRET;
  if (!auditSecret || auditSecret.trim().length === 0) {
    const blocker = 'MARKETING_AUDIT_SECRET_REQUIRED: audit HMAC secret must be provided or configured in AUDIT_HMAC_SECRET environment variable.';
    options.blockers?.push(blocker);
    return async (): Promise<RevenueOrchestrator | null> => null;
  }
  const now = options.now ?? (() => new Date());
  // Offline compositions stay offline: only an explicit DurableWorkflowRepository opts
  // into durable PostgreSQL response/stage recording. Production passes that repository;
  // unit/E2E passes undefined or an isolated fake and receives no live-DB writer.
  const ownsDurableWorkflow = options.workflowRepository instanceof DurableWorkflowRepository;
  const runResponseRepository = ownsDurableWorkflow ? options.runResponseRepository ?? new RunResponseRepository() : options.runResponseRepository;
  const responseFinalizer = options.responseFinalizer ?? (ownsDurableWorkflow ? createResponseFinalizer(now) : undefined);
  const responseStore = options.responseStore ?? (runResponseRepository === undefined ? undefined : createRunResponseStore(runResponseRepository));
  const runStageRecorder = options.runStageRecorder;

  const workflowRepository = options.workflowRepository ?? new DurableWorkflowRepository();
  let workflowEngine = options.workflowEngine ?? options.adapters?.workflowEngine;
  let evidenceLogger = options.evidenceLogger ?? options.adapters?.evidenceLogger;
  let planInputResolver = options.planInputResolver ?? options.adapters?.planInputResolver;
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
      ...(options.planInputResolver === undefined ? {} : { planInputResolver: options.planInputResolver }),
      now,
    });
    workflowEngine ??= durable.workflowEngine;
    evidenceLogger ??= durable.evidenceLogger;
    planInputResolver ??= durable.planInputResolver;
    auditTrail ??= durable.auditTrail;
    sessionControl ??= durable.sessionControl;
    leaseManager ??= durable.leaseManager;
  }

  planInputResolver ??= DEFAULT_PLAN_INPUT_RESOLVER;

  const effectGuard = options.effectGuard ?? new EffectGuard({
    repository: options.effectReservationRepository ?? new EffectReservationRepository(),
  });
  const configuredKnowledgeRoot = options.knowledge_root_dir ?? options.knowledge_root;
  if (
    options.knowledge_root_dir !== undefined
    && options.knowledge_root !== undefined
    && options.knowledge_root_dir !== options.knowledge_root
  ) {
    throw new Error('MARKETING_KNOWLEDGE_ROOT_CONFLICT: knowledge_root_dir and knowledge_root differ');
  }
  const configuredKnowledge = options.skillOptions?.knowledge;
  const knowledgePort = configuredKnowledge === undefined
    && configuredKnowledgeRoot !== undefined
    && options.skillServices === undefined
    ? createMarketingKnowledgePort({
        root_dir: configuredKnowledgeRoot,
        ...(options.knowledge_tenant_ids === undefined ? {} : { tenant_ids: options.knowledge_tenant_ids }),
        ...(options.knowledge_tenant_id === undefined ? {} : { tenant_id: options.knowledge_tenant_id }),
      })
    : configuredKnowledge;
  const resolveGrant = options.resolve_grant ?? defaultResolveGrant;
  const resolveCorrelationId = options.resolve_correlation_id
    ?? ((tenant_id: string, run_id: string) => defaultResolveCorrelationId(tenant_id, run_id, workflowRepository));

  const skillOptions: MarketingSkillOptions = {
    ...(options.skillOptions ?? {}),
    ...(knowledgePort === undefined ? {} : { knowledge: knowledgePort }),
    resolve_correlation_id: resolveCorrelationId,
    resolve_grant: resolveGrant,
    ...(options.now === undefined ? {} : { now }),
  };
  const services = options.skillServices ?? createMarketingSkillServices(skillOptions);
  const contextAggregator = options.contextAggregator ?? new MarketingContextAggregator();
  const agentRuntime = options.agentRuntime
    ?? new MarketingAgentRuntime(options.crossDomainHandoff !== undefined, options.audiencePolicy);
  const policyAudit = options.audit === null
    ? undefined
    : options.audit ?? (auditTrail ? createPolicyAuditSink(auditTrail) : undefined);
  const basePolicyEngine = options.policyEngine ?? new DomainPolicyEngine({
    skills: policySkills(),
    allowed_payload_fields: allowedPayloadFields(services),
    resolveGrant,
    ...(options.autonomy ? { autonomy: options.autonomy } : {}),
    ...(policyAudit ? { audit: policyAudit } : {}),
    auditSecret,
    ...(options.now === undefined ? {} : { now }),
  });
  const policyEngine: IPolicyEngine = new SharedMarketingPolicyEngine(
    basePolicyEngine,
    options.validateAuthoritative,
  );

  return async (_tenant_id: string): Promise<RevenueOrchestrator | null> => {
    if (!workflowEngine || !evidenceLogger || !auditTrail || !sessionControl || !leaseManager) {
      throw new Error('MARKETING_ORCHESTRATOR_UNBOUND: missing shared durable workflow/evidence adapters.');
    }
    const tenantOptions = options.tenantSkillOptions === undefined
      ? undefined
      : await options.tenantSkillOptions(_tenant_id);
    const tenantServices = options.skillServices === undefined && tenantOptions !== undefined
      ? createMarketingSkillServices({ ...skillOptions, ...tenantOptions })
      : services;
    const tenantAdapterDispatcher = options.adapterDispatcher ?? tenantServices.dispatcher;
    return new RevenueOrchestrator({
      contextAggregator,
      agentRuntime,
      policyEngine,
      workflowEngine,
      evidenceLogger,
      planInputResolver,
      auditTrail,
      adapterDispatcher: tenantAdapterDispatcher,
      effectGuard,
      sessionControl,
      leaseManager,
      ...(options.assertExecutionLease === undefined ? {} : { assertExecutionLease: options.assertExecutionLease }),
      ...(responseFinalizer === undefined ? {} : { responseFinalizer }),
      ...(responseStore === undefined ? {} : { responseStore }),
      ...(runStageRecorder === undefined ? {} : { runStageRecorder }),
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
      ...(options.crossDomainHandoff === undefined
        ? {}
        : { crossDomainHandoff: options.crossDomainHandoff }),
    });
  };
}

/** Exposed for worker composition and focused routing tests. */
export const MARKETING_SIGNAL_CONTRACT_DEFAULTS = Object.freeze({
  // `WEB_CHAT` is the channel the API gateway stamps on an admitted conversation turn; the
  // `MARKETING_CAMPAIGN` channel covers internal campaign producers. A turn without a canonical
  // `payload.skill_id` still fails closed in the planner.
  source_channels: Object.freeze(['WEB_CHAT', 'MARKETING_CAMPAIGN']),
  event_types: Object.freeze(['campaign.requested']),
});


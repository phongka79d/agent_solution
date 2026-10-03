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
  renderResponseTemplate,
  RevenueOrchestrator,
  type PolicyEnforcementOptions,
  type AutonomyAdmissionPort,
} from '@agentos/core-engine';
import { effectPolicyOf, plannedSkillMetadata, type SkillGate } from '@agentos/skills';
import {
  MARKETING_ALLOWED_PAYLOAD_FIELDS,
  MARKETING_SKILL_ROWS,
  MARKETING_SKILLS,
} from './policy-registry.js';
import type {
  ActionDraft,
  AssignableAuthority,
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
import type { KnowledgeStore } from '../shared/knowledge-store.js';
import { createMarketingKnowledgePort } from './knowledge-adapter.js';
import type { MarketingPolicyPort } from './contracts.js';
type MarketingFactoryEnv = WorkerConnectorEnv & {
  readonly AUDIT_HMAC_SECRET?: string;
};

const MARKETING_ROWS_BY_SKILL = Object.freeze(
  Object.fromEntries(MARKETING_SKILL_ROWS.map((row) => [row.skill_id, row])),
);

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
  if (typeof value !== 'string' || !Object.hasOwn(MARKETING_ROWS_BY_SKILL, value)) {
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
  if (instruction !== undefined && (typeof instruction !== 'string' || instruction.trim().length === 0 || instruction.length > 500)) {
    throw new OrchestratorError(
      'MARKETING_CAMPAIGN_INVALID',
      'campaign.requested instruction must be a bounded non-empty string when supplied',
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
  const segmentRow = MARKETING_ROWS_BY_SKILL['skill.mkt.segment_audience']!;
  const contentRow = MARKETING_ROWS_BY_SKILL['skill.mkt.generate_content']!;
  const brandRow = MARKETING_ROWS_BY_SKILL['skill.mkt.audit_brand_compliance']!;
  const dispatchRow = MARKETING_ROWS_BY_SKILL['skill.mkt.dispatch_campaign']!;
  const segmentEffect = effectPolicyOf(segmentRow);
  const contentEffect = effectPolicyOf(contentRow);
  const brandEffect = effectPolicyOf(brandRow);
  const dispatchEffect = effectPolicyOf(dispatchRow);
  const segmentMetadata = plannedSkillMetadata(segmentRow.skill_id);
  const contentMetadata = plannedSkillMetadata(contentRow.skill_id);
  const brandMetadata = plannedSkillMetadata(brandRow.skill_id);
  const dispatchMetadata = plannedSkillMetadata(dispatchRow.skill_id);
  return {
    plan_id: 'plan_' + signal.signal_id,
    domain: segmentMetadata?.domain ?? 'marketing',
    steps: [
      {
        step_index: 1,
        agent_id: segmentRow.allowed_agents[0] as PlatformAgentId,
        skill_id: segmentRow.skill_id,
        adapter_target: segmentRow.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          rfm_criteria: 'HIBERNATING',
          min_days_inactive: campaign.min_days_inactive,
          max_segment_size: requestedAudienceSize,
          channel: dispatchChannel,
        },
        required_authority: segmentRow.required_authority,
        mutating: segmentEffect.mutating,
        price_bearing: segmentEffect.price_bearing,
        idempotent: segmentEffect.idempotent,
        timeout_ms: segmentRow.timeout_ms,
        ...(segmentMetadata === undefined ? {} : { dispatch_timeout_ms: segmentMetadata.dispatch_timeout_ms }),
        completion: segmentMetadata?.completion ?? 'SYNC',
        ...(segmentMetadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: segmentMetadata.idempotency_input_field }),
      },
      {
        step_index: 2,
        agent_id: contentRow.allowed_agents[0] as PlatformAgentId,
        skill_id: contentRow.skill_id,
        adapter_target: contentRow.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          campaign_theme: campaign.instruction,
          channel,
          locale: campaign.content_locale,
        },
        required_authority: contentRow.required_authority,
        mutating: contentEffect.mutating,
        price_bearing: contentEffect.price_bearing,
        idempotent: contentEffect.idempotent,
        timeout_ms: contentRow.timeout_ms,
        ...(contentMetadata === undefined ? {} : { dispatch_timeout_ms: contentMetadata.dispatch_timeout_ms }),
        completion: contentMetadata?.completion ?? 'SYNC',
        ...(contentMetadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: contentMetadata.idempotency_input_field }),
        depends_on_steps: [1],
      },
      {
        step_index: 3,
        agent_id: brandRow.allowed_agents[0] as PlatformAgentId,
        skill_id: brandRow.skill_id,
        adapter_target: brandRow.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          draft_text: '',
          channel,
        },
        required_authority: brandRow.required_authority,
        mutating: brandEffect.mutating,
        price_bearing: brandEffect.price_bearing,
        idempotent: brandEffect.idempotent,
        timeout_ms: brandRow.timeout_ms,
        ...(brandMetadata === undefined ? {} : { dispatch_timeout_ms: brandMetadata.dispatch_timeout_ms }),
        completion: brandMetadata?.completion ?? 'SYNC',
        ...(brandMetadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: brandMetadata.idempotency_input_field }),
        depends_on_steps: [2],
        input_bindings: {
          draft_text: { source_step_index: 2, response_path: 'brand_audit_text' },
        },
      },
      {
        step_index: 4,
        agent_id: dispatchRow.allowed_agents[0] as PlatformAgentId,
        skill_id: dispatchRow.skill_id,
        adapter_target: dispatchRow.guarded_dependency,
        input_parameters: {
          tenant_id: context.tenant_id,
          campaign_id: campaign.campaign_id,
          segment_id: '',
          channel: dispatchChannel,
          approved_content_id: '',
        },
        required_authority: dispatchRow.required_authority,
        mutating: dispatchEffect.mutating,
        price_bearing: dispatchEffect.price_bearing,
        idempotent: dispatchEffect.idempotent,
        timeout_ms: dispatchRow.timeout_ms,
        ...(dispatchMetadata === undefined ? {} : { dispatch_timeout_ms: dispatchMetadata.dispatch_timeout_ms }),
        completion: dispatchMetadata?.completion ?? 'SYNC',
        ...(dispatchMetadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: dispatchMetadata.idempotency_input_field }),
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
  /**
   * @param journeyEntry Whether this deployment brokered the cross-domain journey. When false the
   * planner is exactly what it was before P4: it plans its own leg and hands off to nobody.
   */
  constructor(
    private readonly journeyEntry: boolean = false,
    private readonly audiencePolicy?: MarketingPolicyPort,
    private readonly gate?: SkillGate,
  ) {}
  async deriveHypothesis(signal: SignalEnvelope, context: HydratedContext): Promise<HypothesisRecord> {
    const id = isCampaignRequest(signal) ? 'campaign.requested' : skillId(signal);
    const run_state = context.run_state ?? {};
    context.run_state = {
      ...run_state,
      marketing: {
        ...run_state.marketing,
        source_signal: signal,
      },
    };
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
      target_agent: MARKETING_ROWS_BY_SKILL[id]!.allowed_agents[0] as PlatformAgentId,
      requires_clarification: false,
      rationalization: 'Shared Marketing runtime route for ' + id + '.',
    };
  }

  async formulatePlan(
    _routing: RoutingDecision,
    context: HydratedContext,
    hypothesis: HypothesisRecord,
  ): Promise<ExecutionPlan> {
    const signal = context.run_state?.marketing?.source_signal;
    const signalId = hypothesis.derived_from_signals[0];
    if (
      signal === undefined ||
      signal.tenant_id !== context.tenant_id ||
      signal.signal_id !== signalId
    ) {
      throw new OrchestratorError('MARKETING_SIGNAL_CONTEXT_LOST', 'signal was not retained across shared planning stages');
    }
    if (isCampaignRequest(signal)) {
      return this.applyAvailabilityGate(await campaignPlan(signal, context, this.audiencePolicy), context, true);
    }
    const id = skillId(signal);
    const row = MARKETING_ROWS_BY_SKILL[id]!;
    const effect = effectPolicyOf(row);
    const metadata = plannedSkillMetadata(row.skill_id);
    const agent_id = row.allowed_agents[0] as PlatformAgentId;
    const input_parameters = signalInput(signal, context.tenant_id);
    const handoff_intent = this.journeyEntryIntent(signal, context);

    const plan: ExecutionPlan = {
      plan_id: 'plan_' + signal.signal_id,
      domain: metadata?.domain ?? 'marketing',
      steps: [{
        step_index: 1,
        agent_id,
        skill_id: id,
        adapter_target: row.guarded_dependency,
        input_parameters,
        required_authority: row.required_authority,
        mutating: effect.mutating,
        price_bearing: effect.price_bearing || (id === 'skill.mkt.dispatch_campaign' && (
          typeof input_parameters['proposed_price'] === 'number'
          || typeof input_parameters['discount_percent'] === 'number'
          || typeof input_parameters['discount_amount'] === 'number'
          || typeof input_parameters['offer_id'] === 'string'
        )),
        idempotent: effect.idempotent,
        timeout_ms: row.timeout_ms,
        ...(metadata === undefined ? {} : { dispatch_timeout_ms: metadata.dispatch_timeout_ms }),
        completion: metadata?.completion ?? 'SYNC',
        ...(metadata?.idempotency_input_field === undefined
          ? {}
          : { idempotency_input_field: metadata.idempotency_input_field }),
      }],
      fallback_strategy: 'FAIL_CLOSED',
      ...(handoff_intent === undefined ? {} : { handoff_intent }),
    };
    return this.applyAvailabilityGate(plan, context);
  }

  private async applyAvailabilityGate(
    plan: ExecutionPlan,
    context: HydratedContext,
    preserveCampaignApprovalStep = false,
  ): Promise<ExecutionPlan> {
    const gate = this.gate;
    if (gate === undefined || plan.steps.length === 0) return plan;

    const verdicts = await Promise.all(
      plan.steps.map(async (step) => ({
        step,
        verdict: await gate.available(context.tenant_id, step.skill_id),
      })),
    );
    const refused = new Set(
      verdicts.filter((entry) =>
        !entry.verdict.available
        && !(preserveCampaignApprovalStep
          && entry.step.skill_id === 'skill.mkt.dispatch_campaign'
          && entry.step.required_authority === 'AUTH-4'
          && entry.verdict.reason === 'CONNECTOR_UNBOUND'))
        .map((entry) => entry.step.step_index),
    );
    if (refused.size === 0) return plan;

    let kept = plan.steps.filter((step) => !refused.has(step.step_index));
    for (;;) {
      const keptIndexes = new Set(kept.map((step) => step.step_index));
      const next = kept.filter((step) =>
        (step.depends_on_steps ?? []).every((dependency) => keptIndexes.has(dependency)));
      if (next.length === kept.length) break;
      kept = next;
    }

    if (kept.length === 0) {
      const unavailable = verdicts.find((entry) => !entry.verdict.available);
      if (unavailable === undefined) return plan;
      const rendered = renderResponseTemplate('core.skill_unavailable');
      const refusal: ExecutionPlan = {
        ...plan,
        steps: [],
        terminal_response: {
          response_kind: 'REFUSAL',
          ...rendered,
          reason_code: unavailable.verdict.reason,
          sources: [],
        },
      };
      Reflect.deleteProperty(refusal, 'handoff_intent');
      return refusal;
    }

    const indexMap = new Map<number, number>();
    kept.forEach((step, index) => indexMap.set(step.step_index, index + 1));
    return {
      ...plan,
      steps: kept.map((step, index) => ({
        ...step,
        step_index: index + 1,
        depends_on_steps: (step.depends_on_steps ?? [])
          .map((dependency) => indexMap.get(dependency))
          .filter((dependency): dependency is number => dependency !== undefined),
      })),
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
  normalizeActionInput(skill_id: string, input: Record<string, unknown>): unknown {
    return this.base.normalizeActionInput === undefined
      ? input
      : this.base.normalizeActionInput(skill_id, input);
  }

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
  readonly gate?: SkillGate;
  readonly knowledge_store?: Pick<KnowledgeStore, 'listAvailable'>;
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
  const configuredKnowledge = options.skillOptions?.knowledge;
  const knowledgePort = configuredKnowledge === undefined && options.skillServices === undefined
    ? createMarketingKnowledgePort({
        ...(options.knowledge_store === undefined ? {} : { knowledge_store: options.knowledge_store }),
      })
    : configuredKnowledge;
  const resolveGrant = options.resolve_grant ?? defaultResolveGrant;
  const resolveCorrelationId = options.resolve_correlation_id
    ?? ((tenant_id: string, run_id: string) => defaultResolveCorrelationId(tenant_id, run_id, workflowRepository));

  const gate = options.gate ?? options.skillOptions?.gate;
  const skillOptions: MarketingSkillOptions = {
    ...(options.skillOptions ?? {}),
    ...(gate === undefined ? {} : { gate }),
    ...(knowledgePort === undefined ? {} : { knowledge: knowledgePort }),
    resolve_correlation_id: resolveCorrelationId,
    resolve_grant: resolveGrant,
    ...(options.now === undefined ? {} : { now }),
  };
  const services = options.skillServices ?? createMarketingSkillServices(skillOptions);
  const contextAggregator = options.contextAggregator ?? new MarketingContextAggregator();
  const agentRuntime = options.agentRuntime
    ?? new MarketingAgentRuntime(options.crossDomainHandoff !== undefined, options.audiencePolicy, skillOptions.gate);
  const policyAudit = options.audit === null
    ? undefined
    : options.audit ?? (auditTrail ? createPolicyAuditSink(auditTrail) : undefined);
  const basePolicyEngine = options.policyEngine ?? new DomainPolicyEngine({
    skills: MARKETING_SKILLS,
    allowed_payload_fields: MARKETING_ALLOWED_PAYLOAD_FIELDS,
    normalizeActionInput: (skill_id, input) => services.registry.resolve(skill_id).validateInput(input),
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


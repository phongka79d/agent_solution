import type {
  AssignableAuthority,
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
import type {
  ExecutionContext,
  PlatformSkillEnablement,
  SkillRegistry,
  SkillToolPort,
} from '@agentos/skills';

export type {
  AssignableAuthority,
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
export type {
  ExecutionContext,
  PlatformSkillEnablement,
  SkillRegistry,
  SkillToolPort,
} from '@agentos/skills';

/**
 * §4.1 Skill 1: skill.mkt.analyze_market_signal
 */
export interface InputMktAnalyzeSignal {
  tenant_id: string;
  market_region: 'TW' | 'GLOBAL_US' | 'GLOBAL_EU' | 'VN';
  category_id: string;
  observation_window_days: number;
}

export interface OutputMktAnalyzeSignal {
  signals: Array<{
    signal_id: string;
    keyword: string;
    search_volume_growth: number;
    price_pressure_index: number;
  }>;
  trend_velocity: 'SLOW' | 'STABLE' | 'RAPID' | 'EXPLOSIVE';
  analyzed_at: string;
}

/**
 * §4.1 Skill 2: skill.mkt.segment_audience
 */
export interface InputMktSegmentAudience {
  tenant_id: string;
  rfm_criteria: 'CHAMPIONS' | 'LOYAL' | 'POTENTIAL_LOYALIST' | 'AT_RISK' | 'HIBERNATING';
  min_days_inactive: number;
  max_segment_size?: number;
}

export interface OutputMktSegmentAudience {
  segment_id: string;
  matched_customer_count: number;
  customer_ids: string[];
  generated_at: string;
}

/**
 * §4.1 Skill 3: skill.mkt.check_consent
 */
export interface InputMktCheckConsent {
  tenant_id: string;
  customer_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
}

export interface OutputMktCheckConsent {
  allowed: boolean;
  consent_timestamp: string | null;
  suppression_reason: string | null;
}

/**
 * §4.1 Skill 4: skill.mkt.generate_content
 */
export interface ChannelSpecificPayload {
  channel_type: string;
  line_flex_container?: Record<string, unknown>;
  whatsapp_template?: { template_name: string; parameters: string[] };
  zalo_zns_template?: { template_id: string; template_data: Record<string, string> };
  meta_generic_card?: { title: string; subtitle: string; image_url?: string; cta_button_url?: string };
}

export interface InputMktGenerateContent {
  tenant_id: string;
  campaign_theme: string;
  channel:
    | 'LINE_FLEX'
    | 'WHATSAPP_TEMPLATE'
    | 'EMAIL_HTML'
    | 'SMS_TEXT'
    | 'ZALO_ZNS'
    | 'TIKTOK_CARD'
    | 'MESSENGER_GENERIC'
    | 'INSTAGRAM_DIRECT';
  locale: 'zh-TW' | 'en-US' | 'vi-VN' | 'ja-JP';
  product_skus?: string[];
}

export interface OutputMktGenerateContent {
  draft_id: string;
  headline: string;
  body_content: string;
  cta_text: string;
  channel_payload: ChannelSpecificPayload;
}

/**
 * §4.1 Skill 5: skill.mkt.audit_brand_compliance
 */
export interface InputMktAuditBrand {
  tenant_id: string;
  draft_text: string;
  channel: string;
}

export interface OutputMktAuditBrand {
  compliant: boolean;
  violations: Array<{
    rule_id: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING';
    snippet: string;
    suggestion: string;
  }>;
  confidence_score: number;
}

/**
 * §4.1 Skill 6: skill.mkt.dispatch_campaign
 */
export interface InputMktDispatchCampaign {
  tenant_id: string;
  campaign_id: string;
  segment_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  approved_content_id: string;
  approval_signature: string;
  offer_id?: string;
  discount_amount?: number;
  discount_percent?: number;
  proposed_price?: number;
}

export interface OutputMktDispatchCampaign {
  dispatch_id: string;
  recipient_count: number;
  status: 'ENQUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  dispatched_at: string;
}

/**
 * §4.1 Skill 7: skill.mkt.evaluate_attribution
 */
export interface InputMktEvaluateAttribution {
  tenant_id: string;
  campaign_id: string;
  attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
}

export interface OutputMktEvaluateAttribution {
  campaign_id: string;
  attributed_revenue: number;
  attributed_orders: number;
  roas: number;
  cac?: number;
  calculated_at: string;
}

/**
 * Injected port for API-002 market signal reads (API-002.EventIngestion).
 */
export interface MarketingSignalReadPort {
  readonly readSignals: (
    input: InputMktAnalyzeSignal,
    context: ExecutionContext,
  ) => Promise<OutputMktAnalyzeSignal>;
}

/**
 * Injected port for Customer360 audience segmentation (PostgreSQL.Customer360Store).
 */
export interface MarketingCustomer360Port {
  readonly segmentAudience: (
    input: InputMktSegmentAudience,
    context: ExecutionContext,
  ) => Promise<OutputMktSegmentAudience>;
}

/**
 * Injected port for consent verification (API-002.ConsentStore).
 */
export interface MarketingConsentPort {
  readonly checkConsent: (
    input: InputMktCheckConsent,
    context: ExecutionContext,
  ) => Promise<OutputMktCheckConsent>;
}

/**
 * Injected port for LLM content generation (Core.LLMContentEngine).
 */
export interface MarketingContentEnginePort {
  readonly generateContent: (
    input: InputMktGenerateContent,
    context: ExecutionContext,
  ) => Promise<OutputMktGenerateContent>;
}

/**
 * Injected port for brand compliance auditing (SecondBrain.BrandGuard).
 */
export interface MarketingBrandGuardPort {
  readonly auditBrandCompliance: (
    input: InputMktAuditBrand,
    context: ExecutionContext,
  ) => Promise<OutputMktAuditBrand>;
}

/**
 * Input for server-side audience resolution (resolving segment -> recipients).
 */
export interface MarketingAudienceResolverInput {
  readonly tenant_id: string;
  readonly segment_id: string;
  readonly channel: InputMktDispatchCampaign['channel'] | string;
}

/**
 * Server-side audience resolver result with explicit verified-consent audience payload.
 */
export interface MarketingVerifiedAudienceResult {
  readonly recipients: readonly string[];
  readonly consent_verified: true;
}

/**
 * Server-side audience resolver result.
 * Resolvers may return recipient IDs (which require a configured server-side MarketingConsentPort)
 * or an explicit verified-consent audience payload.
 */
export type MarketingAudienceResolverResult =
  | readonly string[]
  | MarketingVerifiedAudienceResult;

/**
 * Server-side audience resolver seam to resolve segment -> Customer360/consent recipients.
 */
export type MarketingAudienceResolver = (
  input: MarketingAudienceResolverInput,
  context: ExecutionContext,
) => Promise<MarketingAudienceResolverResult>;

/**
 * Communication dispatch payload forwarded to connector after server-side audience resolution.
 */
export interface MarketingCommunicationDispatchInput extends InputMktDispatchCampaign {
  readonly recipients?: readonly string[];
}

/**
 * Injected port for outbound campaign communication (API-003.CommunicationConnector).
 */
export interface MarketingCommunicationPort {
  readonly resolveAudience?: MarketingAudienceResolver;
  readonly audience_resolver?: MarketingAudienceResolver;
  readonly audienceResolver?: MarketingAudienceResolver;
  readonly consent?: MarketingConsentPort | null;
  readonly consent_port?: MarketingConsentPort | null;
  readonly consentPort?: MarketingConsentPort | null;
  readonly dispatchCampaign: (
    input: MarketingCommunicationDispatchInput,
    context: ExecutionContext,
  ) => Promise<OutputMktDispatchCampaign>;
}
/**
 * Injected port for downstream analytics and attribution evidence (PostgreSQL.AnalyticsStore).
 */
export interface MarketingAnalyticsPort {
  readonly evaluateAttribution: (
    input: InputMktEvaluateAttribution,
    context: ExecutionContext,
  ) => Promise<OutputMktEvaluateAttribution>;
}

/**
 * Reconcile input for marketing actions.
 */
export interface MarketingReconcileInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly action_id?: string;
  readonly adapter_target?: string;
  readonly skill_id?: string;
}

/**
 * Reconcile function for marketing actions.
 */
export type MarketingReconcileFn = (
  input: MarketingReconcileInput,
) => Promise<{
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
  readonly receipt?: ExecutionReceipt;
}>;

/**
 * Tool port configuration options for Marketing skills.
 */
export interface MarketingSkillToolPortOptions {
  readonly signal_reads?: MarketingSignalReadPort | null;
  readonly customer360?: MarketingCustomer360Port | null;
  readonly consent?: MarketingConsentPort | null;
  readonly consent_port?: MarketingConsentPort | null;
  readonly consentPort?: MarketingConsentPort | null;
  readonly content_engine?: MarketingContentEnginePort | null;
  readonly brand_guard?: MarketingBrandGuardPort | null;
  readonly communication?: MarketingCommunicationPort | null;
  readonly analytics?: MarketingAnalyticsPort | null;
  readonly audience_resolver?: MarketingAudienceResolver | null;
  readonly audienceResolver?: MarketingAudienceResolver | null;
}

/**
 * Dispatch integration status marker: routing via apps/worker/src/worker.ts is deferred.
 */
export const MARKETING_DISPATCH_INTEGRATION_STATUS = 'PENDING_P2_SHARED_ROUTING' as const;

/**
 * Input dependencies for createMarketingSkillServices.
 */
export interface MarketingSkillOptions extends MarketingSkillToolPortOptions {
  readonly now?: () => Date;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  readonly skill_enablement?: PlatformSkillEnablement;
  readonly reconcile?: MarketingReconcileFn;
}

/**
 * Assembled Marketing skill services.
 */
export interface MarketingSkillServices {
  readonly registry: SkillRegistry;
  readonly tool_port: SkillToolPort;
  readonly dispatcher: IAdapterDispatcher;
  readonly unbound: readonly string[];
  readonly dispatch_integration: typeof MARKETING_DISPATCH_INTEGRATION_STATUS;
}

/** Marketing-local contracts for the isolated worker foundation. */

export type MarketingSkillId =
  | 'skill.mkt.analyze_market_signal'
  | 'skill.mkt.segment_audience'
  | 'skill.mkt.check_consent'
  | 'skill.mkt.generate_content'
  | 'skill.mkt.audit_brand_compliance'
  | 'skill.mkt.dispatch_campaign'
  | 'skill.mkt.evaluate_attribution';

export type MarketingEvidenceClass =
  | 'FACT'
  | 'SIGNAL'
  | 'HYPOTHESIS'
  | 'APPROVED_KNOWLEDGE'
  | 'DECISION'
  | 'DRAFT';

export interface MarketingEvidence {
  readonly evidence_id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly effect_key: string;
  readonly classification: MarketingEvidenceClass;
  readonly source_uri: string;
  readonly source_version: string;
  readonly claim: string;
}

export interface MarketingAuditRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly effect_key: string;
  readonly skill_id: string;
  readonly outcome: 'SUCCEEDED' | 'DENIED';
  readonly reason: string;
  readonly evidence_ids: readonly string[];
  readonly occurred_at: string;
}

export interface MarketingKnowledgeDocument {
  readonly path: string;
  readonly version: string;
  readonly content: string;
}

export interface MarketingSignalInput {
  readonly tenant_id: string;
  readonly market_region: 'TW' | 'GLOBAL_US' | 'GLOBAL_EU' | 'VN';
  readonly category_id: string;
  readonly observation_window_days: number;
}

export interface MarketingSignalObservation {
  readonly tenant_id: string;
  readonly signal_id: string;
  readonly keyword: string;
  readonly search_volume_growth: number;
  readonly price_pressure_index: number;
  readonly source_uri: string;
  readonly source_version: string;
  readonly observed_at: string;
}

export type MarketingTrendVelocity = 'SLOW' | 'STABLE' | 'RAPID' | 'EXPLOSIVE';

export interface MarketingSignalResearchResult {
  readonly signals: readonly MarketingSignalObservation[];
  /** Supplied by the tenant's authorized signal source; this runtime does not invent thresholds. */
  readonly trend_velocity: MarketingTrendVelocity;
  readonly source_uri: string;
  readonly source_version: string;
}

export interface MarketingSegmentInput {
  readonly tenant_id: string;
  readonly rfm_criteria: 'CHAMPIONS' | 'LOYAL' | 'POTENTIAL_LOYALIST' | 'AT_RISK' | 'HIBERNATING';
  readonly min_days_inactive: number;
  readonly max_segment_size?: number;
}

export interface MarketingAudienceCandidate {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly source_uri: string;
  readonly source_version: string;
  readonly observed_at: string;
  readonly match_reason: string;
}

/** Tenant-scoped research and segmentation inputs. */
export interface MarketingResearchPort {
  readonly readMarketSignals: (input: MarketingSignalInput) => Promise<MarketingSignalResearchResult>;
  readonly segmentAudience: (input: MarketingSegmentInput) => Promise<readonly MarketingAudienceCandidate[]>;
}

export interface MarketingConsentDecision {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly channel: string;
  readonly allowed: boolean;
  readonly consent_timestamp: string | null;
  readonly suppression_reason: string | null;
  readonly source_uri: string;
  readonly source_version: string;
}

export interface MarketingConsentPort {
  readonly check: (input: {
    readonly tenant_id: string;
    readonly customer_id: string;
    readonly channel: string;
  }) => Promise<MarketingConsentDecision>;
}

export interface MarketingContentInput {
  readonly tenant_id: string;
  readonly campaign_theme: string;
  readonly channel:
    | 'LINE_FLEX'
    | 'WHATSAPP_TEMPLATE'
    | 'EMAIL_HTML'
    | 'SMS_TEXT'
    | 'ZALO_ZNS'
    | 'TIKTOK_CARD'
    | 'MESSENGER_GENERIC'
    | 'INSTAGRAM_DIRECT';
  readonly locale: 'zh-TW' | 'en-US' | 'vi-VN' | 'ja-JP';
  readonly product_skus?: readonly string[];
}

export interface MarketingContentOutput {
  readonly draft_id: string;
  readonly headline: string;
  readonly body_content: string;
  readonly cta_text: string;
  readonly channel_payload: {
    readonly channel_type: string;
    readonly line_flex_container?: Record<string, unknown>;
    readonly whatsapp_template?: { readonly template_name: string; readonly parameters: readonly string[] };
    readonly zalo_zns_template?: { readonly template_id: string; readonly template_data: Record<string, string> };
    readonly meta_generic_card?: {
      readonly title: string;
      readonly subtitle: string;
      readonly image_url?: string;
      readonly cta_button_url?: string;
    };
  };
}

export interface MarketingContentGeneratorPort {
  readonly generate: (
    input: MarketingContentInput,
    approvedKnowledge: readonly MarketingKnowledgeDocument[],
  ) => Promise<MarketingContentOutput>;
}

export interface MarketingBrandAuditInput {
  readonly tenant_id: string;
  readonly draft_text: string;
  readonly channel: string;
}

export interface MarketingBrandAuditOutput {
  readonly compliant: boolean;
  readonly violations: readonly {
    readonly rule_id: string;
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING';
    readonly snippet: string;
    readonly suggestion: string;
  }[];
  readonly confidence_score: number;
}

export interface MarketingAttributionInput {
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
  readonly evidence_ids: readonly string[];
}

export interface MarketingAttributionContract {
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly status: 'READY_FOR_EVIDENCE' | 'UNAVAILABLE';
  readonly evidence_ids: readonly string[];
  readonly reason: string | null;
}

export interface MarketingAttributedOrderEvidence {
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly evidence_id: string;
  readonly evidence_uri: string;
  readonly source_version: string;
}

export interface MarketingAttributionPort {
  readonly collectEvidence: (input: MarketingAttributionInput) => Promise<readonly MarketingAttributedOrderEvidence[]>;
}

export interface MarketingEvidencePort {
  readonly append: (
    evidence: readonly MarketingEvidence[],
    context: MarketingInvocationContext,
    effectKey: string,
  ) => Promise<string>;
}

export interface MarketingAuditPort {
  readonly append: (record: MarketingAuditRecord) => Promise<void>;
}

export interface MarketingPolicyPort {
  /** Owner-approved ASM-003 limit, or undefined until the tenant supplies it. */
  readonly getApprovedAudienceLimit: (tenant_id: string) => Promise<number | undefined>;
}

export interface MarketingKnowledgePort {
  readonly readApproved: (tenant_id: string, path: string) => Promise<MarketingKnowledgeDocument>;
}

export interface MarketingRuntimePorts {
  readonly research?: MarketingResearchPort;
  readonly consent?: MarketingConsentPort;
  readonly evidence: MarketingEvidencePort;
  readonly audit: MarketingAuditPort;
  readonly policy?: MarketingPolicyPort;
  readonly knowledge?: MarketingKnowledgePort;
  readonly content_generator?: MarketingContentGeneratorPort;
  readonly attribution?: MarketingAttributionPort;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface MarketingInvocationContext {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly request_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly caller_agent: string;
  readonly granted_authority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3';
  /** Set only by the server's verified-identity resolver; never copied from an input payload. */
  readonly verified_customer_id?: string;
}

export interface MarketingInvocationResult<TOutput = unknown> {
  readonly skill_id: MarketingSkillId;
  readonly effect_key: string;
  readonly output: TOutput;
  readonly evidence: readonly MarketingEvidence[];
  readonly audit: MarketingAuditRecord;
}

export interface MarketingAttributionResult {
  readonly contract: MarketingAttributionContract;
  readonly evidence: readonly MarketingEvidence[];
}

export class MarketingRuntimeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MarketingRuntimeError';
    this.code = code;
  }
}

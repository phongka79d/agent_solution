
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
  readonly analyzed_at: string;
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


export interface MarketingBrandAuditInput {
  readonly tenant_id: string;
  /** Body copy; retained for compatibility with the original audit contract. */
  readonly draft_text: string;
  readonly channel: string;
  /** Optional content fields audited in addition to the body. */
  readonly subject?: string;
  readonly title?: string;
  readonly headline?: string;
  readonly cta_text?: string;
  readonly preheader?: string;
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


export type MarketingAuthority =
  | 'AUTH-0'
  | 'AUTH-1'
  | 'AUTH-2'
  | 'AUTH-3';

export type MarketingAssignableAuthority = MarketingAuthority;

export interface MarketingInvocationContext {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly request_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly caller_agent: string;
  readonly granted_authority: MarketingAuthority;
  /** Set only by the server's verified-identity resolver; never copied from an input payload. */
  readonly verified_customer_id?: string;
  readonly authority_verdict?: string;
}



export class MarketingRuntimeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MarketingRuntimeError';
    this.code = code;
  }
}


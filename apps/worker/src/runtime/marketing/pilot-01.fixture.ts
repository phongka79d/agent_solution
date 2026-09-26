/**
 * @file Offline Fixture and Harness Interface for P3 PILOT-01 Marketing Pipeline.
 *
 * MARKERS:
 * - FIXTURE_TYPE: OFFLINE_FIXTURE
 * - EVIDENCE_STATUS: NOT_RUNTIME_EVIDENCE
 *
 * INVARIANTS:
 * 1. Offline deterministic shape only; NOT live runtime execution or proof of external behavior.
 * 2. Explicit classification: FACT, SIGNAL, HYPOTHESIS, DRAFT, DECISION.
 * 3. Consistent linkage across tenant_id, campaign_id, effect_key, and correlation_id.
 * 4. P1B human approval handoff expressed strictly as an UNMET DEPENDENCY;
 *    never introduces approval row types, database queues, or dispatch claims.
 * 5. Negative/missing attribution evidence scenarios refuse absent data.
 *    Outcome evidence remains empty/UNAVAILABLE since no dispatch or execution occurs.
 * 6. ZERO numeric KPIs, concrete customer audiences, budgets, revenue sums, consent records,
 *    provider delivery receipts, or synthetic execution successes.
 * 7. Executable deterministic staged acceptance harness:
 *    Signal -> Segment -> Campaign -> Content -> Brand Review -> AUTH-4 Approval -> Dispatch -> Response -> Attribution
 *    with injected offline ports/steps, while clearly reporting that provider dispatch and external order evidence
 *    are unavailable offline.
 * 8. Comprehensive negative-case validators for:
 *    - missing consent
 *    - suppressed customer
 *    - draft/unapproved knowledge
 *    - prohibited claim
 *    - invented/unverified price
 *    - stale approval digest
 *    - changed payload after approval
 *    - AUTH-5
 *    - duplicate dispatch
 *    - provider UNKNOWN
 *    - tenant leakage
 *    - missing attribution evidence
 */

import {
  computeEffectKey,
  computeRequestFingerprint,
  evaluateAuthorityVerdict,
} from '@agentos/core-engine';
import {
  type MarketingAttributedOrderEvidence,
  type MarketingAttributionContract,
  type MarketingAttributionInput,
  type MarketingAudienceCandidate,
  type MarketingBrandAuditInput,
  type MarketingBrandAuditOutput,
  type MarketingConsentDecision,
  type MarketingContentInput,
  type MarketingContentOutput,
  type MarketingEvidence,
  type MarketingEvidenceClass,
  type MarketingKnowledgeDocument,
  type MarketingSegmentInput,
  type MarketingSignalInput,
  type MarketingSignalObservation,
  type MarketingSignalResearchResult,
  MarketingRuntimeError,
} from './contracts.js';

export const PILOT_01_FIXTURE_MARKER = 'OFFLINE_FIXTURE' as const;
export const PILOT_01_RUNTIME_EVIDENCE_STATUS = 'NOT_RUNTIME_EVIDENCE' as const;

/**
 * P1B handoff boundary: represents the human approval dependency before dispatch.
 * Expressed purely as an unmet dependency; never models approval queue rows or tables.
 */
export interface Pilot01ApprovalBoundaryHandoff {
  readonly dependency_id: string;
  readonly required_authority: 'AUTH-4';
  readonly status: 'UNMET_DEPENDENCY';
  readonly blocking_reason: 'AWAITING_HUMAN_APPROVAL_SCR003';
  readonly target_skill_id: 'skill.mkt.dispatch_campaign';
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly description: string;
}

/**
 * Stage evidence bundle for PILOT-01 offline trace.
 */
export interface Pilot01StageEvidence {
  readonly fixture_type: typeof PILOT_01_FIXTURE_MARKER;
  readonly evidence_status: typeof PILOT_01_RUNTIME_EVIDENCE_STATUS;
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly run_id: string;

  /** Stage 1: Market Signal Analysis */
  readonly signal: {
    readonly observation: MarketingSignalObservation;
    readonly evidence: MarketingEvidence;
  };

  /** Stage 2: Audience Segmentation Hypothesis (Criteria definition, no person data) */
  readonly segment: {
    readonly input: MarketingSegmentInput;
    readonly evidence: MarketingEvidence;
  };

  /** Stage 3: Content Generation Draft */
  readonly content: {
    readonly output: MarketingContentOutput;
    readonly evidence: MarketingEvidence;
  };

  /** Stage 4: Brand Voice Compliance Audit Decision */
  readonly review: {
    readonly audit: MarketingBrandAuditOutput;
    readonly evidence: MarketingEvidence;
  };

  /** Stage 5: Approval Boundary (P1B Handoff - Unmet Dependency) */
  readonly approval_boundary: Pilot01ApprovalBoundaryHandoff;

  /**
   * Stage 6: Sales / Outcome Evidence Boundary
   * Because dispatch requires human approval and has not run, outcome evidence is absent
   * and the attribution contract remains UNAVAILABLE (no fake execution success or receipts).
   */
  readonly outcome: {
    readonly input: MarketingAttributionInput;
    readonly contract: MarketingAttributionContract;
    readonly order_evidence: readonly MarketingAttributedOrderEvidence[];
    readonly evidence: readonly MarketingEvidence[];
  };
}

// Fixed deterministic identifiers for the PILOT-01 offline trace.
export const PILOT_01_TENANT_ID = 'tenant-pilot01-tw';
export const PILOT_01_CAMPAIGN_ID = 'camp-pilot01-spring';
export const PILOT_01_EFFECT_KEY = 'eff-pilot01-mkt-001';
export const PILOT_01_CORRELATION_ID = 'corr-pilot01-trace-77';
export const PILOT_01_RUN_ID = 'run-pilot01-offline-01';

export const PILOT_01_EVIDENCE_IDS = {
  signal: 'ev-sig-pilot01-001',
  segment: 'ev-seg-pilot01-001',
  content: 'ev-cnt-pilot01-001',
  review: 'ev-rev-pilot01-001',
} as const;

/**
 * Canonical effect key derived deterministically for the staged acceptance pipeline.
 */
export function computePilot01StagedEffectKey(params?: {
  readonly tenant_id?: string;
  readonly correlation_id?: string;
}): string {
  return computeEffectKey({
    tenant_id: params?.tenant_id ?? PILOT_01_TENANT_ID,
    skill_id: 'skill.mkt.dispatch_campaign',
    step_index: 6,
    action_revision: 1,
    request_id: params?.correlation_id ?? PILOT_01_CORRELATION_ID,
  });
}

export const PILOT_01_STAGED_EFFECT_KEY = computePilot01StagedEffectKey();

/**
 * Approved knowledge documents for deterministic offline harness.
 */
export const PILOT_01_APPROVED_PROHIBITED_CLAIMS_DOC: MarketingKnowledgeDocument = {
  path: 'brand/prohibited-claims.md',
  version: 'doc-approved-v1',
  content: `---
status: approved
---
# Prohibited Claims Policy
- 100% cure for cancer
- Guaranteed 10x returns
- Risk-free investment
- Miracle weight loss
- Permanent healing
- 醫療級療效
- 治百病
- Guaranteed zero risk
`,
};

export const PILOT_01_APPROVED_VOICE_GUIDELINES_DOC: MarketingKnowledgeDocument = {
  path: 'brand/voice.md',
  version: 'doc-approved-v1',
  content: `---
status: approved
---
# Brand Voice Guidelines
Professional, calm, seasonal, grounded.
`,
};

/**
 * Baseline deterministic offline fixture: complete pre-dispatch pipeline shape.
 * Pauses at the unmet approval boundary; outcome evidence is strictly empty and UNAVAILABLE.
 */
export const PILOT_01_OFFLINE_FIXTURE: Pilot01StageEvidence = {
  fixture_type: PILOT_01_FIXTURE_MARKER,
  evidence_status: PILOT_01_RUNTIME_EVIDENCE_STATUS,
  tenant_id: PILOT_01_TENANT_ID,
  campaign_id: PILOT_01_CAMPAIGN_ID,
  effect_key: PILOT_01_EFFECT_KEY,
  correlation_id: PILOT_01_CORRELATION_ID,
  run_id: PILOT_01_RUN_ID,

  signal: {
    observation: {
      tenant_id: PILOT_01_TENANT_ID,
      signal_id: 'sig-obs-pilot01-trend',
      keyword: 'cold_brew_tea',
      search_volume_growth: 1.45,
      price_pressure_index: 0.12,
      source_uri: 'feed://market-research/signals/tw/cold_brew_tea',
      source_version: 'v2026-03',
      observed_at: '2026-03-01T08:00:00.000Z',
    },
    evidence: {
      evidence_id: PILOT_01_EVIDENCE_IDS.signal,
      tenant_id: PILOT_01_TENANT_ID,
      run_id: PILOT_01_RUN_ID,
      correlation_id: PILOT_01_CORRELATION_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      classification: 'SIGNAL' as MarketingEvidenceClass,
      source_uri: 'feed://market-research/signals/tw/cold_brew_tea',
      source_version: 'v2026-03',
      claim: 'Search interest for cold brew tea elevated across observation window.',
    },
  },

  segment: {
    input: {
      tenant_id: PILOT_01_TENANT_ID,
      rfm_criteria: 'CHAMPIONS',
      min_days_inactive: 30,
    },
    evidence: {
      evidence_id: PILOT_01_EVIDENCE_IDS.segment,
      tenant_id: PILOT_01_TENANT_ID,
      run_id: PILOT_01_RUN_ID,
      correlation_id: PILOT_01_CORRELATION_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      classification: 'HYPOTHESIS' as MarketingEvidenceClass,
      source_uri: 'policy://marketing/segmentation/rfm-criteria',
      source_version: 'v2026-03',
      claim: 'Targeting hypothesis: Champions segment exhibits elevated affinity for seasonal offerings.',
    },
  },

  content: {
    output: {
      draft_id: 'draft-pilot01-tw-01',
      headline: '春季冷泡茶系列現正登場',
      body_content: '精選台灣高山茶葉，低溫慢萃保留甘甜鮮爽滋味。立即探索春日限定風味。',
      cta_text: '探索春季系列',
      channel_payload: {
        channel_type: 'LINE_FLEX',
        line_flex_container: {
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', contents: [] },
          body: { type: 'box', layout: 'vertical', contents: [] },
        },
      },
    },
    evidence: {
      evidence_id: PILOT_01_EVIDENCE_IDS.content,
      tenant_id: PILOT_01_TENANT_ID,
      run_id: PILOT_01_RUN_ID,
      correlation_id: PILOT_01_CORRELATION_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      classification: 'DRAFT' as MarketingEvidenceClass,
      source_uri: 'worker://marketing/content-engine/draft-pilot01-tw-01',
      source_version: 'rev-01',
      claim: 'Generated multi-channel campaign copy aligned to draft theme.',
    },
  },

  review: {
    audit: {
      compliant: true,
      violations: [],
      confidence_score: 0.98,
    },
    evidence: {
      evidence_id: PILOT_01_EVIDENCE_IDS.review,
      tenant_id: PILOT_01_TENANT_ID,
      run_id: PILOT_01_RUN_ID,
      correlation_id: PILOT_01_CORRELATION_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      classification: 'DECISION' as MarketingEvidenceClass,
      source_uri: 'worker://marketing/brand-auditor/audit-pilot01-01',
      source_version: 'policy-2026-q1',
      claim: 'Brand voice compliance audit confirmed zero prohibited claims.',
    },
  },

  approval_boundary: {
    dependency_id: 'dep-p1b-pilot01-gate',
    required_authority: 'AUTH-4',
    status: 'UNMET_DEPENDENCY',
    blocking_reason: 'AWAITING_HUMAN_APPROVAL_SCR003',
    target_skill_id: 'skill.mkt.dispatch_campaign',
    tenant_id: PILOT_01_TENANT_ID,
    campaign_id: PILOT_01_CAMPAIGN_ID,
    effect_key: PILOT_01_EFFECT_KEY,
    correlation_id: PILOT_01_CORRELATION_ID,
    description:
      'P1B handoff: Campaign dispatch requires human approval at SCR-003 Approval Center. Autonomous dispatch is halted.',
  },

  outcome: {
    input: {
      tenant_id: PILOT_01_TENANT_ID,
      campaign_id: PILOT_01_CAMPAIGN_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      correlation_id: PILOT_01_CORRELATION_ID,
      attribution_model: 'LAST_TOUCH',
      evidence_ids: [],
    },
    contract: {
      campaign_id: PILOT_01_CAMPAIGN_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      correlation_id: PILOT_01_CORRELATION_ID,
      status: 'UNAVAILABLE',
      evidence_ids: [],
      reason: 'AWAITING_APPROVAL_AND_EXTERNAL_EXECUTION',
    },
    order_evidence: [],
    evidence: [],
  },
};

/**
 * Negative scenario fixture: explicitly missing attribution evidence where evidence was requested
 * but none exists in the System of Record.
 */
export const PILOT_01_NEGATIVE_ATTRIBUTION_FIXTURE: Pilot01StageEvidence = {
  ...PILOT_01_OFFLINE_FIXTURE,
  outcome: {
    input: {
      tenant_id: PILOT_01_TENANT_ID,
      campaign_id: PILOT_01_CAMPAIGN_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      correlation_id: PILOT_01_CORRELATION_ID,
      attribution_model: 'LAST_TOUCH',
      evidence_ids: ['ev-absent-order-req'],
    },
    contract: {
      campaign_id: PILOT_01_CAMPAIGN_ID,
      effect_key: PILOT_01_EFFECT_KEY,
      correlation_id: PILOT_01_CORRELATION_ID,
      status: 'UNAVAILABLE',
      evidence_ids: [],
      reason: 'ATTRIBUTION_EVIDENCE_ABSENT',
    },
    order_evidence: [],
    evidence: [],
  },
};

// ============================================================================
// STAGED PIPELINE RESULTS & OPTIONS
// ============================================================================

export interface Pilot01HumanApprovalDecision {
  readonly approval_id?: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly operator_id: string;
  readonly approved_payload_digest: string;
  readonly approved_at: string;
}

export interface Pilot01ApprovalClaimResult {
  readonly claimed: boolean;
  readonly approval_id?: string;
  readonly operator_id?: string;
}

export interface Pilot01ApprovalPort {
  readonly claimApprovalAndResume: (params: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly approval_id: string;
    readonly effect_key: string;
    readonly expected_payload_sha256?: string;
    readonly decision: 'APPROVED' | 'MODIFIED' | 'REJECTED';
    readonly operator_id: string;
  }) => Promise<Pilot01ApprovalClaimResult> | Pilot01ApprovalClaimResult;
}

export interface Pilot01SignalStageResult {
  readonly stage: 'SIGNAL';
  readonly observation: MarketingSignalObservation;
  readonly evidence: MarketingEvidence;
}

export interface Pilot01SegmentStageResult {
  readonly stage: 'SEGMENT';
  readonly input: MarketingSegmentInput;
  readonly candidates: readonly MarketingAudienceCandidate[];
  readonly evidence: MarketingEvidence;
}

export interface Pilot01CampaignStageResult {
  readonly stage: 'CAMPAIGN';
  readonly campaign_id: string;
  readonly tenant_id: string;
  readonly segment_id: string;
  readonly theme: string;
  readonly channel: string;
  readonly locale: string;
}

export interface Pilot01ContentStageResult {
  readonly stage: 'CONTENT';
  readonly output: MarketingContentOutput;
  readonly evidence: MarketingEvidence;
}

export interface Pilot01BrandReviewStageResult {
  readonly stage: 'BRAND_REVIEW';
  readonly audit: MarketingBrandAuditOutput;
  readonly evidence: MarketingEvidence;
}

export interface Pilot01ApprovalStageResult {
  readonly stage: 'APPROVAL';
  readonly status: 'PAUSED_AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly required_authority: 'AUTH-4';
  readonly handoff?: Pilot01ApprovalBoundaryHandoff;
  readonly approval_decision?: Pilot01HumanApprovalDecision;
  readonly payload_digest: string;
  readonly message: string;
}

export interface Pilot01DispatchStageResult {
  readonly stage: 'DISPATCH';
  readonly effect_key: string;
  readonly payload_fingerprint: string;
  readonly status: 'UNAVAILABLE_OFFLINE';
  readonly reason: 'PROVIDER_DISPATCH_UNAVAILABLE_OFFLINE';
  readonly provider_receipt: null;
  readonly message: string;
}

export interface Pilot01ResponseStageResult {
  readonly stage: 'RESPONSE';
  readonly provider_status: 'UNAVAILABLE_OFFLINE';
  readonly delivery_receipt: null;
  readonly offline_report: string;
}

export interface Pilot01AttributionStageResult {
  readonly stage: 'ATTRIBUTION';
  readonly contract: MarketingAttributionContract;
  readonly order_evidence: readonly MarketingAttributedOrderEvidence[];
  readonly evidence: readonly MarketingEvidence[];
  readonly offline_report: string;
}

export interface Pilot01StagedPipelineResult {
  readonly fixture_type: typeof PILOT_01_FIXTURE_MARKER;
  readonly evidence_status: typeof PILOT_01_RUNTIME_EVIDENCE_STATUS;
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly effect_key: string;
  readonly correlation_id: string;
  readonly run_id: string;
  readonly stages: {
    readonly signal: Pilot01SignalStageResult;
    readonly segment: Pilot01SegmentStageResult;
    readonly campaign: Pilot01CampaignStageResult;
    readonly content: Pilot01ContentStageResult;
    readonly review: Pilot01BrandReviewStageResult;
    readonly approval: Pilot01ApprovalStageResult;
    readonly dispatch: Pilot01DispatchStageResult;
    readonly response: Pilot01ResponseStageResult;
    readonly attribution: Pilot01AttributionStageResult;
  };
  readonly offline_summary: {
    readonly provider_dispatch_available: false;
    readonly external_order_evidence_available: false;
    readonly provider_status: 'UNAVAILABLE_OFFLINE';
    readonly attribution_status: 'UNAVAILABLE';
    readonly notes: readonly string[];
  };
}

export interface Pilot01OfflinePorts {
  readonly signalReader?: (input: MarketingSignalInput) => Promise<MarketingSignalResearchResult> | MarketingSignalResearchResult;
  readonly segmenter?: (input: MarketingSegmentInput) => Promise<readonly MarketingAudienceCandidate[]> | readonly MarketingAudienceCandidate[];
  readonly consentChecker?: (input: { tenant_id: string; customer_id: string; channel: string }) => Promise<MarketingConsentDecision> | MarketingConsentDecision;
  readonly knowledgeReader?: (tenant_id: string, path: string) => Promise<MarketingKnowledgeDocument> | MarketingKnowledgeDocument;
  readonly contentGenerator?: (input: MarketingContentInput, approvedDocs: readonly MarketingKnowledgeDocument[]) => Promise<MarketingContentOutput> | MarketingContentOutput;
  readonly brandAuditor?: (input: MarketingBrandAuditInput, approvedDocs: readonly MarketingKnowledgeDocument[]) => Promise<MarketingBrandAuditOutput> | MarketingBrandAuditOutput;
  readonly providerDispatcher?: (action: Record<string, unknown>) => Promise<{ status: string; error?: string; [key: string]: unknown }> | { status: string; error?: string; [key: string]: unknown };
  readonly approvalPort?: Pilot01ApprovalPort;
}
export interface Pilot01StagedPipelineOptions {
  readonly tenant_id?: string;
  readonly campaign_id?: string;
  readonly correlation_id?: string;
  readonly run_id?: string;
  readonly signal_input?: Partial<MarketingSignalInput>;
  readonly segment_input?: Partial<MarketingSegmentInput>;
  readonly content_input?: Partial<MarketingContentInput>;
  readonly audit_input?: Partial<MarketingBrandAuditInput>;
  readonly approval_decision?: Pilot01HumanApprovalDecision;
  readonly candidate_consents?: readonly {
    readonly customer_id: string;
    readonly allowed: boolean;
    readonly consent_timestamp?: string | null;
    readonly suppression_reason?: string | null;
  }[];
  readonly knowledge_documents?: readonly MarketingKnowledgeDocument[];
  readonly reserved_effect_keys?: Set<string>;
  readonly ports?: Pilot01OfflinePorts;
}

// ============================================================================
// NEGATIVE CASE VALIDATORS
// ============================================================================

const UNVERIFIED_PRICE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\$\s*\d+(?:\.\d{2})?/i,
  /\b\d+%\s*off\b/i,
  /\bNT\$\s*\d+/i,
  /\bUSD\s*\d+/i,
  /\bEUR\s*\d+/i,
  /\b(?:¥|￥)\s*\d+/i,
  /\b\d+\s*元\b/,
  /\b100%\s*free\b/i,
  /\bfree\s+gift\b/i,
  /\bmoney[- ]back\s+guarantee\b/i,
  /\bguaranteed\s+(?:discount|cashback)\b/i,
]);

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const STATUS_REGEX = /^status:[ \t]*(\S.*?)[ \t]*$/m;

/**
 * Validates marketing consent. Fails closed if consent was not granted.
 */
export function validateConsent(decision: MarketingConsentDecision): void {
  if (!decision || typeof decision !== 'object') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Consent decision must be an object');
  }
  if (!decision.allowed) {
    if (decision.suppression_reason) {
      throw new MarketingRuntimeError(
        'CUSTOMER_SUPPRESSED',
        `Customer '${decision.customer_id}' is suppressed: ${decision.suppression_reason}`,
      );
    }
    throw new MarketingRuntimeError(
      'CONSENT_MISSING',
      `Marketing consent is missing or not granted for customer '${decision.customer_id}' on channel '${decision.channel}'`,
    );
  }
}

/**
 * Validates that an audience candidate is not suppressed.
 */
export function validateCustomerSuppression(decision: MarketingConsentDecision): void {
  if (!decision || typeof decision !== 'object') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Consent decision must be an object');
  }
  if (decision.suppression_reason || !decision.allowed) {
    throw new MarketingRuntimeError(
      'CUSTOMER_SUPPRESSED',
      `Customer '${decision.customer_id}' is suppressed from marketing communications: ${decision.suppression_reason ?? 'Suppressed'}`,
    );
  }
}

/**
 * Validates knowledge document frontmatter status. Fails closed if not 'approved'.
 */
export function validateKnowledgeDocument(
  doc: MarketingKnowledgeDocument,
  expectedPath?: string,
): void {
  if (!doc || typeof doc !== 'object') {
    throw new MarketingRuntimeError(
      'KNOWLEDGE_DOCUMENT_INVALID',
      'Knowledge document must be a non-null object',
    );
  }
  if (expectedPath && doc.path !== expectedPath) {
    throw new MarketingRuntimeError(
      'KNOWLEDGE_DOCUMENT_INVALID',
      `Knowledge document path '${doc.path}' does not match expected path '${expectedPath}'`,
    );
  }
  if (!doc.path || !doc.version || !doc.content || doc.content.trim().length === 0) {
    throw new MarketingRuntimeError(
      'KNOWLEDGE_DOCUMENT_INVALID',
      `Knowledge document '${doc.path ?? 'unknown'}' is invalid or has empty content`,
    );
  }

  const frontmatter = FRONTMATTER_REGEX.exec(doc.content);
  const statusMatch = frontmatter ? STATUS_REGEX.exec(frontmatter[1] ?? '') : null;
  const status = statusMatch ? statusMatch[1]?.trim().toLowerCase() : null;

  if (status !== 'approved') {
    throw new MarketingRuntimeError(
      'DOCUMENT_NOT_APPROVED',
      `Knowledge document '${doc.path}' frontmatter status is '${status ?? 'missing'}', expected 'approved'`,
    );
  }
}

/**
 * Validates brand compliance audit results against prohibited claims.
 */
export function validateBrandCompliance(output: MarketingBrandAuditOutput): void {
  if (!output || typeof output !== 'object') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Brand audit output must be an object');
  }
  if (!output.compliant || output.violations.length > 0) {
    const violationSummary = output.violations.map((v) => `[${v.rule_id}]: ${v.snippet}`).join('; ');
    throw new MarketingRuntimeError(
      'PROHIBITED_CLAIM_VIOLATION',
      `Brand compliance audit rejected draft text with ${output.violations.length} violation(s): ${violationSummary}`,
    );
  }
}

/**
 * Validates that draft text does not contain invented, unverified price/discount claims.
 */
export function validatePriceClaims(text: string): void {
  if (typeof text !== 'string') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Text must be a string for price validation');
  }
  for (const pattern of UNVERIFIED_PRICE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      throw new MarketingRuntimeError(
        'UNVERIFIED_PRICE_CLAIM',
        `Draft text contains unverified price or promotional claim: "${match[0]}"`,
      );
    }
  }
}

/**
 * Validates that an approval digest matches current canonical payload fingerprint.
 */
export function validateApprovalDigest(expectedSha256: string, actualSha256: string): void {
  if (typeof expectedSha256 !== 'string' || typeof actualSha256 !== 'string') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Digests must be non-empty strings');
  }
  if (expectedSha256.toLowerCase() !== actualSha256.toLowerCase()) {
    throw new MarketingRuntimeError(
      'STALE_APPROVAL_DIGEST',
      `Approval digest '${actualSha256}' does not match current payload digest '${expectedSha256}'`,
    );
  }
}

/**
 * Validates that a payload has not been modified after AUTH-4 approval was granted.
 */
export function validatePayloadIntegrity(
  approvedDigest: string,
  payload: Record<string, unknown>,
): void {
  if (typeof approvedDigest !== 'string' || !payload || typeof payload !== 'object') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Approved digest and payload are required');
  }
  const currentFingerprint = computeRequestFingerprint(payload);
  if (currentFingerprint.toLowerCase() !== approvedDigest.toLowerCase()) {
    throw new MarketingRuntimeError(
      'PAYLOAD_TAMPERED_AFTER_APPROVAL',
      `Dispatched payload does not match approved digest: expected '${approvedDigest}', got '${currentFingerprint}'`,
    );
  }
}

/**
 * Validates authority requirements. Terminal hard deny on AUTH-5.
 */
export function validateAuthority(
  granted: unknown,
  required: unknown,
): { verdict: string; errorCode: string | null; reason: string } {
  if (required === 'AUTH-5' || granted === 'AUTH-5') {
    throw new MarketingRuntimeError(
      'PROHIBITED_ACTION',
      'AUTH-5 is prohibited; marketing pipeline cannot authorize autonomous or approvable dispatch under AUTH-5',
    );
  }
  const decision = evaluateAuthorityVerdict(granted, required);
  if (decision.verdict === 'DENIED') {
    throw new MarketingRuntimeError(
      decision.errorCode ?? 'INSUFFICIENT_AUTHORITY',
      decision.reason,
    );
  }
  return decision;
}

/**
 * Validates effect reservation against duplicate dispatch.
 */
export function validateEffectReservation(
  effectKey: string,
  reservedKeys: Set<string>,
): void {
  if (typeof effectKey !== 'string' || effectKey.trim().length === 0) {
    throw new MarketingRuntimeError('INVALID_INPUT', 'effectKey must be a non-empty string');
  }
  if (reservedKeys.has(effectKey)) {
    throw new MarketingRuntimeError(
      'DUPLICATE_DISPATCH',
      `Effect key '${effectKey}' has already been reserved or dispatched; duplicate dispatch is prohibited`,
    );
  }
}

/**
 * Validates provider responses. UNKNOWN or INDETERMINATE statuses fail closed.
 */
export function validateProviderResponse(response: {
  status: string;
  [key: string]: unknown;
}): void {
  if (!response || typeof response !== 'object') {
    throw new MarketingRuntimeError('INVALID_INPUT', 'Provider response must be an object');
  }
  if (response.status === 'UNKNOWN' || response.status === 'INDETERMINATE') {
    throw new MarketingRuntimeError(
      'PROVIDER_UNKNOWN',
      `Provider returned '${response.status}' status; failing closed to prevent unproven effect duplication`,
    );
  }
}

/**
 * Validates tenant isolation across items.
 */
export function validateTenantIsolation(
  expectedTenantId: string,
  item: { tenant_id: string },
  label = 'item',
): void {
  if (!item || typeof item !== 'object' || typeof item.tenant_id !== 'string') {
    throw new MarketingRuntimeError('INVALID_INPUT', `Tenant-bearing ${label} must provide tenant_id`);
  }
  if (item.tenant_id !== expectedTenantId) {
    throw new MarketingRuntimeError(
      'TENANT_MISMATCH',
      `Cross-tenant leakage detected: ${label} tenant_id '${item.tenant_id}' does not match expected tenant '${expectedTenantId}'`,
    );
  }
}

/**
 * Asserts that attribution evidence is present and valid; refuses absent data.
 */
export function assertAttributionEvidenceAvailable(
  input: MarketingAttributionInput,
  availableOrderEvidence: readonly MarketingAttributedOrderEvidence[],
): void {
  if (!input.evidence_ids || input.evidence_ids.length === 0 || availableOrderEvidence.length === 0) {
    throw new MarketingRuntimeError(
      'ATTRIBUTION_EVIDENCE_ABSENT',
      'Attribution evidence is absent; no external order evidence is available in System of Record',
    );
  }
  const availableLookup: Record<string, MarketingAttributedOrderEvidence> = {};
  for (const item of availableOrderEvidence) {
    if (
      item.tenant_id === input.tenant_id &&
      item.campaign_id === input.campaign_id &&
      item.effect_key === input.effect_key &&
      item.correlation_id === input.correlation_id
    ) {
      availableLookup[item.evidence_id] = item;
    }
  }
  for (const id of input.evidence_ids) {
    if (!availableLookup[id]) {
      throw new MarketingRuntimeError(
        'ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED',
        `Requested attribution evidence ID '${id}' is missing or unmatched in available order evidence`,
      );
    }
  }
}

function evaluateAttributionContractInternal(
  input: MarketingAttributionInput,
  availableOrderEvidence: readonly MarketingAttributedOrderEvidence[],
): MarketingAttributionContract {
  if (!input.evidence_ids || input.evidence_ids.length === 0) {
    return {
      campaign_id: input.campaign_id,
      effect_key: input.effect_key,
      correlation_id: input.correlation_id,
      status: 'UNAVAILABLE',
      evidence_ids: [],
      reason: 'ATTRIBUTION_EVIDENCE_ABSENT',
    };
  }

  if (availableOrderEvidence.length === 0) {
    return {
      campaign_id: input.campaign_id,
      effect_key: input.effect_key,
      correlation_id: input.correlation_id,
      status: 'UNAVAILABLE',
      evidence_ids: [],
      reason: 'ATTRIBUTION_EVIDENCE_ABSENT',
    };
  }

  const availableLookup: Record<string, MarketingAttributedOrderEvidence> = {};
  for (const item of availableOrderEvidence) {
    if (
      item.tenant_id === input.tenant_id &&
      item.campaign_id === input.campaign_id &&
      item.effect_key === input.effect_key &&
      item.correlation_id === input.correlation_id
    ) {
      availableLookup[item.evidence_id] = item;
    }
  }

  const verifiedIds: string[] = [];
  for (const id of input.evidence_ids) {
    if (availableLookup[id]) {
      verifiedIds.push(id);
    }
  }

  if (verifiedIds.length === 0 || verifiedIds.length < input.evidence_ids.length) {
    return {
      campaign_id: input.campaign_id,
      effect_key: input.effect_key,
      correlation_id: input.correlation_id,
      status: 'UNAVAILABLE',
      evidence_ids: verifiedIds,
      reason: 'ATTRIBUTION_EVIDENCE_INCOMPLETE_OR_UNMATCHED',
    };
  }

  return {
    campaign_id: input.campaign_id,
    effect_key: input.effect_key,
    correlation_id: input.correlation_id,
    status: 'READY_FOR_EVIDENCE',
    evidence_ids: verifiedIds,
    reason: null,
  };
}

// ============================================================================
// STAGED PIPELINE EXECUTION
// ============================================================================

/**
 * Executable deterministic staged acceptance harness for PILOT-01.
 * Stages: Signal -> Segment -> Campaign -> Content -> Brand Review -> AUTH-4 Approval -> Dispatch -> Response -> Attribution
 */
export async function executePilot01StagedPipeline(
  options: Pilot01StagedPipelineOptions = {},
): Promise<Pilot01StagedPipelineResult> {
  const tenant_id = options.tenant_id ?? PILOT_01_TENANT_ID;
  const campaign_id = options.campaign_id ?? PILOT_01_CAMPAIGN_ID;
  const correlation_id = options.correlation_id ?? PILOT_01_CORRELATION_ID;
  const run_id = options.run_id ?? PILOT_01_RUN_ID;
  const reservedKeys = options.reserved_effect_keys ?? new Set<string>();

  // ==========================================
  // STAGE 1: Market Signal Analysis
  // ==========================================
  const signalInput: MarketingSignalInput = {
    tenant_id: options.signal_input?.tenant_id ?? tenant_id,
    market_region: options.signal_input?.market_region ?? 'TW',
    category_id: options.signal_input?.category_id ?? 'cat-tea-cold-brew',
    observation_window_days: options.signal_input?.observation_window_days ?? 30,
  };
  validateTenantIsolation(tenant_id, signalInput, 'signal input');

  let signalObservation: MarketingSignalObservation;
  if (options.ports?.signalReader) {
    const research = await options.ports.signalReader(signalInput);
    signalObservation = research.signals[0]
      ? {
          tenant_id,
          signal_id: research.signals[0].signal_id,
          keyword: research.signals[0].keyword,
          search_volume_growth: research.signals[0].search_volume_growth,
          price_pressure_index: research.signals[0].price_pressure_index,
          source_uri: `feed://market-research/signals/tw/${research.signals[0].keyword}`,
          source_version: 'v2026-03',
          observed_at: research.analyzed_at,
        }
      : PILOT_01_OFFLINE_FIXTURE.signal.observation;
  } else {
    signalObservation = PILOT_01_OFFLINE_FIXTURE.signal.observation;
  }
  validateTenantIsolation(tenant_id, signalObservation, 'signal observation');

  const effect_key = computePilot01StagedEffectKey({
    tenant_id,
    correlation_id,
  });
  const signalEvidence: MarketingEvidence = {
    evidence_id: PILOT_01_EVIDENCE_IDS.signal,
    tenant_id,
    run_id,
    correlation_id,
    effect_key,
    classification: 'SIGNAL',
    source_uri: signalObservation.source_uri,
    source_version: signalObservation.source_version,
    claim: 'Search interest for cold brew tea elevated across observation window.',
  };

  const signalStage: Pilot01SignalStageResult = {
    stage: 'SIGNAL',
    observation: signalObservation,
    evidence: signalEvidence,
  };

  // ==========================================
  // STAGE 2: Audience Segmentation Hypothesis
  // ==========================================
  const segmentInput: MarketingSegmentInput = {
    tenant_id,
    rfm_criteria: options.segment_input?.rfm_criteria ?? 'CHAMPIONS',
    min_days_inactive: options.segment_input?.min_days_inactive ?? 30,
    max_segment_size: options.segment_input?.max_segment_size,
  };
  validateTenantIsolation(tenant_id, segmentInput, 'segment input');

  const audienceCandidates: readonly MarketingAudienceCandidate[] =
    options.ports?.segmenter ? await options.ports.segmenter(segmentInput) : [];

  for (const cand of audienceCandidates) {
    validateTenantIsolation(tenant_id, cand, `candidate ${cand.customer_id}`);
  }

  // Validate candidate consents if provided
  if (options.candidate_consents) {
    for (const consent of options.candidate_consents) {
      const decision: MarketingConsentDecision = {
        tenant_id,
        customer_id: consent.customer_id,
        channel: 'LINE_FLEX',
        allowed: consent.allowed,
        consent_timestamp: consent.consent_timestamp ?? (consent.allowed ? '2026-03-01T00:00:00Z' : null),
        suppression_reason: consent.suppression_reason ?? null,
        source_uri: 'consent://db/tw',
        source_version: 'v1',
      };
      validateConsent(decision);
      validateCustomerSuppression(decision);
    }
  }

  const segmentEvidence: MarketingEvidence = {
    evidence_id: PILOT_01_EVIDENCE_IDS.segment,
    tenant_id,
    run_id,
    correlation_id,
    effect_key,
    classification: 'HYPOTHESIS',
    source_uri: 'policy://marketing/segmentation/rfm-criteria',
    source_version: 'v2026-03',
    claim: 'Targeting hypothesis: Champions segment exhibits elevated affinity for seasonal offerings.',
  };

  const segmentStage: Pilot01SegmentStageResult = {
    stage: 'SEGMENT',
    input: segmentInput,
    candidates: audienceCandidates,
    evidence: segmentEvidence,
  };

  // ==========================================
  // STAGE 3: Campaign Configuration & Binding
  // ==========================================
  const campaignStage: Pilot01CampaignStageResult = {
    stage: 'CAMPAIGN',
    campaign_id,
    tenant_id,
    segment_id: 'seg-champions-pilot01',
    theme: options.content_input?.campaign_theme ?? '春季冷泡茶系列現正登場',
    channel: options.content_input?.channel ?? 'LINE_FLEX',
    locale: options.content_input?.locale ?? 'zh-TW',
  };
  validateTenantIsolation(tenant_id, campaignStage, 'campaign');

  // ==========================================
  // STAGE 4: Content Generation Draft
  // ==========================================
  const contentInput: MarketingContentInput = {
    tenant_id: options.content_input?.tenant_id ?? tenant_id,
    campaign_theme: campaignStage.theme,
    channel: campaignStage.channel as MarketingContentInput['channel'],
    locale: campaignStage.locale as MarketingContentInput['locale'],
    product_skus: options.content_input?.product_skus ?? ['SKU-TEA-001'],
  };
  validateTenantIsolation(tenant_id, contentInput, 'content input');

  // Load and validate knowledge documents
  const knowledgeDocs: readonly MarketingKnowledgeDocument[] =
    options.knowledge_documents ?? [
      PILOT_01_APPROVED_PROHIBITED_CLAIMS_DOC,
      PILOT_01_APPROVED_VOICE_GUIDELINES_DOC,
    ];

  for (const doc of knowledgeDocs) {
    validateKnowledgeDocument(doc);
  }

  let contentOutput: MarketingContentOutput;
  if (options.ports?.contentGenerator) {
    contentOutput = await options.ports.contentGenerator(contentInput, knowledgeDocs);
  } else {
    contentOutput = PILOT_01_OFFLINE_FIXTURE.content.output;
  }

  // Validate no unverified price claims in copy
  validatePriceClaims(contentOutput.headline);
  validatePriceClaims(contentOutput.body_content);
  validatePriceClaims(contentOutput.cta_text);

  const contentEvidence: MarketingEvidence = {
    evidence_id: PILOT_01_EVIDENCE_IDS.content,
    tenant_id,
    run_id,
    correlation_id,
    effect_key,
    classification: 'DRAFT',
    source_uri: `worker://marketing/content-engine/${contentOutput.draft_id}`,
    source_version: 'rev-01',
    claim: 'Generated multi-channel campaign copy aligned to draft theme.',
  };

  const contentStage: Pilot01ContentStageResult = {
    stage: 'CONTENT',
    output: contentOutput,
    evidence: contentEvidence,
  };

  // ==========================================
  // STAGE 5: Brand Voice Compliance Audit Decision
  // ==========================================
  const brandAuditInput: MarketingBrandAuditInput = {
    tenant_id: options.audit_input?.tenant_id ?? tenant_id,
    draft_text: options.audit_input?.draft_text ?? `${contentOutput.headline} ${contentOutput.body_content}`,
    channel: options.audit_input?.channel ?? contentInput.channel,
  };
  validateTenantIsolation(tenant_id, brandAuditInput, 'brand audit input');
  validatePriceClaims(brandAuditInput.draft_text);

  let brandAuditOutput: MarketingBrandAuditOutput;
  if (options.ports?.brandAuditor) {
    brandAuditOutput = await options.ports.brandAuditor(brandAuditInput, knowledgeDocs);
  } else {
    brandAuditOutput = PILOT_01_OFFLINE_FIXTURE.review.audit;
  }

  validateBrandCompliance(brandAuditOutput);

  const reviewEvidence: MarketingEvidence = {
    evidence_id: PILOT_01_EVIDENCE_IDS.review,
    tenant_id,
    run_id,
    correlation_id,
    effect_key,
    classification: 'DECISION',
    source_uri: 'worker://marketing/brand-auditor/audit-pilot01-01',
    source_version: 'policy-2026-q1',
    claim: 'Brand voice compliance audit confirmed zero prohibited claims.',
  };

  const brandReviewStage: Pilot01BrandReviewStageResult = {
    stage: 'BRAND_REVIEW',
    audit: brandAuditOutput,
    evidence: reviewEvidence,
  };

  // ==========================================
  // STAGE 6: AUTH-4 Approval Gate
  // ==========================================
  const dispatchPayload: Record<string, unknown> = {
    tenant_id,
    campaign_id,
    segment_id: campaignStage.segment_id,
    channel: campaignStage.channel,
    approved_content_id: contentOutput.draft_id,
    effect_key,
  };

  const payloadFingerprint = computeRequestFingerprint(dispatchPayload);

  let approvalStage: Pilot01ApprovalStageResult;
  if (!options.approval_decision) {
    // Unmet approval dependency: pause at SCR-003
    approvalStage = {
      stage: 'APPROVAL',
      status: 'PAUSED_AWAITING_APPROVAL',
      required_authority: 'AUTH-4',
      handoff: {
        dependency_id: 'dep-p1b-pilot01-gate',
        required_authority: 'AUTH-4',
        status: 'UNMET_DEPENDENCY',
        blocking_reason: 'AWAITING_HUMAN_APPROVAL_SCR003',
        target_skill_id: 'skill.mkt.dispatch_campaign',
        tenant_id,
        campaign_id,
        effect_key,
        correlation_id,
        description:
          'P1B handoff: Campaign dispatch requires human approval at SCR-003 Approval Center. Autonomous dispatch is halted.',
      },
      payload_digest: payloadFingerprint,
      message: 'Approval unmet: pipeline paused at AUTH-4 gate (SCR-003).',
    };
  } else {
    const decision = options.approval_decision;
    if (
      (decision as unknown as Record<string, unknown>).granted_authority === 'AUTH-5' ||
      (options as Record<string, unknown>).granted_authority === 'AUTH-5' ||
      (options as Record<string, unknown>).authority_verdict === 'AUTH-5'
    ) {
      throw new MarketingRuntimeError(
        'PROHIBITED_ACTION',
        'AUTH-5 is prohibited; marketing pipeline cannot authorize autonomous or approvable dispatch under AUTH-5',
      );
    }
    if (decision.decision === 'REJECTED') {
      throw new MarketingRuntimeError(
        'APPROVAL_REJECTED',
        `AUTH-4 human approval was rejected by operator '${decision.operator_id}'`,
      );
    }
    if (decision.decision !== 'APPROVED') {
      throw new MarketingRuntimeError(
        'APPROVAL_DECISION_INVALID',
        `Invalid or non-approved decision '${String(decision.decision)}' at AUTH-4 gate`,
      );
    }
    validateApprovalDigest(payloadFingerprint, decision.approved_payload_digest);
    validatePayloadIntegrity(decision.approved_payload_digest, dispatchPayload);

    // Offline approved paths must require a real server/decision-supplied approval_id
    // and an injected canonical approval port; otherwise remain PAUSED_AWAITING_APPROVAL.
    const approvalId = decision.approval_id?.trim();
    if (!approvalId) {
      approvalStage = {
        stage: 'APPROVAL',
        status: 'PAUSED_AWAITING_APPROVAL',
        required_authority: 'AUTH-4',
        handoff: {
          dependency_id: 'dep-p1b-pilot01-gate',
          required_authority: 'AUTH-4',
          status: 'UNMET_DEPENDENCY',
          blocking_reason: 'AWAITING_HUMAN_APPROVAL_SCR003',
          target_skill_id: 'skill.mkt.dispatch_campaign',
          tenant_id,
          campaign_id,
          effect_key,
          correlation_id,
          description:
            'P1B handoff: Campaign dispatch requires real server-supplied approval_id at SCR-003. Autonomous dispatch is halted.',
        },
        approval_decision: decision,
        payload_digest: payloadFingerprint,
        message: 'Approval pending real approval_id: pipeline remained paused at AUTH-4 gate (SCR-003).',
      };
    } else if (!options.ports?.approvalPort) {
      approvalStage = {
        stage: 'APPROVAL',
        status: 'PAUSED_AWAITING_APPROVAL',
        required_authority: 'AUTH-4',
        handoff: {
          dependency_id: 'dep-p1b-pilot01-gate',
          required_authority: 'AUTH-4',
          status: 'UNMET_DEPENDENCY',
          blocking_reason: 'AWAITING_HUMAN_APPROVAL_SCR003',
          target_skill_id: 'skill.mkt.dispatch_campaign',
          tenant_id,
          campaign_id,
          effect_key,
          correlation_id,
          description:
            'P1B handoff: Campaign dispatch requires canonical approval port at SCR-003. Injected approval port absent.',
        },
        approval_decision: decision,
        payload_digest: payloadFingerprint,
        message: 'Approval pending canonical claim: pipeline remained paused at AUTH-4 gate (SCR-003).',
      };
    } else {
      const canonicalClaim = await options.ports.approvalPort.claimApprovalAndResume({
        tenant_id,
        run_id,
        approval_id: approvalId,
        effect_key,
        expected_payload_sha256: payloadFingerprint,
        decision: decision.decision,
        operator_id: decision.operator_id,
      });

      if (!canonicalClaim || canonicalClaim.claimed !== true) {
        throw new MarketingRuntimeError(
          'APPROVAL_NOT_RELEASED',
          `Approval claim rejected or not claimed (claimed=${String(canonicalClaim?.claimed)}) at AUTH-4 gate`,
        );
      }

      approvalStage = {
        stage: 'APPROVAL',
        status: 'APPROVED',
        required_authority: 'AUTH-4',
        approval_decision: decision,
        payload_digest: payloadFingerprint,
        message: `AUTH-4 human approval granted by operator '${decision.operator_id}'.`,
      };
    }
  }

  // ==========================================
  // STAGE 7: Campaign Dispatch (Offline Boundary)
  // ==========================================
  validateEffectReservation(effect_key, reservedKeys);

  if (approvalStage.status === 'APPROVED' && options.ports?.providerDispatcher) {
    const response = await options.ports.providerDispatcher(dispatchPayload);
    validateProviderResponse(response);
  }

  const dispatchStage: Pilot01DispatchStageResult = {
    stage: 'DISPATCH',
    effect_key,
    payload_fingerprint: payloadFingerprint,
    status: 'UNAVAILABLE_OFFLINE',
    reason: 'PROVIDER_DISPATCH_UNAVAILABLE_OFFLINE',
    provider_receipt: null,
    message: 'Provider dispatch is unavailable in offline harness mode; no live broadcast was performed.',
  };

  // ==========================================
  // STAGE 8: Dispatch Response (Offline Boundary)
  // ==========================================
  const responseStage: Pilot01ResponseStageResult = {
    stage: 'RESPONSE',
    provider_status: 'UNAVAILABLE_OFFLINE',
    delivery_receipt: null,
    offline_report:
      'Dispatch response: provider dispatch is unavailable offline. No receipt minted.',
  };

  // ==========================================
  // STAGE 9: Attribution Outcome (Offline Boundary)
  // ==========================================
  const attributionStage: Pilot01AttributionStageResult = {
    stage: 'ATTRIBUTION',
    contract: {
      campaign_id,
      effect_key,
      correlation_id,
      status: 'UNAVAILABLE',
      evidence_ids: [],
      reason: 'ATTRIBUTION_EVIDENCE_ABSENT',
    },
    order_evidence: [],
    evidence: [],
    offline_report:
      'External order evidence from ERP/System of Record is unavailable in offline harness mode. Contract status remains UNAVAILABLE.',
  };

  return {
    fixture_type: PILOT_01_FIXTURE_MARKER,
    evidence_status: PILOT_01_RUNTIME_EVIDENCE_STATUS,
    tenant_id,
    campaign_id,
    effect_key,
    correlation_id,
    run_id,
    stages: {
      signal: signalStage,
      segment: segmentStage,
      campaign: campaignStage,
      content: contentStage,
      review: brandReviewStage,
      approval: approvalStage,
      dispatch: dispatchStage,
      response: responseStage,
      attribution: attributionStage,
    },
    offline_summary: {
      provider_dispatch_available: false,
      external_order_evidence_available: false,
      provider_status: 'UNAVAILABLE_OFFLINE',
      attribution_status: 'UNAVAILABLE',
      notes: [
        'Offline staged acceptance harness executed deterministically.',
        'Provider dispatch is UNAVAILABLE offline: no external broadcast, delivery receipts, or provider communication executed.',
        'External order evidence is UNAVAILABLE offline: no ERP order rows, revenue sums, or KPI conversions fabricated.',
      ],
    },
  };
}

// ============================================================================
// HARNESS VALIDATOR INTERFACE & FACTORY
// ============================================================================

/**
 * Interface for PILOT-01 offline harness validation and execution.
 */
export interface Pilot01HarnessValidator {
  /**
   * Verifies that all evidence items share consistent tenant_id, effect_key,
   * and correlation_id linkage across every pipeline stage.
   */
  readonly verifyEvidenceLinkage: (scenario: Pilot01StageEvidence) => {
    readonly valid: boolean;
    readonly mismatches: readonly string[];
  };

  /**
   * Verifies that evidence classifications strictly conform to contract domain semantics:
   * signal -> SIGNAL, segment -> HYPOTHESIS, content -> DRAFT, review -> DECISION.
   * Any outcome evidence present must be FACT.
   */
  readonly verifyClassificationInvariants: (scenario: Pilot01StageEvidence) => {
    readonly valid: boolean;
    readonly violations: readonly string[];
  };

  /**
   * Asserts that the approval boundary represents an unmet dependency (AUTH-4 required),
   * refusing any dispatch or approval claims.
   */
  readonly assertApprovalHandoffUnmet: (handoff: Pilot01ApprovalBoundaryHandoff) => void;

  /**
   * Evaluates attribution input against available order evidence.
   * In offline harness mode, refuses absent evidence without fabricating external receipts.
   */
  readonly evaluateAttributionContract: (
    input: MarketingAttributionInput,
    availableOrderEvidence: readonly MarketingAttributedOrderEvidence[],
  ) => MarketingAttributionContract;

  /**
   * Runs the complete staged pipeline from Signal to Attribution deterministically.
   */
  readonly executeStagedPipeline: (
    options?: Pilot01StagedPipelineOptions,
  ) => Promise<Pilot01StagedPipelineResult>;

  /** Negative-case validators */
  readonly validateConsent: (decision: MarketingConsentDecision) => void;
  readonly validateCustomerSuppression: (decision: MarketingConsentDecision) => void;
  readonly validateKnowledgeDocument: (doc: MarketingKnowledgeDocument, expectedPath?: string) => void;
  readonly validateBrandCompliance: (output: MarketingBrandAuditOutput) => void;
  readonly validatePriceClaims: (text: string) => void;
  readonly validateApprovalDigest: (expectedSha256: string, actualSha256: string) => void;
  readonly validatePayloadIntegrity: (approvedDigest: string, payload: Record<string, unknown>) => void;
  readonly validateAuthority: (granted: unknown, required: unknown) => { verdict: string; errorCode: string | null; reason: string };
  readonly validateEffectReservation: (effectKey: string, reservedKeys: Set<string>) => void;
  readonly validateProviderResponse: (response: { status: string; [key: string]: unknown }) => void;
  readonly validateTenantIsolation: (expectedTenantId: string, item: { tenant_id: string }, label?: string) => void;
  readonly assertAttributionEvidenceAvailable: (input: MarketingAttributionInput, availableOrderEvidence: readonly MarketingAttributedOrderEvidence[]) => void;
}

/**
 * Factory creating a deterministic PILOT-01 offline harness validator.
 */
export function createPilot01Harness(): Pilot01HarnessValidator {
  return {
    verifyEvidenceLinkage: (scenario: Pilot01StageEvidence) => {
      const mismatches: string[] = [];
      const expectedTenant = scenario.tenant_id;
      const expectedEffect = scenario.effect_key;
      const expectedCorr = scenario.correlation_id;

      const checkItem = (label: string, item: { tenant_id: string; effect_key: string; correlation_id: string }) => {
        if (item.tenant_id !== expectedTenant) {
          mismatches.push(`${label}: tenant_id '${item.tenant_id}' !== '${expectedTenant}'`);
        }
        if (item.effect_key !== expectedEffect) {
          mismatches.push(`${label}: effect_key '${item.effect_key}' !== '${expectedEffect}'`);
        }
        if (item.correlation_id !== expectedCorr) {
          mismatches.push(`${label}: correlation_id '${item.correlation_id}' !== '${expectedCorr}'`);
        }
      };

      checkItem('signal.evidence', scenario.signal.evidence);
      checkItem('segment.evidence', scenario.segment.evidence);
      checkItem('content.evidence', scenario.content.evidence);
      checkItem('review.evidence', scenario.review.evidence);
      checkItem('approval_boundary', scenario.approval_boundary);

      for (let i = 0; i < scenario.outcome.evidence.length; i++) {
        const ev = scenario.outcome.evidence[i]!;
        checkItem(`outcome.evidence[${i}]`, ev);
      }

      for (let i = 0; i < scenario.outcome.order_evidence.length; i++) {
        const ord = scenario.outcome.order_evidence[i]!;
        checkItem(`outcome.order_evidence[${i}]`, ord);
      }

      return {
        valid: mismatches.length === 0,
        mismatches,
      };
    },

    verifyClassificationInvariants: (scenario: Pilot01StageEvidence) => {
      const violations: string[] = [];

      if (scenario.signal.evidence.classification !== 'SIGNAL') {
        violations.push(`signal evidence classification must be 'SIGNAL', got '${scenario.signal.evidence.classification}'`);
      }
      if (scenario.segment.evidence.classification !== 'HYPOTHESIS') {
        violations.push(`segment evidence classification must be 'HYPOTHESIS', got '${scenario.segment.evidence.classification}'`);
      }
      if (scenario.content.evidence.classification !== 'DRAFT') {
        violations.push(`content evidence classification must be 'DRAFT', got '${scenario.content.evidence.classification}'`);
      }
      if (scenario.review.evidence.classification !== 'DECISION') {
        violations.push(`review evidence classification must be 'DECISION', got '${scenario.review.evidence.classification}'`);
      }

      for (const ev of scenario.outcome.evidence) {
        if (ev.classification !== 'FACT') {
          violations.push(`outcome evidence classification must be 'FACT', got '${ev.classification}'`);
        }
      }

      return {
        valid: violations.length === 0,
        violations,
      };
    },

    assertApprovalHandoffUnmet: (handoff: Pilot01ApprovalBoundaryHandoff) => {
      if (handoff.status !== 'UNMET_DEPENDENCY') {
        throw new MarketingRuntimeError(
          'APPROVAL_STATUS_VIOLATION',
          `Expected status 'UNMET_DEPENDENCY', received '${handoff.status}'. Dispatch must not be claimed.`,
        );
      }
      if (handoff.required_authority !== 'AUTH-4') {
        throw new MarketingRuntimeError(
          'AUTHORITY_VIOLATION',
          `Campaign dispatch requires 'AUTH-4', received '${handoff.required_authority}'.`,
        );
      }
      if (handoff.blocking_reason !== 'AWAITING_HUMAN_APPROVAL_SCR003') {
        throw new MarketingRuntimeError(
          'BLOCKING_REASON_MISMATCH',
          `Expected blocking reason 'AWAITING_HUMAN_APPROVAL_SCR003', got '${handoff.blocking_reason}'.`,
        );
      }
    },

    evaluateAttributionContract: evaluateAttributionContractInternal,
    executeStagedPipeline: executePilot01StagedPipeline,

    validateConsent,
    validateCustomerSuppression,
    validateKnowledgeDocument,
    validateBrandCompliance,
    validatePriceClaims,
    validateApprovalDigest,
    validatePayloadIntegrity,
    validateAuthority,
    validateEffectReservation,
    validateProviderResponse,
    validateTenantIsolation,
    assertAttributionEvidenceAvailable,
  };
}

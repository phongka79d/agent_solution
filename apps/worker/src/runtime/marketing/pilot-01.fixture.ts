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
 */

import {
  type MarketingAttributedOrderEvidence,
  type MarketingAttributionContract,
  type MarketingAttributionInput,
  type MarketingBrandAuditOutput,
  type MarketingContentOutput,
  type MarketingEvidence,
  type MarketingEvidenceClass,
  type MarketingSegmentInput,
  type MarketingSignalObservation,
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
      'P1B handoff: Campaign dispatch requires signed AUTH-4 human approval at SCR-003 Approval Center. Autonomous dispatch is halted.',
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

/**
 * Interface for PILOT-01 offline harness validation.
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

    evaluateAttributionContract: (
      input: MarketingAttributionInput,
      availableOrderEvidence: readonly MarketingAttributedOrderEvidence[],
    ): MarketingAttributionContract => {
      // If evidence_ids are empty or no order evidence is supplied, refuse as UNAVAILABLE.
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
    },
  };
}

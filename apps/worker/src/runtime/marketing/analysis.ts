/**
 * @file Pure helper functions for MKT-01 (Market Signal Analysis) and MKT-02 (Audience Segmentation).
 *
 * INVARIANTS:
 * 1. Pure data transformations: no database access, no network calls, no global state.
 * 2. Strict tenant isolation: tenant_id must match context; cross-tenant rows are rejected.
 * 3. Epistemic integrity:
 *    - Observations are classified as SIGNAL.
 *    - Inferred segment memberships and derived trends are classified as HYPOTHESIS (never FACT).
 * 4. Policy enforcement (ASM-003):
 *    - Owner-approved audience limit is strictly required. If missing or undefined,
 *      the operation fails closed with ASM_003_UNAVAILABLE.
 *    - Undocumented/spec defaults (e.g. 5000, 50000) are never used.
 * 5. Determinism:
 *    - Given the same inputs, candidate order is deterministic (sorted by customer_id).
 *    - Caller-supplied or deterministic segment IDs are preserved.
 */

import {
  MarketingRuntimeError,
  type MarketingAudienceCandidate,
  type MarketingEvidence,
  type MarketingInvocationContext,
  type MarketingSegmentInput,
  type MarketingSignalInput,
  type MarketingSignalResearchResult,
  type MarketingTrendVelocity,
} from './contracts.js';

export interface MarketSignalOutput {
  readonly signals: readonly {
    readonly signal_id: string;
    readonly keyword: string;
    readonly search_volume_growth: number;
    readonly price_pressure_index: number;
  }[];
  readonly trend_velocity: MarketingTrendVelocity;
  readonly analyzed_at: string;
}

export interface ComposeMarketSignalResult {
  readonly output: MarketSignalOutput;
  readonly evidence: readonly MarketingEvidence[];
}

export interface AudienceSegmentOutput {
  readonly segment_id: string;
  readonly matched_customer_count: number;
  readonly customer_ids: readonly string[];
  readonly generated_at: string;
}

export interface ComposeAudienceSegmentResult {
  readonly output: AudienceSegmentOutput;
  readonly evidence: readonly MarketingEvidence[];
}

const VALID_TREND_VELOCITIES: Record<MarketingTrendVelocity, true> = {
  SLOW: true,
  STABLE: true,
  RAPID: true,
  EXPLOSIVE: true,
};

const VALID_REGIONS: Record<string, true> = {
  TW: true,
  GLOBAL_US: true,
  GLOBAL_EU: true,
  VN: true,
};

/**
 * Validates tenant consistency and bounds for MKT-01 signal input.
 */
export function validateMarketSignalInput(
  input: MarketingSignalInput,
  context: MarketingInvocationContext,
): void {
  if (input.tenant_id !== context.tenant_id) {
    throw new MarketingRuntimeError(
      'TENANT_MISMATCH',
      `Input tenant_id '${input.tenant_id}' does not match context tenant_id '${context.tenant_id}'`,
    );
  }
  if (!VALID_REGIONS[input.market_region]) {
    throw new MarketingRuntimeError(
      'INVALID_REGION',
      `Market region '${input.market_region}' is not authorized`,
    );
  }
  if (
    typeof input.observation_window_days !== 'number' ||
    input.observation_window_days < 1 ||
    input.observation_window_days > 90
  ) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      `observation_window_days must be between 1 and 90, got ${input.observation_window_days}`,
    );
  }
}

/**
 * Validates and composes MKT-01 market signal analysis output and evidence.
 *
 * Distinguishes source-backed observations as 'SIGNAL' and the aggregate trend velocity
 * as 'HYPOTHESIS'. Does not invent thresholds or defaults.
 */
export function composeMarketSignal(
  input: MarketingSignalInput,
  result: MarketingSignalResearchResult,
  context: MarketingInvocationContext,
  effect_key: string,
  now?: () => Date,
  newId?: () => string,
): ComposeMarketSignalResult {
  validateMarketSignalInput(input, context);

  if (!VALID_TREND_VELOCITIES[result.trend_velocity]) {
    throw new MarketingRuntimeError(
      'INVALID_TREND_VELOCITY',
      `Invalid trend_velocity '${result.trend_velocity}' provided by signal source`,
    );
  }

  // Cross-tenant verification: no observation may belong to another tenant
  for (const obs of result.signals) {
    if (obs.tenant_id !== context.tenant_id) {
      throw new MarketingRuntimeError(
        'CROSS_TENANT_SIGNAL',
        `Signal observation '${obs.signal_id}' belongs to tenant '${obs.tenant_id}', expected '${context.tenant_id}'`,
      );
    }
  }

  const generateId = newId ?? (() => `ev-sig-${Math.random().toString(36).slice(2, 10)}`);
  const timestamp = now ? now().toISOString() : new Date().toISOString();

  const evidenceList: MarketingEvidence[] = [];

  // 1. Each raw observation is classified as SIGNAL
  for (const obs of result.signals) {
    evidenceList.push({
      evidence_id: generateId(),
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      classification: 'SIGNAL',
      source_uri: obs.source_uri || result.source_uri,
      source_version: obs.source_version || result.source_version,
      claim: `Signal observation for keyword '${obs.keyword}': search_volume_growth=${obs.search_volume_growth}, price_pressure_index=${obs.price_pressure_index}`,
    });
  }

  // 2. Trend velocity interpretation is classified as HYPOTHESIS
  evidenceList.push({
    evidence_id: generateId(),
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    correlation_id: context.correlation_id,
    effect_key,
    classification: 'HYPOTHESIS',
    source_uri: result.source_uri,
    source_version: result.source_version,
    claim: `Market trend hypothesis: ${result.trend_velocity} velocity derived for category '${input.category_id}' in region '${input.market_region}' over ${input.observation_window_days}-day window`,
  });

  const output: MarketSignalOutput = {
    signals: result.signals.map((s) => ({
      signal_id: s.signal_id,
      keyword: s.keyword,
      search_volume_growth: s.search_volume_growth,
      price_pressure_index: s.price_pressure_index,
    })),
    trend_velocity: result.trend_velocity,
    analyzed_at: timestamp,
  };

  return {
    output,
    evidence: Object.freeze(evidenceList),
  };
}

/**
 * Validates tenant consistency for MKT-02 audience segment input.
 */
export function validateAudienceSegmentInput(
  input: MarketingSegmentInput,
  context: MarketingInvocationContext,
): void {
  if (input.tenant_id !== context.tenant_id) {
    throw new MarketingRuntimeError(
      'TENANT_MISMATCH',
      `Input tenant_id '${input.tenant_id}' does not match context tenant_id '${context.tenant_id}'`,
    );
  }
  if (typeof input.min_days_inactive !== 'number' || input.min_days_inactive < 0) {
    throw new MarketingRuntimeError(
      'SCHEMA_VALIDATION_ERROR',
      `min_days_inactive must be non-negative, got ${input.min_days_inactive}`,
    );
  }
}

function resolveSegmentId(
  segmentId: string | undefined,
  input: MarketingSegmentInput,
  context: MarketingInvocationContext,
  effect_key: string,
): string {
  if (segmentId) {
    return segmentId;
  }
  if ('segment_id' in input && typeof input.segment_id === 'string' && input.segment_id) {
    return input.segment_id;
  }
  return `seg-${context.tenant_id}-${input.rfm_criteria.toLowerCase()}-${effect_key.slice(0, 8)}`;
}

/**
 * Validates and composes MKT-02 audience segment output and evidence.
 *
 * Invariants:
 * - Every candidate must match context.tenant_id; any cross-tenant ID triggers CROSS_TENANT_AUDIENCE_LEAKAGE.
 * - Inferred segment membership is classified as HYPOTHESIS (never FACT).
 * - approvedLimit (ASM-003) is strictly required; missing/undefined/unapproved limit throws ASM_003_UNAVAILABLE.
 * - Does not use default numbers (e.g. 5000 or 50000).
 * - Deterministic sorting by customer_id.
 */
export function composeAudienceSegment(
  input: MarketingSegmentInput,
  candidates: readonly MarketingAudienceCandidate[],
  approvedLimit: number | undefined | null,
  context: MarketingInvocationContext,
  effect_key: string,
  now?: () => Date,
  newId?: () => string,
  segmentId?: string,
): ComposeAudienceSegmentResult {
  validateAudienceSegmentInput(input, context);

  // ASM-003 policy check: owner-approved audience limit is mandatory
  if (
    approvedLimit === undefined ||
    approvedLimit === null ||
    typeof approvedLimit !== 'number' ||
    Number.isNaN(approvedLimit) ||
    approvedLimit < 0
  ) {
    throw new MarketingRuntimeError(
      'ASM_003_UNAVAILABLE',
      'Owner-approved audience limit (ASM-003) is unapproved or unavailable; refusing unconfirmed default',
    );
  }

  // Cross-tenant verification for every candidate row
  for (const candidate of candidates) {
    if (candidate.tenant_id !== context.tenant_id) {
      throw new MarketingRuntimeError(
        'CROSS_TENANT_AUDIENCE_LEAKAGE',
        `Audience candidate '${candidate.customer_id}' belongs to tenant '${candidate.tenant_id}', expected '${context.tenant_id}'`,
      );
    }
  }

  // Deterministic deduplication and sorting by customer_id
  const uniqueCandidateMap = new Map<string, MarketingAudienceCandidate>();
  for (const candidate of candidates) {
    if (!uniqueCandidateMap.has(candidate.customer_id)) {
      uniqueCandidateMap.set(candidate.customer_id, candidate);
    }
  }

  const sortedCandidates = Array.from(uniqueCandidateMap.values()).sort((a, b) =>
    a.customer_id.localeCompare(b.customer_id),
  );

  // Cap determination: strictly bounded by approvedLimit; if caller supplied max_segment_size,
  // effective cap is min(max_segment_size, approvedLimit). Never default to 5000 or 50000.
  const effectiveCap =
    input.max_segment_size !== undefined && input.max_segment_size >= 0
      ? Math.min(input.max_segment_size, approvedLimit)
      : approvedLimit;

  const selectedCandidates = sortedCandidates.slice(0, effectiveCap);
  const selectedCustomerIds = selectedCandidates.map((c) => c.customer_id);

  const generateId = newId ?? (() => `ev-seg-${Math.random().toString(36).slice(2, 10)}`);
  const timestamp = now ? now().toISOString() : new Date().toISOString();
  const finalSegmentId = resolveSegmentId(segmentId, input, context, effect_key);

  const evidenceList: MarketingEvidence[] = [];

  // 1. Overall segment cohort hypothesis evidence
  evidenceList.push({
    evidence_id: generateId(),
    tenant_id: context.tenant_id,
    run_id: context.run_id,
    correlation_id: context.correlation_id,
    effect_key,
    classification: 'HYPOTHESIS', // Inferred cohort is HYPOTHESIS, not FACT
    source_uri: 'policy://marketing/segmentation/rfm-criteria',
    source_version: 'v1',
    claim: `Audience segment cohort hypothesis for RFM criteria '${input.rfm_criteria}' with min_days_inactive=${input.min_days_inactive}; capped by ASM-003 limit=${approvedLimit}; matched ${selectedCustomerIds.length} candidate(s)`,
  });

  // 2. Individual candidate membership hypothesis evidence
  for (const candidate of selectedCandidates) {
    evidenceList.push({
      evidence_id: generateId(),
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      effect_key,
      classification: 'HYPOTHESIS', // Inferred individual membership is HYPOTHESIS, not FACT
      source_uri: candidate.source_uri,
      source_version: candidate.source_version,
      claim: `Inferred segment membership hypothesis for customer '${candidate.customer_id}' under criteria '${input.rfm_criteria}': ${candidate.match_reason}`,
    });
  }

  const output: AudienceSegmentOutput = {
    segment_id: finalSegmentId,
    matched_customer_count: selectedCustomerIds.length,
    customer_ids: selectedCustomerIds,
    generated_at: timestamp,
  };

  return {
    output,
    evidence: Object.freeze(evidenceList),
  };
}

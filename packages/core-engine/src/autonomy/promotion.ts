import { checkPromotionEligibility, isDraftGatedSkill } from './eligibility.js';
import type { AutonomyPolicyRecord, AutonomyPromotionRequest } from './types.js';

/**
 * Server-computed evidence window for a draft-gated skill. Every field is derived from durable
 * run stage results and audit records by the caller; callers never supply their own pass/fail.
 */
export interface AutonomyEvidenceWindow {
  readonly window_ref: string;
  readonly authority_violations: number;
  readonly duplicate_effects: number;
  readonly audit_complete: boolean;
  readonly evidence_complete: boolean;
  readonly cost?: { readonly amount: number; readonly currency: string } | null;
  readonly cost_provenance_ref?: string;
  readonly latency_ms?: number | null;
  readonly latency_provenance_ref?: string;
}

/** A company operator asking to promote one draft-gated skill to an autonomous authority. */
export interface AutonomyPromotionRequestInput {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly required_authority: string;
  readonly requester_id: string;
  /** Present only once a second, distinct operator approves under governance. */
  readonly approver_id?: string;
  /** Tenant governance setting `require_distinct_approver`. */
  readonly require_distinct_approver?: boolean;
  /** Policy revision the requester read, for compare-and-set. */
  readonly expected_revision?: number;
  readonly evidence_window: AutonomyEvidenceWindow;
  readonly reason?: string;
}

export type AutonomyPromotionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONFLICT';

export interface AutonomyPromotionDecision {
  readonly status: AutonomyPromotionStatus;
  readonly eligible: boolean;
  readonly code: string;
  readonly reason: string;
  /** Normalized request handed to the durable store; `approver_id` is the effective approver. */
  readonly request: AutonomyPromotionRequest;
  readonly approved_by?: string;
  readonly expected_revision?: number;
}

function windowToRequest(
  input: AutonomyPromotionRequestInput,
  approver_id: string,
): AutonomyPromotionRequest {
  const window = input.evidence_window;
  return {
    tenant_id: input.tenant_id.trim(),
    skill_id: input.skill_id.trim(),
    policy_version: input.policy_version.trim(),
    required_authority: input.required_authority.trim(),
    approver_id,
    evidence_window_ref: window.window_ref,
    authority_violations: window.authority_violations,
    duplicate_effects: window.duplicate_effects,
    audit_complete: window.audit_complete,
    evidence_complete: window.evidence_complete,
    ...(window.cost === undefined || window.cost === null ? {} : { cost: window.cost }),
    ...(window.cost_provenance_ref === undefined ? {} : { cost_provenance_ref: window.cost_provenance_ref }),
    ...(window.latency_ms === undefined || window.latency_ms === null ? {} : { latency: window.latency_ms }),
    ...(window.latency_provenance_ref === undefined
      ? {}
      : { latency_provenance_ref: window.latency_provenance_ref }),
    reason: input.reason?.trim() || `Promotion requested by ${input.requester_id.trim()}.`,
  };
}

/**
 * Decides a promotion request without touching persistence. Draft-gated skills require an
 * evidence window; a second, distinct approver is required when tenant governance demands it.
 * Callers persist an APPROVED decision with `expected_revision` so a concurrent write surfaces
 * as a CAS conflict (HTTP 409) instead of a silent last-write-wins.
 */
export function evaluatePromotionRequest(input: AutonomyPromotionRequestInput): AutonomyPromotionDecision {
  const requester = input.requester_id?.trim() ?? '';
  if (requester.length === 0) {
    return {
      status: 'REJECTED',
      eligible: false,
      code: 'REQUESTER_REQUIRED',
      reason: 'NOT_ELIGIBLE: requester_id is required.',
      request: windowToRequest(input, ''),
    };
  }
  if (!isDraftGatedSkill(input.skill_id)) {
    // Only draft-gated skills need explicit promotion; other READ skills execute at MINIMUM.
    return {
      status: 'REJECTED',
      eligible: false,
      code: 'SKILL_NOT_DRAFT_GATED',
      reason: `NOT_ELIGIBLE: ${input.skill_id} does not require promotion.`,
      request: windowToRequest(input, requester),
    };
  }

  const approver = input.approver_id?.trim() ?? '';
  const request = windowToRequest(input, approver.length === 0 ? requester : approver);
  const eligibility = checkPromotionEligibility(request);
  const base = {
    request,
    ...(input.expected_revision === undefined ? {} : { expected_revision: input.expected_revision }),
  };

  if (!eligibility.eligible) {
    return { ...base, status: 'REJECTED', eligible: false, code: eligibility.code, reason: eligibility.reason };
  }
  if (input.require_distinct_approver === true) {
    if (approver.length === 0) {
      return {
        ...base,
        status: 'PENDING',
        eligible: false,
        code: 'DISTINCT_APPROVER_REQUIRED',
        reason: 'PENDING: a second, distinct operator must approve this promotion.',
      };
    }
    if (approver === requester) {
      return {
        ...base,
        status: 'REJECTED',
        eligible: false,
        code: 'APPROVER_NOT_DISTINCT',
        reason: 'NOT_ELIGIBLE: the approver must differ from the requester.',
      };
    }
  }
  return {
    ...base,
    status: 'APPROVED',
    eligible: true,
    code: eligibility.code,
    reason: eligibility.reason,
    approved_by: request.approver_id ?? requester,
  };
}

/** True when a persisted policy row is a parked draft awaiting owner review. */
export function isParkedDraft(record: AutonomyPolicyRecord): boolean {
  return record.state === 'MINIMUM' && isDraftGatedSkill(record.skill_id);
}

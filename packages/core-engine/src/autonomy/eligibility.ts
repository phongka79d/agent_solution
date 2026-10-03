import { isAutonomousAuthority, isPromotableSkill } from './never-promotable.js';
import type { AutonomyPromotionRequest } from './types.js';

export type AutonomyEligibilityCode =
  | 'NOT_ELIGIBLE'
  | 'ELIGIBLE'
  | 'EVIDENCE_WINDOW_REQUIRED'
  | 'AUTHORITY_VIOLATION'
  | 'DUPLICATE_EFFECT'
  | 'AUDIT_GAP'
  | 'EVIDENCE_GAP'
  | 'APPROVER_REQUIRED'
  | 'POLICY_VERSION_REQUIRED'
  | 'SKILL_NOT_PROMOTABLE'
  | 'AUTHORITY_NOT_AUTONOMOUS'
  | 'LATENCY_COST_PROVENANCE_REQUIRED'

const DRAFT_GATED_SKILLS: Readonly<Record<string, true>> = {
  'skill.mkt.generate_content': true,
  'skill.mkt.segment_audience': true,
};

export function isDraftGatedSkill(skill_id: string): boolean {
  return Object.hasOwn(DRAFT_GATED_SKILLS, skill_id.trim());
}

export interface AutonomyEligibility {
  readonly eligible: boolean;
  readonly code: AutonomyEligibilityCode;
  readonly reason: string;
}

/**
 * Promotion admits only complete, server-supplied evidence. Prompt/model/caller assertion fields
 * are intentionally absent from this decision path; they are never a source of authority.
 */
export function checkPromotionEligibility(input: AutonomyPromotionRequest): AutonomyEligibility {
  const policyVersion = typeof input.policy_version === 'string' ? input.policy_version.trim() : '';
  if (policyVersion.length === 0) {
    return { eligible: false, code: 'POLICY_VERSION_REQUIRED', reason: 'NOT_ELIGIBLE: policy_version is required.' };
  }
  if (!isAutonomousAuthority(input.required_authority)) {
    return {
      eligible: false,
      code: 'AUTHORITY_NOT_AUTONOMOUS',
      reason: 'NOT_ELIGIBLE: only AUTH-0..AUTH-3 may be promoted.',
    };
  }
  if (!isPromotableSkill(input.skill_id, input.required_authority)) {
    return { eligible: false, code: 'SKILL_NOT_PROMOTABLE', reason: `NOT_ELIGIBLE: ${input.skill_id} is not promotable.` };
  }
  if (typeof input.evidence_window_ref !== 'string' || input.evidence_window_ref.trim().length === 0) {
    return { eligible: false, code: 'EVIDENCE_WINDOW_REQUIRED', reason: 'NOT_ELIGIBLE: evidence window is required.' };
  }
  if (input.authority_violations !== 0) {
    return { eligible: false, code: 'AUTHORITY_VIOLATION', reason: 'NOT_ELIGIBLE: authority_violations must equal zero.' };
  }
  if (input.duplicate_effects !== 0) {
    return { eligible: false, code: 'DUPLICATE_EFFECT', reason: 'NOT_ELIGIBLE: duplicate_effects must equal zero.' };
  }
  if (input.audit_complete !== true) {
    return { eligible: false, code: 'AUDIT_GAP', reason: 'NOT_ELIGIBLE: audit evidence is incomplete.' };
  }
  if (input.evidence_complete !== true) {
    return { eligible: false, code: 'EVIDENCE_GAP', reason: 'NOT_ELIGIBLE: evidence is incomplete.' };
  }
  if (typeof input.approver_id !== 'string' || input.approver_id.trim().length === 0) {
    return { eligible: false, code: 'APPROVER_REQUIRED', reason: 'NOT_ELIGIBLE: approver_id is required.' };
  }
  const parameters = input.parameters ?? {};
  const latency = input.latency ?? parameters['latency'] ?? parameters['latency_ms'];
  const cost = input.cost ?? parameters['cost'] ?? parameters['cost_amount'];
  const latencyRef = input.latency_provenance_ref
    ?? parameters['latency_provenance_ref']
    ?? parameters['latency_ref'];
  const costRef = input.cost_provenance_ref
    ?? parameters['cost_provenance_ref']
    ?? parameters['cost_ref'];
  if (latency !== undefined && latency !== 'UNAVAILABLE'
    && (typeof latencyRef !== 'string' || latencyRef.trim().length === 0)) {
    return { eligible: false, code: 'LATENCY_COST_PROVENANCE_REQUIRED', reason: 'NOT_ELIGIBLE: latency lacks provenance.' };
  }
  if (cost !== undefined && cost !== 'UNAVAILABLE'
    && (typeof costRef !== 'string' || costRef.trim().length === 0)) {
    return { eligible: false, code: 'LATENCY_COST_PROVENANCE_REQUIRED', reason: 'NOT_ELIGIBLE: cost lacks provenance.' };
  }
  return { eligible: true, code: 'ELIGIBLE', reason: 'ELIGIBLE: complete server policy evidence supports promotion.' };
}

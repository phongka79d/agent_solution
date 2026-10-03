import { describe, expect, it } from 'vitest';

import { evaluatePromotionRequest, type AutonomyPromotionRequestInput } from './promotion.js';

const WINDOW = {
  window_ref: 'run_stage_results:tenant-1:skill.mkt.generate_content:30d',
  authority_violations: 0,
  duplicate_effects: 0,
  audit_complete: true,
  evidence_complete: true,
} as const;

function input(overrides: Partial<AutonomyPromotionRequestInput> = {}): AutonomyPromotionRequestInput {
  return {
    tenant_id: 'tenant-1',
    skill_id: 'skill.mkt.generate_content',
    policy_version: 'v1',
    required_authority: 'AUTH-2',
    requester_id: 'operator-a',
    evidence_window: WINDOW,
    ...overrides,
  };
}

describe('evaluatePromotionRequest governance', () => {
  it('approves an eligible promotion when no distinct approver is required', () => {
    const decision = evaluatePromotionRequest(input({ expected_revision: 7 }));
    expect(decision.status).toBe('APPROVED');
    expect(decision.approved_by).toBe('operator-a');
    expect(decision.expected_revision).toBe(7);
  });

  it('stays PENDING until a second, distinct operator decides when required', () => {
    const decision = evaluatePromotionRequest(input({ require_distinct_approver: true }));
    expect(decision.status).toBe('PENDING');
    expect(decision.code).toBe('DISTINCT_APPROVER_REQUIRED');
  });

  it('refuses the requester approving their own request when a distinct approver is required', () => {
    const decision = evaluatePromotionRequest(input({
      require_distinct_approver: true,
      approver_id: 'operator-a',
    }));
    expect(decision.status).toBe('REJECTED');
    expect(decision.code).toBe('APPROVER_NOT_DISTINCT');
  });

  it('approves once a different operator supplies the decision', () => {
    const decision = evaluatePromotionRequest(input({
      require_distinct_approver: true,
      approver_id: 'operator-b',
    }));
    expect(decision.status).toBe('APPROVED');
    expect(decision.approved_by).toBe('operator-b');
  });
});

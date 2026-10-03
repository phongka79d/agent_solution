import type { AutonomyPolicyRecord, AutonomyPromotionRequestRecord } from '@agentos/database';
import { P5AutonomyRepository, TenantGovernanceRepository } from '@agentos/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createP5Ports } from './p5-ports.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-03T00:00:00.000Z';
const POLICY: AutonomyPolicyRecord = {
  tenant_id: TENANT,
  skill_id: 'skill.mkt.segment_audience',
  policy_version: 'MINIMUM',
  policy_id: POLICY_ID,
  state: 'MINIMUM',
  previous_approved_state: 'MINIMUM',
  evidence_window_ref: null,
  approver_id: null,
  reason: 'SAFE_MINIMUM',
  parameters: {},
  provenance: { source: 'SERVER_POLICY' },
  effective_at: NOW,
  rollback_policy_version: 'MINIMUM',
  rollback_state: 'MINIMUM',
  audit_ref: null,
  evidence_ref: null,
  policy_revision: 1,
};
const REQUEST: AutonomyPromotionRequestRecord = {
  request_id: '33333333-3333-4333-8333-333333333333',
  tenant_id: TENANT,
  skill_id: POLICY.skill_id,
  policy_version: POLICY.policy_version,
  required_authority: 'AUTH-1',
  requester_id: 'operator-a',
  approver_id: null,
  status: 'PENDING',
  code: 'DISTINCT_APPROVER_REQUIRED',
  reason: 'A distinct approver must approve.',
  evidence_window: {
    window_ref: 'stage-window-1',
    authority_violations: 0,
    duplicate_effects: 0,
    audit_complete: true,
    evidence_complete: true,
  },
  evidence_window_ref: 'stage-window-1',
  expected_revision: 1,
  policy_revision: null,
  created_at: NOW,
  decided_at: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P5 promotion policy identity', () => {
  it.each([
    { scenario: 'retains the provisioned policy UUID', current: POLICY },
    { scenario: 'generates a UUID when no policy exists', current: null },
  ])('$scenario when a distinct operator approves', async ({ current }) => {
    vi.spyOn(P5AutonomyRepository.prototype, 'getPromotionRequest').mockResolvedValue({
      ...REQUEST,
      expected_revision: current?.policy_revision ?? null,
    });
    vi.spyOn(TenantGovernanceRepository.prototype, 'get').mockResolvedValue({
      tenant_id: TENANT,
      require_distinct_approver: true,
      approval_expiry_hours: 24,
      takeover_lease_seconds: 300,
      version: 1,
      updated_at: NOW,
    });
    vi.spyOn(P5AutonomyRepository.prototype, 'get').mockResolvedValue(current);
    const commit = vi.spyOn(P5AutonomyRepository.prototype, 'commitPolicy').mockImplementation(async (input) => ({
      ...POLICY,
      policy_id: input.policy_id,
      state: input.state,
      policy_revision: (current?.policy_revision ?? 0) + 1,
    }));
    const close = vi.spyOn(P5AutonomyRepository.prototype, 'decidePromotionRequest').mockImplementation(async (input) => ({
      ...REQUEST,
      status: input.status,
      code: input.code,
      reason: input.reason,
      approver_id: input.approver_id,
      policy_revision: input.policy_revision,
      decided_at: input.decided_at,
    }));

    await createP5Ports().autonomyAdmin.decidePromotion({
      tenant_id: TENANT,
      operator_id: 'operator-b',
      request_id: REQUEST.request_id,
      decision: 'APPROVE',
      reason: 'Approve the audited segment step.',
    });

    const input = commit.mock.calls[0]?.[0];
    expect(input?.policy_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    if (current !== null) expect(input?.policy_id).toBe(POLICY_ID);
    expect(input?.expected_revision).toBe(current?.policy_revision);
    expect(input?.policy_event?.trigger).toBe('PROMOTION_APPROVED');
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      status: 'APPROVED',
      approver_id: 'operator-b',
      policy_revision: (current?.policy_revision ?? 0) + 1,
    }));
  });
});

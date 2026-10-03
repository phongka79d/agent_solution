import { describe, expect, it } from 'vitest';

import { checkPromotionEligibility } from './eligibility.js';
import { AutonomyService } from './service.js';
import { MemoryAutonomyStore } from './store.js';
import type { AutonomyPromotionRequest } from './types.js';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

function promotion(overrides: Partial<AutonomyPromotionRequest> = {}): AutonomyPromotionRequest {
  return {
    policy_version: 'v1',
    tenant_id: TENANT,
    skill_id: 'skill.sales.check_stock',
    required_authority: 'AUTH-0',
    evidence_window_ref: 'window-1',
    evidence_ref: 'evidence-1',
    audit_ref: 'audit-1',
    authority_violations: 0,
    duplicate_effects: 0,
    audit_complete: true,
    evidence_complete: true,
    approver_id: 'operator-1',
    reason: 'approved server policy',
    ...overrides,
  };
}

describe('AutonomyService', () => {
  it('promotes a valid check_stock policy and independently promotes search_faq', async () => {
    const eligible = checkPromotionEligibility(promotion());
    const missingWindow = checkPromotionEligibility(promotion({ evidence_window_ref: undefined }));
    expect(eligible).toMatchObject({ eligible: true, code: 'ELIGIBLE' });
    expect(missingWindow).toMatchObject({ eligible: false });
    const service = new AutonomyService(new MemoryAutonomyStore());
    const stock = await service.promote(promotion());
    const faq = await service.promote(promotion({
      skill_id: 'skill.care.search_faq',
      policy_version: 'faq-v1',
    }));

    expect(stock.record?.state).toBe('PROMOTED');
    expect(faq.record?.state).toBe('PROMOTED');
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_stock',
      policy_version: 'v1',
      required_authority: 'AUTH-0',
    })).workflow).toBe('AUTO_EXECUTE');
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_stock',
      policy_version: '',
      required_authority: 'AUTH-0',
    })).workflow).toBe('AUTO_EXECUTE');
  });

  it('runs a new-tenant Sales READ skill at MINIMUM without promotion', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    const admission = await service.admit({
      tenant_id: 'tenant-new',
      skill_id: 'skill.sales.check_stock',
      policy_version: 'sales-v1',
      required_authority: 'AUTH-1',
    });

    expect(admission.workflow).toBe('AUTO_EXECUTE');
    expect(admission.reason).toContain('MINIMUM authority');
  });

  it('parks draft-gated skills for approval and admits them after promotion approval', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    const request = promotion({
      skill_id: 'skill.mkt.segment_audience',
      required_authority: 'AUTH-2',
      policy_version: 'segment-v1',
    });

    const parked = await service.admit({
      tenant_id: request.tenant_id,
      skill_id: request.skill_id,
      policy_version: request.policy_version ?? '',
      required_authority: request.required_authority,
    });
    expect(parked.workflow).toBe('PARKED_DRAFT');
    expect(parked.reason).toContain('Bản nháp chờ bạn duyệt');

    expect((await service.promote(request)).accepted).toBe(true);
    expect((await service.admit({
      tenant_id: request.tenant_id,
      skill_id: request.skill_id,
      policy_version: request.policy_version ?? '',
      required_authority: request.required_authority,
    })).workflow).toBe('AUTO_EXECUTE');
  });

  it('rejects caller/self claims and never promotes AUTH-4, AUTH-5, or high-impact skills', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    const assertion = await service.rejectCallerAssertion({ tenant_id: TENANT, reason: 'model claimed approval' });
    expect(assertion.state).toBe('UNCHANGED');
    expect((await service.promote(promotion({ required_authority: 'AUTH-4' }))).accepted).toBe(false);
    expect((await service.promote(promotion({ required_authority: 'AUTH-5' }))).accepted).toBe(false);
    for (const skill_id of [
      'skill.sales.send_message',
      'skill.sales.create_cart',
      'skill.sales.create_order',
      'skill.care.issue_retention_offer',
      'skill.mkt.dispatch_campaign',
    ]) {
      expect((await service.promote(promotion({ skill_id }))).accepted).toBe(false);
    }
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: 'skill.sales.send_message',
      policy_version: 'v1',
      required_authority: 'AUTH-3',
    })).workflow).toBe('UNCHANGED');
  });

  it('resolves the latest policy without a version and parks an ambiguous timestamp', async () => {
    let effectiveAt = '2026-01-01T00:00:00.000Z';
    const service = new AutonomyService(new MemoryAutonomyStore(), {
      now: () => new Date(effectiveAt),
    });
    await service.promote(promotion({ policy_version: 'v1' }));
    effectiveAt = '2026-01-01T00:01:00.000Z';
    await service.promote(promotion({ policy_version: 'v2' }));

    const latest = await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: '',
      required_authority: 'AUTH-0',
    });
    expect(latest.workflow).toBe('AUTO_EXECUTE');
    expect(latest.record?.policy_version).toBe('v2');

    await service.promote(promotion({ policy_version: 'v3' }));
    const ambiguous = await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: '',
      required_authority: 'AUTH-0',
    });
    expect(ambiguous.workflow).toBe('PARKED_DRAFT');
  });


  it('pauses eligible autonomy and resumes only the prior promotion', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    await service.promote(promotion());
    await service.pauseTenant(TENANT);
    expect((await service.admit({ tenant_id: TENANT, skill_id: promotion().skill_id, policy_version: 'v1' })).workflow)
      .toBe('PARKED_DRAFT');
    await service.resumeTenant(TENANT);
    expect((await service.admit({ tenant_id: TENANT, skill_id: promotion().skill_id, policy_version: 'v1' })).workflow)
      .toBe('AUTO_EXECUTE');
  });
  it('kill switch demotes paused rows and refuses resume or promotion', async () => {
    const store = new MemoryAutonomyStore();
    const service = new AutonomyService(store);
    await service.promote(promotion());
    await service.pauseTenant(TENANT);

    const killed = await service.killSwitch(TENANT);
    expect(killed).toHaveLength(1);
    expect(killed[0]?.state).toBe('DEMOTED');
    expect(killed[0]?.parameters).toMatchObject({ trigger: 'OPERATOR_KILL_SWITCH' });
    expect(store.isKillSwitchSet(TENANT)).toBe(true);
    expect(store.isTenantPaused(TENANT)).toBe(true);

    await expect(service.resumeTenant(TENANT)).rejects.toThrow('NOT_ELIGIBLE: tenant kill switch is set.');
    const promoted = await service.promote(promotion({ policy_version: 'v2' }));
    expect(promoted.accepted).toBe(false);
    expect(promoted.reason).toBe('NOT_ELIGIBLE: tenant kill switch is set.');
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: 'v1',
    })).workflow).toBe('PARKED_DRAFT');
    expect((await service.inspect(TENANT)).current.every((record) => record.state !== 'PROMOTED')).toBe(true);
  });

  it('demotes on evidence drift, duplicate effects, and unknown safety triggers', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    await service.promote(promotion());
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: 'v1',
      evidence_complete: false,
    })).workflow).toBe('PARKED_DRAFT');
    expect((await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: 'v1',
      duplicate_effects: 1,
    })).workflow).toBe('PARKED_DRAFT');

    await service.promote(promotion({ policy_version: 'v2' }));
    const unknown = await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: 'v2',
      trigger: 'UNKNOWN',
    });
    expect(unknown.workflow).toBe('PARKED_DRAFT');
    await service.promote(promotion({ policy_version: 'v3' }));
    const drift = await service.admit({
      tenant_id: TENANT,
      skill_id: promotion().skill_id,
      policy_version: 'v3',
      policy_drift: true,
    });
    expect(drift.workflow).toBe('PARKED_DRAFT');
  });

  it('fails closed without evidence window, audit completeness, approver, or policy version', async () => {
    const cases: readonly Partial<AutonomyPromotionRequest>[] = [
      { evidence_window_ref: undefined },
      { audit_complete: undefined },
      { evidence_complete: undefined },
      { approver_id: undefined },
      { policy_version: undefined },
      { authority_violations: 1 },
      { duplicate_effects: 1 },
      { latency: 'qualified' },
      { cost: 100 },
    ];
    for (const overrides of cases) {
      const store = new MemoryAutonomyStore();
      const service = new AutonomyService(store);
      const result = await service.promote(promotion(overrides));
      expect(result.accepted).toBe(false);
      expect((await service.inspect(TENANT)).current).toHaveLength(0);
    }
    const service = new AutonomyService(new MemoryAutonomyStore());
    expect((await service.promote(promotion({ latency: 'UNAVAILABLE', cost: 'UNAVAILABLE' }))).accepted).toBe(true);
  });

  it('keeps autonomy rows tenant isolated', async () => {
    const service = new AutonomyService(new MemoryAutonomyStore());
    await service.promote(promotion({ tenant_id: TENANT }));
    await service.promote(promotion({ tenant_id: OTHER_TENANT }));
    const first = await service.inspect(TENANT);
    const second = await service.inspect(OTHER_TENANT);
    expect(first.current).toHaveLength(1);
    expect(second.current).toHaveLength(1);
    expect(first.current[0]?.tenant_id).toBe(TENANT);
    expect(second.current[0]?.tenant_id).toBe(OTHER_TENANT);
  });
});

/**
 * P5 disaster-recovery scenarios: durable effect reservations and tenant-scoped autonomy rows
 * survive worker/service reconstruction without retrying an uncertain external effect.
 */

import { describe, expect, it } from 'vitest';

import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import {
  AutonomyService,
  MemoryAutonomyStore,
  admit,
  demote,
  inspect,
  killSwitch,
  pauseTenant,
  promote,
  type AutonomyAdmission,
  type AutonomyAuditEvent,
  type AutonomyPromotionRequest,
} from '../autonomy/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SKILL = 'skill.sales.check_stock';
const POLICY_VERSION = 'p5-policy-v1';

type EffectReservationInput = Parameters<MemoryEffectGuard['reserve']>[0];
type ExternalConnector = { dispatch(payload: Record<string, unknown>): Promise<unknown> };

interface WorkflowState {
  status: 'queued' | 'completed';
  receipt?: unknown;
}

function promotionRequest(
  overrides: Partial<AutonomyPromotionRequest> = {},
): AutonomyPromotionRequest {
  return {
    policy_id: `${TENANT}:${SKILL}:${POLICY_VERSION}`,
    policy_version: POLICY_VERSION,
    tenant_id: TENANT,
    skill_id: SKILL,
    required_authority: 'AUTH-3',
    evidence_window_ref: 'evidence-window-p5-01',
    evidence_ref: 'evidence-p5-01',
    audit_ref: 'audit-p5-01',
    authority_violations: 0,
    duplicate_effects: 0,
    audit_complete: true,
    evidence_complete: true,
    approver_id: 'operator-p5',
    reason: 'Signed low-risk P5 qualification.',
    ...overrides,
  };
}

function admissionRequest(
  overrides: Partial<Parameters<typeof admit>[1]> = {},
): Parameters<typeof admit>[1] {
  return {
    tenant_id: TENANT,
    skill_id: SKILL,
    policy_version: POLICY_VERSION,
    required_authority: 'AUTH-3',
    ...overrides,
  };
}

function auditService(
  store: MemoryAutonomyStore,
  audit: AutonomyAuditEvent[],
): AutonomyService {
  return new AutonomyService(store, {
    audit: {
      append(event): void {
        audit.push(event);
      },
    },
  });
}

function reservationInput(
  guard: MemoryEffectGuard,
  overrides: Partial<EffectReservationInput> = {},
): EffectReservationInput {
  const identity = {
    tenant_id: overrides.tenant_id ?? TENANT,
    skill_id: overrides.skill_id ?? SKILL,
    step_index: overrides.step_index ?? 0,
    action_revision: overrides.action_revision ?? 1,
    request_id: overrides.request_id ?? 'signal-p5-01',
  } as const;
  return {
    ...identity,
    run_id: overrides.run_id ?? 'run-p5-01',
    effect_key: overrides.effect_key ?? guard.computeEffectKey(identity),
    request_fingerprint: overrides.request_fingerprint
      ?? guard.computeRequestFingerprint({ sku: 'SKU-001', action: 'stock-read' }),
    ...overrides,
  };
}

async function dispatchIfBound(
  admission: AutonomyAdmission,
  connector: ExternalConnector | undefined,
): Promise<{ dispatched: boolean; workflow: 'AUTO_EXECUTE' | 'PARKED_DRAFT' | 'UNCHANGED'; reason: string }> {
  if (admission.workflow !== 'AUTO_EXECUTE') {
    return { dispatched: false, workflow: admission.workflow, reason: admission.reason };
  }
  if (connector === undefined) {
    return {
      dispatched: false,
      workflow: 'PARKED_DRAFT',
      reason: 'PARKED_DRAFT: connector is not bound.',
    };
  }
  await connector.dispatch({ sku: 'SKU-001' });
  return { dispatched: true, workflow: 'AUTO_EXECUTE', reason: 'External effect dispatched.' };
}

describe('P5 disaster recovery', () => {
  it('does not dispatch again when a worker dies after reservation and before its receipt', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard);
    let externalEffects = 0;

    expect((await guard.reserve(input)).kind).toBe('RESERVED');
    externalEffects += 1;
    // The worker dies after the provider may have accepted the effect; no receipt is settled.

    const retry = await guard.reserve({ ...input, run_id: 'run-p5-restarted' });

    expect(retry.kind).toBe('IN_FLIGHT');
    expect(externalEffects).toBe(1);
    expect(guard.peek(TENANT, input.effect_key)?.status).toBe('RESERVED');
  });

  it('keeps a provider timeout UNKNOWN and only settles after explicit reconciliation input', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard, { request_id: 'signal-p5-timeout' });
    let attempts = 0;
    let outcome: 'UNKNOWN' | 'SUCCESS' = 'UNKNOWN';

    expect((await guard.reserve(input)).kind).toBe('RESERVED');
    attempts += 1;
    try {
      throw new Error('provider timeout');
    } catch {
      // A timeout is not a provider-confirmed failure or success.
      outcome = 'UNKNOWN';
    }

    const beforeReconciliation = await guard.reconcile({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      skill_id: SKILL,
    });

    expect(attempts).toBe(1);
    expect(outcome).toBe('UNKNOWN');
    expect(outcome).not.toBe('SUCCESS');
    expect(beforeReconciliation).toEqual({ outcome: 'INDETERMINATE' });
    expect(guard.peek(TENANT, input.effect_key)?.status).toBe('RESERVED');

    await guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: { provider_id: 'receipt-after-explicit-reconciliation' },
    });
    const afterReconciliation = await guard.reconcile({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      skill_id: SKILL,
    });

    expect(afterReconciliation).toEqual({
      outcome: 'SUCCEEDED',
      receipt: { provider_id: 'receipt-after-explicit-reconciliation' },
    });
  });

  it('restarts against durable reservation and autonomy rows rather than fresh in-memory success', async () => {
    const guard = new MemoryEffectGuard();
    const store = new MemoryAutonomyStore();
    const audit: AutonomyAuditEvent[] = [];
    const serviceBeforeRestart = auditService(store, audit);
    const input = reservationInput(guard, { request_id: 'signal-p5-restart' });
    let externalEffects = 0;

    expect((await promote(serviceBeforeRestart, promotionRequest())).accepted).toBe(true);
    expect((await guard.reserve(input)).kind).toBe('RESERVED');
    externalEffects += 1;
    await guard.resolve({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      status: 'SUCCEEDED',
      receipt: { provider_id: 'receipt-durable' },
    });

    // Worker/service objects are reconstructed, but the injected durable doubles are retained.
    const serviceAfterRestart = auditService(store, audit);
    const autonomyRow = await store.getCurrent({
      tenant_id: TENANT,
      skill_id: SKILL,
      policy_version: POLICY_VERSION,
    });
    const admission = await admit(serviceAfterRestart, admissionRequest());
    const replay = await guard.reserve({ ...input, run_id: 'run-p5-after-restart' });

    expect(autonomyRow?.state).toBe('PROMOTED');
    expect(admission.workflow).toBe('AUTO_EXECUTE');
    expect(replay).toEqual({ kind: 'REPLAY', receipt: { provider_id: 'receipt-durable' } });
    expect(externalEffects).toBe(1);
    expect(audit.some((event) => event.event === 'PROMOTED' && event.record?.evidence_window_ref === 'evidence-window-p5-01')).toBe(true);
  });

  it('does not double-effect when a queued workflow is replayed after restart', async () => {
    const guard = new MemoryEffectGuard();
    const input = reservationInput(guard, { request_id: 'signal-p5-queued' });
    const workflow: WorkflowState = { status: 'queued' };
    let externalEffects = 0;

    const runWorker = async (run_id: string): Promise<void> => {
      const reservation = await guard.reserve({ ...input, run_id });
      if (reservation.kind === 'REPLAY') {
        workflow.status = 'completed';
        workflow.receipt = reservation.receipt;
        return;
      }
      if (reservation.kind !== 'RESERVED') return;
      externalEffects += 1;
      const receipt = { provider_id: 'queued-receipt' };
      await guard.resolve({
        tenant_id: TENANT,
        effect_key: input.effect_key,
        status: 'SUCCEEDED',
        receipt,
      });
      workflow.status = 'completed';
      workflow.receipt = receipt;
    };

    await runWorker('run-p5-queued-1');
    workflow.status = 'queued';
    await runWorker('run-p5-queued-restarted');

    expect(workflow).toEqual({ status: 'completed', receipt: { provider_id: 'queued-receipt' } });
    expect(externalEffects).toBe(1);
  });

  it('parks the next admit when a promoted skill is demoted during an in-flight attempt', async () => {
    const store = new MemoryAutonomyStore();
    const audit: AutonomyAuditEvent[] = [];
    const service = auditService(store, audit);

    expect((await promote(service, promotionRequest())).accepted).toBe(true);
    const inFlight = await admit(service, admissionRequest());
    expect(inFlight.workflow).toBe('AUTO_EXECUTE');

    const demotion = await demote(service, {
      tenant_id: TENANT,
      skill_id: SKILL,
      policy_version: POLICY_VERSION,
      trigger: 'PROVIDER_AMBIGUITY',
      reason: 'Provider timed out while the autonomous effect was in flight.',
      audit_ref: 'audit-p5-provider-ambiguity',
      evidence_ref: 'evidence-p5-provider-ambiguity',
    });
    const next = await admit(service, admissionRequest());
    const attemptedUpgrade = await admit(service, admissionRequest({ required_authority: 'AUTH-4' }));

    expect(demotion.record?.state).toBe('DEMOTED');
    expect(demotion.record?.parameters).toMatchObject({ trigger: 'PROVIDER_AMBIGUITY' });
    expect(next.workflow).toBe('PARKED_DRAFT');
    expect(next.workflow).not.toBe('AUTO_EXECUTE');
    expect(attemptedUpgrade.workflow).toBe('UNCHANGED');
    expect(audit.some((event) => event.event === 'DEMOTED' && event.reason.includes('Provider timed out'))).toBe(true);
    expect(audit.some((event) => event.record?.parameters.trigger === 'PROVIDER_AMBIGUITY')).toBe(true);
  });

  it('fails closed when an autonomous admission has no bound connector', async () => {
    const store = new MemoryAutonomyStore();
    const audit: AutonomyAuditEvent[] = [];
    const service = auditService(store, audit);
    let externalEffects = 0;

    expect((await promote(service, promotionRequest())).accepted).toBe(true);
    const admission = await admit(service, admissionRequest());
    const connector: ExternalConnector | undefined = undefined;
    const dispatch = await dispatchIfBound(admission, connector);
    if (dispatch.dispatched) externalEffects += 1;

    expect(admission.workflow).toBe('AUTO_EXECUTE');
    expect(dispatch.workflow).toBe('PARKED_DRAFT');
    expect(dispatch.dispatched).toBe(false);
    expect(externalEffects).toBe(0);
  });

  it('operator kill switch demotes, pauses, and blocks the next autonomous admit', async () => {
    const store = new MemoryAutonomyStore();
    const audit: AutonomyAuditEvent[] = [];
    const service = auditService(store, audit);

    expect((await promote(service, promotionRequest())).accepted).toBe(true);
    expect((await admit(service, admissionRequest())).workflow).toBe('AUTO_EXECUTE');

    const demoted = await killSwitch(service, { tenant_id: TENANT, reason: 'Operator stopped autonomous execution.' });
    const next = await admit(service, admissionRequest());
    const inspection = await inspect(service, TENANT);

    expect(demoted).toHaveLength(1);
    expect(demoted[0]?.state).toBe('DEMOTED');
    expect(demoted[0]?.parameters).toMatchObject({ trigger: 'OPERATOR_KILL_SWITCH' });
    expect(next.workflow).toBe('PARKED_DRAFT');
    expect(inspection.paused).toBe(true);
    expect(inspection.current[0]?.state).toBe('DEMOTED');
    expect(audit.some((event) => event.event === 'KILL_SWITCH' && event.reason.includes('Operator stopped'))).toBe(true);
    expect(inspection.history.some((record) => record.parameters.trigger === 'OPERATOR_KILL_SWITCH')).toBe(true);
  });

  it('uses the tenant pause port without upgrading authority or creating a global promotion', async () => {
    const store = new MemoryAutonomyStore();
    const audit: AutonomyAuditEvent[] = [];
    const service = auditService(store, audit);

    expect((await promote(service, promotionRequest())).accepted).toBe(true);
    const paused = await pauseTenant(service, { tenant_id: TENANT, reason: 'Operator pause.' });
    const parked = await admit(service, admissionRequest());
    const otherTenant = await admit(service, admissionRequest({ tenant_id: OTHER_TENANT }));

    expect(paused[0]?.state).toBe('PAUSED');
    expect(parked.workflow).toBe('PARKED_DRAFT');
    // The pause is tenant-scoped: another tenant is neither paused nor globally promoted. It keeps
    // running the READ skill at MINIMUM baseline authority (D2), not via TENANT's promotion.
    const otherInspection = await inspect(service, OTHER_TENANT);
    expect(otherInspection.paused).toBe(false);
    expect(otherInspection.current).toHaveLength(0);
    expect(otherTenant.workflow).toBe('AUTO_EXECUTE');
    expect(otherTenant.reason).toContain('MINIMUM authority');
    expect(audit.some((event) => event.event === 'PAUSED' && event.reason.includes('Operator pause'))).toBe(true);
  });
});

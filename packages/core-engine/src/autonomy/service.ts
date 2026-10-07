import { checkPromotionEligibility } from './eligibility.js';
import { isAutonomousAuthority, isNeverPromotableSkill } from './never-promotable.js';
import type {
  AutonomyAdmission,
  AutonomyAdmissionPort,
  AutonomyAdmissionRequest,
  AutonomyApprovedState,
  AutonomyAssertionRejection,
  AutonomyAuditEvent,
  AutonomyAuditPort,
  AutonomyDemotionRequest,
  AutonomyInspection,
  AutonomyOperationResult,
  AutonomyPolicyRecord,
  AutonomyPromotionRequest,
  AutonomyStore,
  AutonomyTrigger,
} from './types.js';

const TRIGGERS: ReadonlySet<string> = new Set([
  'AUTHORITY_POLICY_VIOLATION',
  'DUPLICATE_EFFECT',
  'PROVIDER_AMBIGUITY',
  'EVIDENCE_GAP',
  'AUDIT_GAP',
  'POLICY_DRIFT',
  'OPERATOR_PAUSE',
  'OPERATOR_KILL_SWITCH',
  'FAILED_SAFETY_INVARIANT',
  'OPERATOR_DEMOTE',
]);

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function compareEffectiveAt(left: string, right: string): number {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) return leftMillis - rightMillis;
  return left === right ? 0 : left > right ? 1 : -1;
}

function scopedInput(tenant_id: string, skill_id: string, policy_version: string): {
  tenant_id: string;
  skill_id: string;
  policy_version: string;
} {
  return { tenant_id: tenant_id.trim(), skill_id: skill_id.trim(), policy_version: policy_version.trim() };
}

function normalizedTrigger(value: string | undefined): AutonomyTrigger | undefined {
  if (value !== undefined && TRIGGERS.has(value)) return value as AutonomyTrigger;
  return value === undefined ? undefined : 'FAILED_SAFETY_INVARIANT';
}

function operationFailure(reason: string): AutonomyOperationResult {
  return { accepted: false, eligible: false, reason };
}

export interface AutonomyServiceOptions {
  readonly now?: () => Date;
  readonly audit?: AutonomyAuditPort;
}

export interface TenantAutonomyRequest {
  readonly tenant_id: string;
  readonly reason?: string;
  readonly audit_ref?: string;
  readonly actor?: string;
}

/** Durable admission service. Every admission reads the injected store; no process cache is consulted. */
export class AutonomyService implements AutonomyAdmissionPort {
  private readonly now: () => Date;
  private readonly audit: AutonomyAuditPort | undefined;

  constructor(private readonly store: AutonomyStore, options: AutonomyServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit;
  }

  async promote(request: AutonomyPromotionRequest): Promise<AutonomyOperationResult> {
    const input = {
      ...request,
      tenant_id: request.tenant_id.trim(),
      skill_id: request.skill_id.trim(),
      policy_version: request.policy_version?.trim() ?? '',
      required_authority: request.required_authority.trim(),
      approver_id: request.approver_id?.trim() ?? '',
      evidence_window_ref: request.evidence_window_ref?.trim(),
      audit_ref: request.audit_ref?.trim(),
      evidence_ref: request.evidence_ref?.trim(),
    };
    const eligibility = checkPromotionEligibility(request);
    if (!eligibility.eligible) return operationFailure(eligibility.reason);
    if (await this.store.isKillSwitchSet(input.tenant_id)) {
      return operationFailure('NOT_ELIGIBLE: tenant kill switch is set.');
    }
    if (await this.store.isTenantPaused(input.tenant_id)) {
      return operationFailure('NOT_ELIGIBLE: tenant autonomy is paused.');
    }

    const current = await this.store.getCurrent(input);
    const previous: AutonomyApprovedState = current?.state === 'PROMOTED'
      ? 'PROMOTED'
      : current?.previous_approved_state ?? 'MINIMUM';
    const record: AutonomyPolicyRecord = {
      policy_id: request.policy_id?.trim() || `${input.tenant_id}:${input.skill_id}:${input.policy_version}`,
      policy_version: input.policy_version,
      tenant_id: input.tenant_id,
      skill_id: input.skill_id,
      state: 'PROMOTED',
      previous_approved_state: previous,
      evidence_window_ref: input.evidence_window_ref ?? null,
      approver_id: input.approver_id,
      reason: request.reason?.trim() || 'Server-approved autonomy promotion.',
      parameters: { ...(request.parameters ?? {}), required_authority: input.required_authority },
      provenance: { source: 'SERVER_POLICY' },
      effective_at: nowIso(this.now),
      rollback: current?.rollback ?? { policy_version: input.policy_version, state: 'MINIMUM' },
      audit_ref: input.audit_ref ?? null,
      evidence_ref: input.evidence_ref ?? null,
    };
    await this.store.put(record);
    await this.appendAudit({
      tenant_id: record.tenant_id,
      skill_id: record.skill_id,
      policy_version: record.policy_version,
      event: 'PROMOTED',
      reason: record.reason,
      occurred_at: record.effective_at,
      actor: request.approver_id,
      record,
    });
    return { accepted: true, eligible: true, reason: eligibility.reason, record };
  }

  async demote(request: AutonomyDemotionRequest): Promise<AutonomyOperationResult> {
    const input = scopedInput(request.tenant_id, request.skill_id, request.policy_version);
    const current = await this.store.getCurrent(input);
    if (current === undefined) return operationFailure('UNCHANGED: no autonomy row exists.');
    const trigger = normalizedTrigger(request.trigger) ?? 'FAILED_SAFETY_INVARIANT';
    const record: AutonomyPolicyRecord = {
      ...current,
      state: 'DEMOTED',
      previous_approved_state: current.state === 'PROMOTED' ? 'PROMOTED' : current.previous_approved_state,
      reason: request.reason?.trim() || `Autonomy demoted by ${trigger}.`,
      parameters: { ...current.parameters, ...(request.parameters ?? {}), trigger },
      effective_at: nowIso(this.now),
      audit_ref: request.audit_ref?.trim() || current.audit_ref,
      evidence_ref: request.evidence_ref?.trim() || current.evidence_ref,
    };
    await this.store.put(record);
    await this.appendAudit({
      tenant_id: record.tenant_id,
      skill_id: record.skill_id,
      policy_version: record.policy_version,
      event: 'DEMOTED',
      reason: record.reason,
      occurred_at: record.effective_at,
      actor: request.actor ?? `system:${trigger}`,
      record,
    });
    return { accepted: true, eligible: false, reason: record.reason, record };
  }

  async pauseTenant(input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
    const request = typeof input === 'string' ? { tenant_id: input } : input;
    const tenant_id = request.tenant_id.trim();
    await this.store.setTenantPaused(tenant_id, true);
    const rows = await this.store.listCurrent(tenant_id);
    const paused: AutonomyPolicyRecord[] = [];
    for (const current of rows) {
      if (current.state !== 'PROMOTED') continue;
      const record: AutonomyPolicyRecord = {
        ...current,
        state: 'PAUSED',
        previous_approved_state: 'PROMOTED',
        reason: request.reason?.trim() || 'Tenant autonomy paused by operator.',
        parameters: { ...current.parameters, trigger: 'OPERATOR_PAUSE' },
        effective_at: nowIso(this.now),
        audit_ref: request.audit_ref?.trim() || current.audit_ref,
      };
      await this.store.put(record);
      paused.push(record);
      await this.appendAudit({
        tenant_id,
        skill_id: record.skill_id,
        policy_version: record.policy_version,
        event: 'PAUSED',
        reason: record.reason,
        occurred_at: record.effective_at,
        actor: request.actor,
        record,
      });
    }
    return paused;
  }

  async resumeTenant(input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
    const request = typeof input === 'string' ? { tenant_id: input } : input;
    const tenant_id = request.tenant_id.trim();
    if (await this.store.isKillSwitchSet(tenant_id)) {
      throw new Error('NOT_ELIGIBLE: tenant kill switch is set.');
    }
    const rows = await this.store.listCurrent(tenant_id);
    await this.store.setTenantPaused(tenant_id, false);
    const resumed: AutonomyPolicyRecord[] = [];
    for (const current of rows) {
      if (current.state !== 'PAUSED' || current.previous_approved_state !== 'PROMOTED') continue;
      const record: AutonomyPolicyRecord = {
        ...current,
        state: 'PROMOTED',
        reason: request.reason?.trim() || 'Tenant autonomy resumed to the prior approved state.',
        parameters: { ...current.parameters, trigger: 'OPERATOR_PAUSE' },
        effective_at: nowIso(this.now),
        audit_ref: request.audit_ref?.trim() || current.audit_ref,
      };
      await this.store.put(record);
      resumed.push(record);
      await this.appendAudit({
        tenant_id,
        skill_id: record.skill_id,
        policy_version: record.policy_version,
        event: 'RESUMED',
        reason: record.reason,
        occurred_at: record.effective_at,
        actor: request.actor,
        record,
      });
    }
    return resumed;
  }

  async killSwitch(input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
    const request = typeof input === 'string' ? { tenant_id: input } : input;
    const tenant_id = request.tenant_id.trim();
    await this.store.setKillSwitch(tenant_id, true);
    const rows = await this.store.listCurrent(tenant_id);
    const demoted: AutonomyPolicyRecord[] = [];
    for (const current of rows) {
      if (current.state !== 'PROMOTED' && current.state !== 'PAUSED') continue;
      const result = await this.demote({
        tenant_id,
        skill_id: current.skill_id,
        policy_version: current.policy_version,
        trigger: 'OPERATOR_KILL_SWITCH',
        reason: request.reason?.trim() || 'Tenant autonomy killed by operator.',
        audit_ref: request.audit_ref,
        actor: request.actor,
      });
      if (result.record !== undefined) demoted.push(result.record);
    }
    await this.store.setTenantPaused(tenant_id, true);
    await this.appendAudit({
      tenant_id,
      event: 'KILL_SWITCH',
      reason: request.reason?.trim() || 'Tenant autonomy killed by operator.',
      actor: request.actor,
      occurred_at: nowIso(this.now),
    });
    return demoted;
  }

  async inspect(tenant_id: string): Promise<AutonomyInspection> {
    const scopedTenant = tenant_id.trim();
    return {
      tenant_id: scopedTenant,
      paused: await this.store.isTenantPaused(scopedTenant),
      current: await this.store.listCurrent(scopedTenant),
      history: await this.store.listHistory(scopedTenant),
    };
  }

  async rejectCallerAssertion(input: {
    readonly tenant_id: string;
    readonly skill_id?: string;
    readonly policy_version?: string;
    readonly reason?: string;
  }): Promise<AutonomyAssertionRejection> {
    const reason = input.reason?.trim() || 'Caller-declared autonomy is not an authority source.';
    await this.appendAudit({
      tenant_id: input.tenant_id.trim(),
      skill_id: input.skill_id?.trim(),
      policy_version: input.policy_version?.trim(),
      event: 'CALLER_ASSERTION_REJECTED',
      reason,
      actor: 'caller-assertion',
      occurred_at: nowIso(this.now),
    });
    return { accepted: false, state: 'UNCHANGED', reason };
  }

  async admit(request: AutonomyAdmissionRequest): Promise<AutonomyAdmission> {
    const input = scopedInput(request.tenant_id, request.skill_id, request.policy_version);
    if (input.tenant_id.length === 0 || input.skill_id.length === 0) {
      return { workflow: 'UNCHANGED', reason: 'UNCHANGED: autonomy scope is incomplete.' };
    }
    if (isNeverPromotableSkill(input.skill_id, request.required_authority)) {
      return { workflow: 'UNCHANGED', reason: 'UNCHANGED: skill or authority is never promotable.' };
    }

    let current: AutonomyPolicyRecord | undefined;
    let ambiguous = false;
    if (input.policy_version.length === 0) {
      const candidates = (await this.store.listCurrent(input.tenant_id))
        .filter((record) => record.skill_id === input.skill_id);
      const first = candidates[0];
      if (first !== undefined) {
        current = first;
        for (let index = 1; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          if (candidate === undefined) continue;
          const comparison = compareEffectiveAt(candidate.effective_at, current.effective_at);
          if (comparison > 0) {
            current = candidate;
            ambiguous = false;
          } else if (comparison === 0) {
            ambiguous = true;
          }
        }
      }
    } else {
      current = await this.store.getCurrent(input);
    }
    if (current === undefined) return { workflow: 'UNCHANGED', reason: 'UNCHANGED: no autonomy row exists.' };
    if (ambiguous) {
      return {
        workflow: 'PARKED_DRAFT',
        record: current,
        reason: 'PARKED_DRAFT: multiple current policy rows share the latest effective_at.',
      };
    }
    const policy_version = input.policy_version || current.policy_version;
    const recordedAuthority = current.parameters['required_authority'];
    if (
      current.state === 'PROMOTED'
      && typeof request.required_authority === 'string'
      && typeof recordedAuthority === 'string'
      && request.required_authority !== recordedAuthority
    ) {
      const demoted = await this.demote({
        tenant_id: input.tenant_id,
        skill_id: input.skill_id,
        policy_version,
        trigger: 'POLICY_DRIFT',
        actor: `system:POLICY_DRIFT`,
        reason: 'Autonomy demoted by POLICY_DRIFT: required authority changed.',
      });
      return {
        workflow: 'PARKED_DRAFT',
        reason: demoted.reason,
        trigger: 'POLICY_DRIFT',
        ...(demoted.record === undefined ? {} : { record: demoted.record }),
      };
    }
    const paused = await this.store.isTenantPaused(input.tenant_id);
    const killSwitch = await this.store.isKillSwitchSet(input.tenant_id);
    const safety = { ...request, ...(request.safety ?? {}) };
    const trigger = this.admissionTrigger(safety);
    if (trigger !== undefined && (current.state === 'PROMOTED' || current.state === 'PAUSED')) {
      const demoted = await this.demote({
        tenant_id: input.tenant_id,
        skill_id: input.skill_id,
        policy_version,
        trigger,
        actor: `system:${trigger}`,
        reason: `Autonomy demoted by ${trigger}.`,
      });
      return {
        workflow: 'PARKED_DRAFT',
        reason: demoted.reason,
        trigger,
        ...(demoted.record === undefined ? {} : { record: demoted.record }),
      };
    }
    const admissionAuthority = typeof request.required_authority === 'string'
      ? request.required_authority
      : typeof recordedAuthority === 'string' ? recordedAuthority : '';
    if (current.state === 'PROMOTED' && !paused && !killSwitch && isAutonomousAuthority(admissionAuthority)) {
      return { workflow: 'AUTO_EXECUTE', record: current, reason: 'AUTO_EXECUTE: promoted policy is admitted.' };
    }
    return {
      workflow: 'PARKED_DRAFT',
      record: current,
      reason: killSwitch
        ? 'PARKED_DRAFT: tenant kill switch is set.'
        : paused
          ? 'PARKED_DRAFT: tenant autonomy is paused.'
          : 'PARKED_DRAFT: policy is not promoted.',
    };
  }

  private admissionTrigger(input: AutonomyAdmissionRequest): AutonomyTrigger | undefined {
    const safety = { ...input, ...(input.safety ?? {}) };
    if (safety.authority_violations !== undefined && safety.authority_violations !== 0) return 'AUTHORITY_POLICY_VIOLATION';
    if (safety.duplicate_effects !== undefined && safety.duplicate_effects !== 0) return 'DUPLICATE_EFFECT';
    if (safety.provider_ambiguity === true) return 'PROVIDER_AMBIGUITY';
    if (safety.evidence_complete === false) return 'EVIDENCE_GAP';
    if (safety.audit_complete === false) return 'AUDIT_GAP';
    if (safety.policy_drift === true) return 'POLICY_DRIFT';
    if (safety.safety_ok === false) return 'FAILED_SAFETY_INVARIANT';
    if (safety.trigger !== undefined) return normalizedTrigger(safety.trigger) ?? 'FAILED_SAFETY_INVARIANT';
    return undefined;
  }

  private async appendAudit(event: AutonomyAuditEvent): Promise<void> {
    if (this.audit === undefined) return;
    await this.audit.append(event);
  }
}

export async function promote(service: AutonomyService, request: AutonomyPromotionRequest): Promise<AutonomyOperationResult> {
  return service.promote(request);
}

export async function demote(service: AutonomyService, request: AutonomyDemotionRequest): Promise<AutonomyOperationResult> {
  return service.demote(request);
}

export async function pauseTenant(service: AutonomyService, input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
  return service.pauseTenant(input);
}

export async function resumeTenant(service: AutonomyService, input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
  return service.resumeTenant(input);
}

export async function killSwitch(service: AutonomyService, input: TenantAutonomyRequest | string): Promise<readonly AutonomyPolicyRecord[]> {
  return service.killSwitch(input);
}

export async function inspect(service: AutonomyService, tenant_id: string): Promise<AutonomyInspection> {
  return service.inspect(tenant_id);
}

export async function admit(service: AutonomyService, request: AutonomyAdmissionRequest): Promise<AutonomyAdmission> {
  return service.admit(request);
}

export async function rejectCallerAssertion(service: AutonomyService, input: {
  readonly tenant_id: string;
  readonly skill_id?: string;
  readonly policy_version?: string;
  readonly reason?: string;
}): Promise<AutonomyAssertionRejection> {
  return service.rejectCallerAssertion(input);
}

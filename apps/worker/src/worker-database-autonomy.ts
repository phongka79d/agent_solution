import {
  AutonomyService,
  type AutonomyAdmissionPort,
  type AutonomyAuditEvent,
  type AutonomyPolicyRecord,
  type AutonomyStore,
} from '@agentos/core-engine';
import {
  P5AutonomyRepository,
  withTenantContext,
  type AutonomyPolicyRecord as DatabaseAutonomyPolicyRecord,
  type TenantTransactionRunner,
} from '@agentos/database';


function workerApprovedState(value: string, field: string): 'MINIMUM' | 'PROMOTED' {
  if (value === 'MINIMUM' || value === 'PROMOTED') return value;
  throw new Error(`P5_AUTONOMY_RECORD_INVALID: ${field} must be MINIMUM or PROMOTED.`);
}

function workerCoreAutonomyRecord(record: DatabaseAutonomyPolicyRecord): AutonomyPolicyRecord {
  if (record.provenance['source'] !== 'SERVER_POLICY') {
    throw new Error('P5_AUTONOMY_RECORD_INVALID: autonomy provenance is not server policy.');
  }
  return {
    policy_id: record.policy_id,
    policy_version: record.policy_version,
    tenant_id: record.tenant_id,
    skill_id: record.skill_id,
    state: record.state,
    previous_approved_state: workerApprovedState(record.previous_approved_state, 'previous_approved_state'),
    evidence_window_ref: record.evidence_window_ref,
    approver_id: record.approver_id,
    reason: record.reason,
    parameters: { ...record.parameters },
    provenance: { source: 'SERVER_POLICY' },
    effective_at: record.effective_at,
    rollback: {
      policy_version: record.rollback_policy_version,
      state: workerApprovedState(record.rollback_state, 'rollback_state'),
    },
    audit_ref: record.audit_ref,
    evidence_ref: record.evidence_ref,
  };
}

function workerDatabaseAutonomyStore(repository: P5AutonomyRepository): AutonomyStore {
  return {
    async getCurrent(input) {
      const record = await repository.get(input.tenant_id, input.skill_id, input.policy_version);
      return record === null ? undefined : workerCoreAutonomyRecord(record);
    },
    async put(record) {
      await repository.commitPolicy({
        tenant_id: record.tenant_id,
        skill_id: record.skill_id,
        policy_version: record.policy_version,
        policy_id: record.policy_id,
        state: record.state,
        previous_approved_state: record.previous_approved_state,
        evidence_window_ref: record.evidence_window_ref,
        approver_id: record.approver_id,
        reason: record.reason,
        parameters: { ...record.parameters },
        provenance: { ...record.provenance },
        effective_at: record.effective_at,
        rollback_policy_version: record.rollback.policy_version,
        rollback_state: record.rollback.state,
        audit_ref: record.audit_ref,
        evidence_ref: record.evidence_ref,
      });
    },
    async listCurrent(tenant_id) {
      const records = await repository.list(tenant_id);
      return records.map(workerCoreAutonomyRecord);
    },
    async listHistory(tenant_id) {
      const snapshots = await repository.listPolicySnapshots(tenant_id);
      const records: AutonomyPolicyRecord[] = [];
      for (const snapshot of snapshots) {
        if (typeof snapshot !== 'object' || snapshot === null) continue;
        const record = snapshot as Partial<AutonomyPolicyRecord>;
        if (record.tenant_id !== tenant_id || record.provenance?.source !== 'SERVER_POLICY') continue;
        if (typeof record.policy_id !== 'string' || typeof record.skill_id !== 'string') continue;
        if (typeof record.policy_version !== 'string' || typeof record.state !== 'string') continue;
        if (typeof record.effective_at !== 'string' || record.rollback === undefined) continue;
        records.push(record as AutonomyPolicyRecord);
      }
      return records;
    },
    async isTenantPaused(tenant_id) {
      const controls = await repository.getControls(tenant_id);
      return controls?.paused ?? false;
    },
    async setTenantPaused(tenant_id, paused) {
      const current = await repository.getControls(tenant_id);
      await repository.commitControls({
        tenant_id,
        paused,
        kill_switch: current?.kill_switch ?? false,
        actor: current?.actor ?? null,
        reason: current?.reason ?? null,
        effective_at: new Date().toISOString(),
      });
    },
    async isKillSwitchSet(tenant_id) {
      const controls = await repository.getControls(tenant_id);
      return controls?.kill_switch ?? false;
    },
    async setKillSwitch(tenant_id, on) {
      const current = await repository.getControls(tenant_id);
      await repository.commitControls({
        tenant_id,
        paused: current?.paused ?? false,
        kill_switch: on,
        actor: current?.actor ?? null,
        reason: current?.reason ?? null,
        effective_at: new Date().toISOString(),
      });
    },
  };
}


interface DatabaseAutonomyOptions {
  readonly databaseRunner?: TenantTransactionRunner | undefined;
  readonly databaseUrl?: string | undefined;
  readonly autonomy?: AutonomyAdmissionPort | undefined;
}

export function createDatabaseAutonomy(options: DatabaseAutonomyOptions): AutonomyAdmissionPort | undefined {
  const hasDatabase = options.databaseRunner !== undefined
    || (typeof options.databaseUrl === 'string' && options.databaseUrl.trim().length > 0);
  const autonomyRepository = hasDatabase
    ? new P5AutonomyRepository(options.databaseRunner ?? withTenantContext)
    : undefined;
  return options.autonomy
    ?? (autonomyRepository === undefined
      ? undefined
      : new AutonomyService(workerDatabaseAutonomyStore(autonomyRepository), {
          audit: {
            async append(event: AutonomyAuditEvent): Promise<void> {
              const actor = event.actor?.trim();
              if (actor === undefined || actor.length === 0) {
                throw new Error('P5_AUTONOMY_ACTOR_REQUIRED: an identified actor is required.');
              }
              if (event.event === 'KILL_SWITCH' || event.event === 'CALLER_ASSERTION_REJECTED') {
                await autonomyRepository.appendControlEvent({
                  tenant_id: event.tenant_id,
                  event_type: event.event,
                  actor,
                  reason: event.reason,
                  skill_id: event.skill_id ?? null,
                  policy_version: event.policy_version ?? null,
                  occurred_at: event.occurred_at,
                });
                if (event.event === 'KILL_SWITCH') {
                  await autonomyRepository.commitControls({
                    tenant_id: event.tenant_id,
                    paused: true,
                    kill_switch: true,
                    actor,
                    reason: event.reason,
                    effective_at: event.occurred_at,
                  });
                }
                return;
              }
              if (event.skill_id === undefined || event.policy_version === undefined || event.record === undefined) {
                throw new Error('P5_AUTONOMY_EVENT_INCOMPLETE: skill, version, and record are required.');
              }
              await autonomyRepository.appendPolicyEvent({
                tenant_id: event.tenant_id,
                skill_id: event.skill_id,
                policy_version: event.policy_version,
                trigger: event.event,
                from_state: event.record.previous_approved_state,
                to_state: event.record.state,
                actor,
                reason: event.reason,
                audit_ref: event.record.audit_ref,
                snapshot: { ...event.record },
                occurred_at: event.occurred_at,
              });
            },
          },
        }));
}

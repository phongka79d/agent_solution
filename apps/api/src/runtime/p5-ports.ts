import { createHash } from 'node:crypto';
import {
  AutonomyService,
  type AutonomyAuditEvent,
  type AutonomyPolicyRecord,
  type AutonomyStore,
} from '@agentos/core-engine';
import type { AutonomyAdminCommand, AutonomyAdminPort } from '../routes/v1/autonomy-admin.js';
import type {
  ProvisioningCreateInput,
  ProvisioningRoutePort,
  ProvisioningTenantProjection,
} from '../routes/v1/provisioning.js';
import {
  P5AutonomyRepository,
  P5ProvisioningRepository,
  withTenantContext,
  type AutonomyPolicyRecord as DatabaseAutonomyPolicyRecord,
  type TenantCapabilityRecord,
  type ConnectorConfigurationRecord,
  type OwnerInputRecord,
  type TenantRecord,
  type TenantTransactionRunner,
} from '@agentos/database';


export interface P5PortOptions {
  readonly databaseRunner?: TenantTransactionRunner;
}

export interface P5Ports {
  readonly autonomy: AutonomyService;
  readonly provisioning: ProvisioningRoutePort;
  readonly autonomyAdmin: AutonomyAdminPort;
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function approvedState(value: string, field: string): 'MINIMUM' | 'PROMOTED' {
  if (value === 'MINIMUM' || value === 'PROMOTED') return value;
  throw new Error(`P5_AUTONOMY_RECORD_INVALID: ${field} must be MINIMUM or PROMOTED.`);
}

function toCoreRecord(record: DatabaseAutonomyPolicyRecord): AutonomyPolicyRecord {
  if (record.provenance['source'] !== 'SERVER_POLICY') {
    throw new Error('P5_AUTONOMY_RECORD_INVALID: autonomy provenance is not server policy.');
  }
  return {
    policy_id: record.policy_id,
    policy_version: record.policy_version,
    tenant_id: record.tenant_id,
    skill_id: record.skill_id,
    state: record.state,
    previous_approved_state: approvedState(record.previous_approved_state, 'previous_approved_state'),
    evidence_window_ref: record.evidence_window_ref,
    approver_id: record.approver_id,
    reason: record.reason,
    parameters: { ...record.parameters },
    provenance: { source: 'SERVER_POLICY' },
    effective_at: record.effective_at,
    rollback: {
      policy_version: record.rollback_policy_version,
      state: approvedState(record.rollback_state, 'rollback_state'),
    },
    audit_ref: record.audit_ref,
    evidence_ref: record.evidence_ref,
  };
}

function toDatabaseRecord(record: AutonomyPolicyRecord): DatabaseAutonomyPolicyRecord {
  return {
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
  };
}
function requireOperator(command: AutonomyAdminCommand): string {
  const operator = command.operator_id?.trim();
  if (operator === undefined || operator.length === 0) {
    throw new Error('P5_OPERATOR_REQUIRED: the authenticated operator identity is required.');
  }
  return operator;
}

function verifiedSnapshot(value: unknown, tenant_id: string): AutonomyPolicyRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<AutonomyPolicyRecord>;
  if (record.tenant_id !== tenant_id) return undefined;
  if (typeof record.policy_id !== 'string' || typeof record.policy_version !== 'string') return undefined;
  if (typeof record.skill_id !== 'string' || typeof record.state !== 'string') return undefined;
  if (typeof record.effective_at !== 'string' || record.provenance?.source !== 'SERVER_POLICY') return undefined;
  if (record.rollback === undefined || typeof record.rollback.policy_version !== 'string') return undefined;
  return record as AutonomyPolicyRecord;
}


function createPolicyEventAudit(repository: P5AutonomyRepository) {
  return {
    async append(event: AutonomyAuditEvent): Promise<void> {
      const actor = event.actor?.trim();
      if (actor === undefined || actor.length === 0) {
        throw new Error('P5_AUTONOMY_ACTOR_REQUIRED: an identified actor is required.');
      }
      if (event.event === 'KILL_SWITCH' || event.event === 'CALLER_ASSERTION_REJECTED') {
        await repository.appendControlEvent({
          tenant_id: event.tenant_id,
          event_type: event.event,
          actor,
          reason: event.reason,
          skill_id: event.skill_id ?? null,
          policy_version: event.policy_version ?? null,
          occurred_at: event.occurred_at,
        });
        if (event.event === 'KILL_SWITCH') {
          await repository.commitControls({
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
      await repository.appendPolicyEvent({
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
  };
}

function createAutonomyStore(repository: P5AutonomyRepository): AutonomyStore {
  return {
    async getCurrent(input) {
      const record = await repository.get(input.tenant_id, input.skill_id, input.policy_version);
      return record === null ? undefined : toCoreRecord(record);
    },
    async put(record) {
      await repository.commitPolicy(toDatabaseRecord(record));
    },
    async listCurrent(tenant_id) {
      const records = await repository.list(tenant_id);
      return records.map(toCoreRecord);
    },
    async listHistory(tenant_id) {
      const snapshots = await repository.listPolicySnapshots(tenant_id);
      const records: AutonomyPolicyRecord[] = [];
      for (const snapshot of snapshots) {
        const record = verifiedSnapshot(snapshot, tenant_id);
        if (record !== undefined) records.push(record);
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

function projectionOf(
  tenant: TenantRecord | null,
  capabilities: readonly TenantCapabilityRecord[],
  connectors: readonly ConnectorConfigurationRecord[],
  ownerInputs: readonly OwnerInputRecord[],
  autonomy: unknown,
): ProvisioningTenantProjection | null {
  if (tenant === null) return null;
  return {
    tenant_id: tenant.tenant_id,
    status: tenant.status,
    capabilities,
    connectors,
    unresolved_owner_inputs: ownerInputs.map((input) => input.input_id),
    autonomy,
  };
}

function createProvisioningPort(
  repository: P5ProvisioningRepository,
  autonomy: AutonomyService,
): ProvisioningRoutePort {
  const read = async (tenant_id: string): Promise<ProvisioningTenantProjection | null> => {
    const tenant = await repository.getTenant(tenant_id);
    if (tenant === null) return null;
    const [capabilities, connectors, ownerInputs, autonomyProjection] = await Promise.all([
      repository.listCapabilities(tenant_id),
      repository.listConnectors(tenant_id),
      repository.listOwnerInputs(tenant_id),
      autonomy.inspect(tenant_id),
    ]);
    return projectionOf(tenant, capabilities, connectors, ownerInputs, autonomyProjection);
  };

  return {
    async createShell(input: ProvisioningCreateInput = {}) {
      const operatorKey = input.idempotency_key;
      const display_name = input.display_name?.trim();
      if (!operatorKey || operatorKey.trim().length === 0 || !display_name || display_name.length > 128) {
        throw new Error('P5_PROVISIONING_INPUT_REQUIRED: idempotency_key and display_name are required.');
      }
      const idempotency_key = sha256(operatorKey);
      const request_fingerprint = sha256(JSON.stringify({ display_name }));
      const tenant_id = await repository.provisionTenantShell({
        idempotency_key,
        request_fingerprint,
        display_name,
      });
      const projection = await read(tenant_id);
      if (projection === null) {
        throw new Error('P5_PROVISIONING_TENANT_MISSING: shell creation returned no tenant row.');
      }
      return projection;
    },
    getShell: read,
  };
}

function createAutonomyAdminPort(
  repository: P5AutonomyRepository,
  autonomy: AutonomyService,
): AutonomyAdminPort {
  return {
    pauseTenant(command: AutonomyAdminCommand) {
      const actor = requireOperator(command);
      return autonomy.pauseTenant({
        tenant_id: command.tenant_id,
        actor,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    },
    resumeTenant(command: AutonomyAdminCommand) {
      const actor = requireOperator(command);
      return autonomy.resumeTenant({
        tenant_id: command.tenant_id,
        actor,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    },
    async demote(command: AutonomyAdminCommand) {
      const actor = requireOperator(command);
      if (command.skill_id === undefined || command.skill_id.trim().length === 0) {
        throw new Error('P5_AUTONOMY_SKILL_REQUIRED: skill_id is required for demotion.');
      }
      const records = await repository.list(command.tenant_id, command.skill_id);
      if (records.length !== 1) {
        throw new Error('P5_AUTONOMY_VERSION_REQUIRED: demotion requires exactly one policy version.');
      }
      const [record] = records;
      if (record === undefined) throw new Error('P5_AUTONOMY_VERSION_REQUIRED: policy version is unavailable.');
      return autonomy.demote({
        tenant_id: command.tenant_id,
        skill_id: command.skill_id,
        policy_version: record.policy_version,
        trigger: 'OPERATOR_DEMOTE',
        actor,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    },
    async inspect(command) {
      const [state, control_events] = await Promise.all([
        autonomy.inspect(command.tenant_id),
        repository.listControlEvents(command.tenant_id),
      ]);
      return { ...state, control_events };
    },
  };
}

export function createP5Ports(options: P5PortOptions = {}): P5Ports {
  const runner = options.databaseRunner ?? withTenantContext;
  const autonomyRepository = new P5AutonomyRepository(runner);
  const provisioningRepository = new P5ProvisioningRepository(runner);
  const autonomy = new AutonomyService(createAutonomyStore(autonomyRepository), {
    audit: createPolicyEventAudit(autonomyRepository),
  });
  return {
    autonomy,
    provisioning: createProvisioningPort(provisioningRepository, autonomy),
    autonomyAdmin: createAutonomyAdminPort(autonomyRepository, autonomy),
  };
}

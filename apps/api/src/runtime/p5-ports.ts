import { createHash, randomUUID } from 'node:crypto';
import {
  AutonomyService,
  evaluatePromotionRequest,
  type AutonomyAuditEvent,
  type AutonomyPolicyRecord,
  type AutonomyStore,
} from '@agentos/core-engine';
import type {
  AutonomyAdminCommand,
  AutonomyAdminPort,
  PromotionDecisionCommand,
  PromotionRequestCommand,
} from '../routes/v1/autonomy-admin.js';
import type {
  ProvisioningCreateInput,
  ProvisioningRoutePort,
  ProvisioningTenantProjection,
} from '../routes/v1/provisioning.js';
import {
  P5AutonomyRepository,
  P5ProvisioningRepository,
  SkillCatalogRepository,
  TenantGovernanceRepository,
  TenantProfileRepository,
  withTenantContext,
  type AutonomyPolicyRecord as DatabaseAutonomyPolicyRecord,
  type CommitAutonomyPolicyInput,
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

function toDatabaseRecord(record: AutonomyPolicyRecord): CommitAutonomyPolicyInput {
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
    data_class: tenant.data_class,
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
  profiles: TenantProfileRepository,
): ProvisioningRoutePort {
  const skillCatalog = new SkillCatalogRepository();
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
      const data_class = input.data_class ?? 'PRODUCTION';
      const tenant_id = await repository.provisionTenantShell({
        idempotency_key,
        request_fingerprint,
        display_name,
        data_class,
      });
      if (input.locale !== undefined || input.timezone !== undefined || input.currency !== undefined) {
        const profile = await profiles.get(tenant_id);
        if (profile === null) throw new Error('TENANT_PROFILE_NOT_FOUND: provisioned company has no profile row.');
        // Audited by the repository (company.profile UPDATE); a retried call with equal values is a no-op.
        await profiles.update({
          tenant_id,
          values: {
            company_name: profile.company_name,
            industry: profile.industry,
            locale: input.locale ?? profile.locale,
            timezone: input.timezone ?? profile.timezone,
            currency: input.currency ?? profile.currency,
            brand_profile: profile.brand_profile,
          },
          expected_version: profile.version,
          actor_kind: input.actor_kind ?? 'PLATFORM',
          actor_id: input.actor_id ?? 'provisioning',
          correlation_id: input.correlation_id ?? tenant_id,
        });
      }
      // Provisioning defaults (T4.2): READ skills enabled, EFFECT/APPROVAL disabled. Idempotent, so
      // a retried provisioning call never revives a company's deliberate disablement.
      await skillCatalog.seedDefaultSettings(tenant_id, {
        actor_kind: 'SYSTEM',
        actor_id: 'provisioning',
        correlation_id: tenant_id,
      });
      const projection = await read(tenant_id);
      if (projection === null) {
        throw new Error('P5_PROVISIONING_TENANT_MISSING: shell creation returned no tenant row.');
      }
      return projection;
    },
    listOwnerInputs: (tenant_id) => repository.listOwnerInputs(tenant_id),
    resolveOwnerInput: (input) => repository.resolveOwnerInput(input),
    getShell: read,
  };
}

function createAutonomyAdminPort(
  repository: P5AutonomyRepository,
  autonomy: AutonomyService,
  governance: TenantGovernanceRepository,
): AutonomyAdminPort {
  /** Writes the PROMOTED policy and its policy event in one transaction, with revision CAS. */
  const commitApprovedPromotion = async (input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly policy_version: string;
    readonly required_authority: string;
    readonly evidence_window_ref: string;
    readonly approver: string;
    readonly reason: string;
    readonly expected_revision: number | undefined;
  }) => {
    const current = await repository.get(input.tenant_id, input.skill_id, input.policy_version);
    const effective_at = new Date().toISOString();
    return repository.commitPolicy({
      tenant_id: input.tenant_id,
      skill_id: input.skill_id,
      policy_version: input.policy_version,
      policy_id: current?.policy_id ?? randomUUID(),
      state: 'PROMOTED',
      previous_approved_state: current?.state === 'PROMOTED'
        ? 'PROMOTED'
        : current?.previous_approved_state ?? 'MINIMUM',
      evidence_window_ref: input.evidence_window_ref,
      approver_id: input.approver,
      reason: input.reason,
      parameters: { required_authority: input.required_authority },
      provenance: { source: 'SERVER_POLICY' },
      effective_at,
      rollback_policy_version: current?.rollback_policy_version ?? input.policy_version,
      rollback_state: current?.rollback_state ?? 'MINIMUM',
      audit_ref: null,
      evidence_ref: null,
      ...(input.expected_revision === undefined ? {} : { expected_revision: input.expected_revision }),
      policy_event: {
        trigger: 'PROMOTION_APPROVED',
        from_state: current?.state ?? 'MINIMUM',
        to_state: 'PROMOTED',
        actor: input.approver,
        reason: input.reason,
        audit_ref: null,
        snapshot: {
          skill_id: input.skill_id,
          policy_version: input.policy_version,
          required_authority: input.required_authority,
          evidence_window_ref: input.evidence_window_ref,
        },
        occurred_at: effective_at,
      },
    });
  };

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
    async requestPromotion(command: PromotionRequestCommand) {
      const requester = requireOperator(command);
      const [evidence_window, settings, current] = await Promise.all([
        repository.readPromotionEvidence(command.tenant_id, command.skill_id, 30),
        governance.get(command.tenant_id),
        repository.get(command.tenant_id, command.skill_id, command.policy_version),
      ]);
      const expected_revision = command.expected_revision ?? current?.policy_revision;
      const decision = evaluatePromotionRequest({
        tenant_id: command.tenant_id,
        skill_id: command.skill_id,
        policy_version: command.policy_version,
        required_authority: command.required_authority,
        requester_id: requester,
        require_distinct_approver: settings?.require_distinct_approver ?? false,
        evidence_window,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        ...(expected_revision === undefined ? {} : { expected_revision }),
      });
      if (decision.status === 'APPROVED') {
        const approver = decision.approved_by ?? requester;
        const record = await commitApprovedPromotion({
          tenant_id: command.tenant_id,
          skill_id: command.skill_id,
          policy_version: command.policy_version,
          required_authority: command.required_authority,
          evidence_window_ref: evidence_window.window_ref,
          approver,
          reason: decision.request.reason ?? 'Server-approved autonomy promotion.',
          expected_revision,
        });
        const request = await repository.createPromotionRequest({
          tenant_id: command.tenant_id,
          skill_id: command.skill_id,
          policy_version: command.policy_version,
          required_authority: command.required_authority,
          requester_id: requester,
          approver_id: approver,
          status: 'APPROVED',
          code: decision.code,
          reason: record.reason,
          evidence_window,
          evidence_window_ref: evidence_window.window_ref,
          ...(expected_revision === undefined ? {} : { expected_revision }),
        });
        return { request, policy: record };
      }
      const request = await repository.createPromotionRequest({
        tenant_id: command.tenant_id,
        skill_id: command.skill_id,
        policy_version: command.policy_version,
        required_authority: command.required_authority,
        requester_id: requester,
        approver_id: null,
        status: decision.status === 'PENDING' ? 'PENDING' : 'REJECTED',
        code: decision.code,
        reason: decision.reason,
        evidence_window,
        evidence_window_ref: evidence_window.window_ref,
        ...(expected_revision === undefined ? {} : { expected_revision }),
      });
      return { request, policy: null };
    },
    async decidePromotion(command: PromotionDecisionCommand) {
      const approver = requireOperator(command);
      const existing = await repository.getPromotionRequest(command.tenant_id, command.request_id);
      if (existing === null) {
        throw new Error('P5_AUTONOMY_REQUEST_MISSING: promotion request was not found.');
      }
      if (existing.status !== 'PENDING') {
        throw new Error('P5_AUTONOMY_REQUEST_CONFLICT: promotion request is already decided.');
      }
      const decided_at = new Date().toISOString();
      const close = (status: 'APPROVED' | 'REJECTED', code: string, reason: string, policy_revision: number | null) =>
        repository.decidePromotionRequest({
          tenant_id: command.tenant_id,
          request_id: command.request_id,
          status,
          code,
          reason,
          approver_id: approver,
          policy_revision,
          decided_at,
        });
      if (command.decision === 'REJECT') {
        const request = await close(
          'REJECTED',
          'REJECTED_BY_APPROVER',
          command.reason ?? `REJECTED: ${approver} declined the promotion.`,
          existing.policy_revision,
        );
        return { request, policy: null };
      }
      const settings = await governance.get(command.tenant_id);
      const decision = evaluatePromotionRequest({
        tenant_id: existing.tenant_id,
        skill_id: existing.skill_id,
        policy_version: existing.policy_version,
        required_authority: existing.required_authority,
        requester_id: existing.requester_id,
        approver_id: approver,
        require_distinct_approver: settings?.require_distinct_approver ?? false,
        evidence_window: existing.evidence_window,
        reason: command.reason ?? existing.reason,
        ...(existing.expected_revision === null ? {} : { expected_revision: existing.expected_revision }),
      });
      if (decision.status !== 'APPROVED') {
        const request = await close('REJECTED', decision.code, decision.reason, existing.policy_revision);
        return { request, policy: null };
      }
      const record = await commitApprovedPromotion({
        tenant_id: existing.tenant_id,
        skill_id: existing.skill_id,
        policy_version: existing.policy_version,
        required_authority: existing.required_authority,
        evidence_window_ref: existing.evidence_window_ref,
        approver,
        reason: decision.request.reason ?? 'Server-approved autonomy promotion.',
        expected_revision: existing.expected_revision ?? undefined,
      });
      const request = await close('APPROVED', decision.code, record.reason, record.policy_revision);
      return { request, policy: record };
    },
    async listPromotionRequests(command) {
      const status = command.status === 'PENDING' || command.status === 'APPROVED' || command.status === 'REJECTED'
        ? command.status
        : null;
      return repository.listPromotionRequests(command.tenant_id, status);
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
    provisioning: createProvisioningPort(provisioningRepository, autonomy, new TenantProfileRepository(runner)),
    autonomyAdmin: createAutonomyAdminPort(
      autonomyRepository,
      autonomy,
      new TenantGovernanceRepository(options.databaseRunner),
    ),
  };
}

import type { PlatformAgentId } from '../contracts/types.js';

/** The only lifecycle status a newly allocated tenant may receive. */
export type ProvisioningStatus = 'PROVISIONED';

/** A capability is present as a shell, but no capability has been configured or enabled. */
export type CapabilityStatus = 'UNCONFIGURED';

/** Connectors are deliberately absent until an owner supplies and verifies credentials. */
export type ConnectorStatus = 'UNBOUND';
export type ConnectorEnabledStatus = 'DISABLED';

/** Promotion candidates begin at the least permissive workflow posture. */
export type AutonomyMinimum = 'MINIMUM';

/** Values that must be supplied by an owner before the related behaviour can be enabled. */
export type OwnerInputKey =
  | 'ASM-001'
  | 'ASM-002'
  | 'ASM-003'
  | 'ASM-004'
  | 'FLOOR_POLICY'
  | 'REFUND_POLICY'
  | 'RETENTION_POLICY'
  | 'KPI_BASELINE'
  | 'CREDENTIALS'
  | 'RESIDENCY'
  | 'PROMOTION_LIMITS'
  | 'NAMESPACE_IDENTIFIERS'
  | 'AUDIT_PROVISIONING_EVIDENCE'
  | 'careOnboardingItinerary';

export interface OwnerInputState {
  readonly key: OwnerInputKey;
  readonly status: 'UNRESOLVED';
}

export interface WorkspaceBinding {
  readonly tenant_id: string;
  readonly status: 'BOUND';
}

export interface AgentShellReference {
  readonly agent_id: PlatformAgentId;
  readonly status: 'SHELL';
}

export interface SkillShellReference {
  readonly skill_id: string;
  readonly status: 'SHELL';
  readonly autonomy: AutonomyMinimum;
}

export interface CapabilityShell {
  readonly status: CapabilityStatus;
}

export interface ConnectorShell {
  readonly status: ConnectorStatus;
  readonly enabled: ConnectorEnabledStatus;
}

export interface AutonomyCandidateSkill {
  readonly skill_id: string;
  readonly workflow: AutonomyMinimum;
}

export interface AutonomyShell {
  readonly candidate_skills: readonly AutonomyCandidateSkill[];
  readonly summary: {
    readonly status: AutonomyMinimum;
    readonly candidate_count: number;
  };
}

export interface ProvisioningEvidenceEvent {
  readonly event_type: 'TENANT_PROVISIONED';
  readonly status: 'UNRESOLVED';
}

/** Complete, safe-by-default tenant shell returned by provisioning. */
export interface TenantShell {
  readonly tenant_id: string;
  readonly status: ProvisioningStatus;
  readonly workspace: WorkspaceBinding;
  readonly agents: readonly AgentShellReference[];
  readonly skills: readonly SkillShellReference[];
  readonly capabilities: CapabilityShell;
  readonly connectors: ConnectorShell;
  readonly autonomy: AutonomyShell;
  readonly unresolved_owner_inputs: readonly OwnerInputKey[];
  readonly owner_inputs: readonly OwnerInputState[];
  readonly provisioning_evidence: ProvisioningEvidenceEvent;
}

export interface CreateShellInput {
  /** A caller-supplied idempotency key; it never supplies tenant identity. */
  readonly idempotency_key?: string;
  /** Camel-case alias accepted at the service seam for in-process callers. */
  readonly idempotencyKey?: string;
  /** Explicit request fingerprint. If absent, the service derives one from safe inputs. */
  readonly fingerprint?: string;
  /** Deliberately ignored if supplied by an untrusted API body. */
  readonly tenant_id?: string;
  readonly [key: string]: unknown;
}

export interface ProvisioningStoreTransaction {
  putTenant(shell: TenantShell): Promise<void> | void;
  appendEvidence(event: ProvisioningEvidenceEvent & { readonly tenant_id: string }): Promise<void> | void;
}

export interface ProvisioningTransactionResult<T> {
  readonly value: T;
  readonly replay: boolean;
}

export interface ProvisioningStore {
  transaction<T>(
    params: {
      readonly idempotency_key?: string;
      readonly fingerprint: string;
    },
    work: (transaction: ProvisioningStoreTransaction) => Promise<T> | T,
  ): Promise<ProvisioningTransactionResult<T>>;
  getTenant(tenant_id: string): Promise<TenantShell | null>;
  listTenants?(): Promise<readonly TenantShell[]>;
}

export interface MutatingDispatchRequest {
  readonly tenant_id: string;
  readonly required_owner_inputs?: readonly OwnerInputKey[];
}

export type MutatingDispatchBlockReason =
  | 'TENANT_NOT_FOUND'
  | 'CONNECTORS_UNBOUND'
  | 'OWNER_INPUT_UNRESOLVED';

export interface MutatingDispatchAdmission {
  readonly status: 'ALLOWED' | 'BLOCKED';
  readonly allowed: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly MutatingDispatchBlockReason[];
  readonly unresolved_owner_inputs: readonly OwnerInputKey[];
}

export class ProvisioningConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message = 'the idempotency key was already used with a different request fingerprint') {
    super(message);
    this.name = 'ProvisioningConflictError';
  }
}

export class ProvisioningNotFoundError extends Error {
  readonly code = 'TENANT_NOT_FOUND';

  constructor(tenant_id: string) {
    super(`tenant ${tenant_id} is not provisioned`);
    this.name = 'ProvisioningNotFoundError';
  }
}

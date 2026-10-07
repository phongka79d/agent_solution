/** Durable controlled-autonomy contracts. All persistence edges are injected so a PostgreSQL
 * binding can replace the test store without moving authority decisions into process memory. */


export type AutonomyState = 'MINIMUM' | 'PROMOTED' | 'PAUSED' | 'DEMOTED';
export type AutonomyApprovedState = 'MINIMUM' | 'PROMOTED';
export type AutonomyWorkflow = 'UNCHANGED' | 'AUTO_EXECUTE' | 'PARKED_DRAFT';

export type AutonomyTrigger =
  | 'AUTHORITY_POLICY_VIOLATION'
  | 'DUPLICATE_EFFECT'
  | 'PROVIDER_AMBIGUITY'
  | 'EVIDENCE_GAP'
  | 'AUDIT_GAP'
  | 'POLICY_DRIFT'
  | 'OPERATOR_PAUSE'
  | 'OPERATOR_KILL_SWITCH'
  | 'FAILED_SAFETY_INVARIANT'
  | 'OPERATOR_DEMOTE';

export interface AutonomyRollbackTarget {
  readonly policy_version: string;
  readonly state: AutonomyApprovedState;
}

export interface AutonomyProvenance {
  readonly source: 'SERVER_POLICY';
}

export interface AutonomyPolicyRecord {
  readonly policy_id: string;
  readonly policy_version: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly state: AutonomyState;
  readonly previous_approved_state: AutonomyApprovedState;
  readonly evidence_window_ref: string | null;
  readonly approver_id: string | null;
  readonly reason: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly provenance: AutonomyProvenance;
  readonly effective_at: string;
  readonly rollback: AutonomyRollbackTarget;
  readonly audit_ref: string | null;
  readonly evidence_ref: string | null;
}

export interface AutonomyPromotionRequest {
  readonly policy_id?: string;
  readonly policy_version?: string | undefined;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly required_authority: string;
  readonly evidence_window_ref?: string | undefined;
  readonly evidence_ref?: string;
  readonly audit_ref?: string;
  readonly authority_violations?: number;
  readonly duplicate_effects?: number;
  readonly audit_complete?: boolean | undefined;
  readonly evidence_complete?: boolean | undefined;
  readonly approver_id?: string | undefined;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly latency?: unknown;
  readonly cost?: unknown;
  readonly latency_provenance_ref?: string;
  readonly cost_provenance_ref?: string;
  /** Accepted as data only for compatibility; never read by the eligibility decision. */
  readonly prompt?: unknown;
  readonly model_text?: unknown;
  readonly caller_authority?: unknown;
}

export interface AutonomyDemotionRequest {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly trigger: AutonomyTrigger | string;
  readonly reason?: string;
  /** Authenticated operator, or a system:<trigger> identity for non-operator demotion. */
  readonly actor?: string | undefined;
  readonly audit_ref?: string | undefined;
  readonly evidence_ref?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface AutonomyAdmissionSafety {
  readonly safety_ok?: boolean;
  readonly authority_violations?: number;
  readonly duplicate_effects?: number;
  readonly audit_complete?: boolean;
  readonly evidence_complete?: boolean;
  readonly provider_ambiguity?: boolean;
  readonly policy_drift?: boolean;
  readonly trigger?: AutonomyTrigger | string;
}

export interface AutonomyAdmissionRequest extends AutonomyAdmissionSafety {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly policy_version: string;
  readonly required_authority?: string;
  readonly safety?: AutonomyAdmissionSafety;
}

export interface AutonomyAdmission {
  readonly workflow: AutonomyWorkflow;
  readonly record?: AutonomyPolicyRecord;
  readonly reason: string;
  readonly trigger?: AutonomyTrigger;
}

export interface AutonomyOperationResult {
  readonly accepted: boolean;
  readonly eligible: boolean;
  readonly reason: string;
  readonly record?: AutonomyPolicyRecord;
}

export interface AutonomyInspection {
  readonly tenant_id: string;
  readonly paused: boolean;
  readonly current: readonly AutonomyPolicyRecord[];
  readonly history: readonly AutonomyPolicyRecord[];
}

export interface AutonomyAssertionRejection {
  readonly accepted: false;
  readonly state: 'UNCHANGED';
  readonly reason: string;
}

export interface AutonomyAuditEvent {
  readonly tenant_id: string;
  readonly skill_id?: string | undefined;
  readonly policy_version?: string | undefined;
  readonly event: 'CALLER_ASSERTION_REJECTED' | 'PROMOTED' | 'DEMOTED' | 'PAUSED' | 'RESUMED' | 'KILL_SWITCH';
  readonly reason: string;
  readonly actor?: string | undefined;
  readonly occurred_at: string;
  readonly record?: AutonomyPolicyRecord;
}

export interface AutonomyAuditPort {
  append(event: AutonomyAuditEvent): Promise<void> | void;
}

/** The admission port is deliberately narrower than AutonomyService. */
export interface AutonomyAdmissionPort {
  admit(request: AutonomyAdmissionRequest): Promise<AutonomyAdmission> | AutonomyAdmission;
}

/** Durable persistence contract; no implementation may rely on process-local state for admission. */
export interface AutonomyStore {
  getCurrent(input: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly policy_version: string;
  }): Promise<AutonomyPolicyRecord | undefined> | AutonomyPolicyRecord | undefined;
  put(record: AutonomyPolicyRecord): Promise<void> | void;
  listCurrent(tenant_id: string): Promise<readonly AutonomyPolicyRecord[]> | readonly AutonomyPolicyRecord[];
  listHistory(tenant_id: string): Promise<readonly AutonomyPolicyRecord[]> | readonly AutonomyPolicyRecord[];
  isTenantPaused(tenant_id: string): Promise<boolean> | boolean;
  setTenantPaused(tenant_id: string, paused: boolean): Promise<void> | void;
  isKillSwitchSet(tenant_id: string): Promise<boolean> | boolean;
  setKillSwitch(tenant_id: string, on: boolean): Promise<void> | void;
}

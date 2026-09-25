/** Persisted Care case vocabulary and tenant-bound manage-case operation. */
export type ServiceCaseState =
  | 'NEW'
  | 'CLASSIFIED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'WAITING_CUSTOMER'
  | 'RESOLVED'
  | 'CLOSED';

export type ServiceCasePriority = 'P1' | 'P2' | 'P3' | 'P4';

export type ServiceCaseActionType =
  | 'CREATE'
  | 'TRANSITION_STATE'
  | 'ASSIGN'
  | 'RESOLVE'
  | 'REOPEN'
  | 'CLOSE';

/** Input accepted by the tenant-scoped, versioned ServiceCaseRepository. */
export interface ManageServiceCaseInput {
  readonly tenant_id: string;
  readonly case_id?: string;
  readonly customer_id: string;
  readonly intent: string;
  readonly priority: ServiceCasePriority;
  readonly conversation_id: string;
  readonly related_order_id?: string | null;
  readonly evidence_refs?: readonly string[];
  readonly action_type: ServiceCaseActionType;
  readonly target_status?: ServiceCaseState;
  readonly assigned_owner?: string | null;
  readonly notes?: string;
  readonly expected_case_version?: number;
  /** Configured policy value; absent policy never becomes a guessed SLA. */
  readonly sla_target_hours?: number;
  readonly effect_key: string;
  readonly request_fingerprint: string;
  readonly actor_id: string;
}

/** Stable output shape required by `skill.care.manage_case`. */
export interface ManagedServiceCase {
  readonly case_id: string;
  readonly customer_id: string;
  readonly intent: string;
  readonly priority: ServiceCasePriority;
  readonly status: ServiceCaseState;
  readonly conversation_id: string;
  readonly related_order_id: string | null;
  readonly evidence_refs: readonly string[];
  readonly assigned_owner: string | null;
  readonly sla_target_hours: number;
  readonly updated_at: string;
  readonly case_version: number;
}
/** Durable receipt lookup and current case version after an ambiguous case operation. */
export type ServiceCaseReconciliation =
  | { readonly state: 'COMMITTED'; readonly output: ManagedServiceCase }
  | {
      readonly state: 'NOT_COMMITTED';
      readonly case_id: string | null;
      readonly current_case_version: number | null;
      readonly current_status: ServiceCaseState | null;
    };

/** Durable SCR-005 handoff queue contracts (implement/03 and implement/04). */

export interface EnqueueCareHandoffInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly conversation_id: string;
  readonly customer_id?: string;
  readonly escalation_reason: string;
  readonly summary_context?: string;
}

export interface CareHandoffOutput {
  readonly handoff_id: string;
  readonly queue_position: number;
  readonly status: 'ENQUEUED' | 'ASSIGNED';
  readonly escalated_at: string;
}

/** Stable receipt written with the queue row and effect reservation in one transaction. */
export interface CareHandoffExecutionReceipt {
  readonly execution_id: string;
  readonly adapter_status: 'SUCCESS';
  readonly provider_reference: string;
  readonly response_payload: CareHandoffOutput;
  readonly latency_ms: 0;
  readonly token_usage: {
    readonly prompt: 0;
    readonly completion: 0;
    readonly total_cost_usd: 0;
  };
}

export interface CareHandoffEnqueueResult {
  readonly disposition: 'CREATED' | 'REPLAY';
  readonly output: CareHandoffOutput;
  readonly receipt: CareHandoffExecutionReceipt;
}

export interface ReconcileCareHandoffInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
}

export type CareHandoffReconciliation =
  | {
      readonly state: 'COMMITTED';
      readonly output: CareHandoffOutput;
      readonly receipt: CareHandoffExecutionReceipt;
    }
  | { readonly state: 'NOT_COMMITTED' };

export interface ClaimCareHandoffInput {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly operator_id: string;
}

export type CareHandoffClaimOutcome = 'CLAIMED' | 'NO_HANDOFF' | 'HELD_BY_ANOTHER_OPERATOR';

export interface CompleteCareHandoffInput extends ClaimCareHandoffInput {
  readonly completion_summary?: string | null;
}

export type CareHandoffCompletionOutcome =
  | 'COMPLETED'
  | 'NO_HANDOFF'
  | 'NOT_ASSIGNED'
  | 'HELD_BY_ANOTHER_OPERATOR';

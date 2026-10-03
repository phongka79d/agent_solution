/**
 * Platform operations UI state and diagnostic projections.
 * The shared run list/summary/reconciliation DTOs are re-exported from platform-client to avoid duplicate shapes.
 */

export type {
  PlatformReconciliationItem,
  PlatformRunListItem,
  PlatformRunsSummaryRow,
} from '../../lib/platform-client';

/** OpenAPI has no success schemas for platform run detail/trace; these known UI projection fields stay local. */
export interface PlatformRunCostBreakdown {
  readonly currency: string | null;
  readonly cost_recorded: boolean;
  readonly record_count: number;
  readonly cost_total: string | null;
}

/** Single-run diagnostic detail row. */
export interface PlatformRunDetail {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly correlation_id: string;
  readonly current_step: number;
  readonly state: string;
  readonly task_version: number;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly conversation_id: string | null;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly stage_event_count: number;
  readonly evidence_count: number;
  readonly cost_breakdown: readonly PlatformRunCostBreakdown[];
  readonly input_tokens_total: number;
  readonly output_tokens_total: number;
  readonly cached_tokens_total: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlatformRunTraceStage {
  readonly stage: string;
  readonly status: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly agent_code: string | null;
  readonly skill_id: string | null;
  readonly summary_key: string | null;
  readonly error_class: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly evidence_refs: readonly string[];
}

export interface PlatformRunTraceProviderCall {
  readonly provider: string;
  readonly model: string;
  readonly outcome: string;
  readonly latency_ms: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: string | null;
  readonly currency: string | null;
  readonly cost_status: string | null;
}

export interface PlatformRunTraceStep {
  readonly step_index: number;
  readonly agent: string;
  readonly skill: string;
  readonly tool_binding: string;
  readonly authority: string;
  readonly autonomy_decision: Readonly<Record<string, string>>;
  readonly execution_status: string;
  readonly effect_key: string | null;
  readonly reservation_status: string | null;
  readonly receipt_ref: string | null;
  readonly error_code: string | null;
  readonly error_hint: string | null;
}

export interface PlatformRunTraceAuditEntry {
  readonly audit_ref: string;
  readonly created_at: string;
  readonly agent: string;
  readonly skill: string;
  readonly tool_binding: string;
  readonly authority: string;
  readonly execution_status: string;
}

export interface PlatformRunTraceApproval {
  readonly approval_id: string;
  readonly status: string;
  readonly effect_key: string;
  readonly created_at: string;
}

export interface PlatformRunTraceHandoff {
  readonly handoff_id: string;
  readonly status: string;
  readonly effect_key: string;
  readonly created_at: string;
  readonly conversation_id: string;
}

export interface PlatformRunTrace {
  readonly run_id: string;
  readonly correlation_id: string;
  readonly domain: string;
  readonly state: { readonly business: string; readonly raw: string };
  readonly attempts: number;
  readonly duration_ms: number;
  readonly stages: readonly PlatformRunTraceStage[];
  readonly provider_calls: readonly PlatformRunTraceProviderCall[];
  readonly steps: readonly PlatformRunTraceStep[];
  readonly audit_entries: readonly PlatformRunTraceAuditEntry[];
  readonly approvals: readonly PlatformRunTraceApproval[];
  readonly handoffs: readonly PlatformRunTraceHandoff[];
  readonly effect_keys: readonly string[];
  readonly approval_id: string | null;
  readonly evidence_refs: readonly string[];
}

/** Tabs of the operations console. */
export type OperationsTab = 'runs' | 'reconcile' | 'stuck';

/** Active filter state; search is evaluated against identifiers by the platform list query. */
export interface RunFilters {
  readonly company_id: string;
  readonly state: string;
  readonly domain: string;
  readonly from: string;
  readonly to: string;
  readonly search: string;
}

export const EMPTY_RUN_FILTERS: RunFilters = Object.freeze({
  company_id: '',
  state: '',
  domain: '',
  from: '',
  to: '',
  search: '',
});

/** Operations form state for a reconciliation command; its request schema is not defined in OpenAPI yet. */
export type ReconciliationResolution =
  | 'PROVIDER_CONFIRMED_SUCCEEDED'
  | 'PROVIDER_CONFIRMED_ABSENT'
  | 'ESCALATE_MANUALLY';

export interface ReconciliationInput {
  readonly resolution: ReconciliationResolution;
  readonly reason: string;
  readonly receipt?: Record<string, unknown>;
}

/** List response envelopes keep the derived rows under `items`. */
export interface ItemsEnvelope<T> {
  readonly items: readonly T[];
}

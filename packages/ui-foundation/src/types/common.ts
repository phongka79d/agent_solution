export type SharedUiState =
  | 'idle'
  | 'loading'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'permission_denied'
  | 'dependency_unavailable'
  | 'version_conflict'
  | 'fail_closed';

export type SourceStatus =
  | 'LIVE'
  | 'STALE'
  | 'NO_DATA'
  | 'NOT_INSTRUMENTED'
  | 'UNAVAILABLE'
  | 'FAIL_CLOSED';
export type SourceFreshness = 'LIVE' | 'STALE' | 'UNKNOWN';

export type ProductCapabilityStatus =
  | 'INTEGRATED'
  | 'PARTIAL'
  | 'NOT_INTEGRATED'
  | 'NOT_CONFIGURED'
  | 'BLOCKED'
  | 'DEMO_ONLY';

export type UiRequestState =
  | 'loading'
  | 'empty'
  | 'permission_denied'
  | 'dependency_unavailable'
  | 'version_conflict'
  | 'fail_closed';

export interface ObservedAt {
  readonly observed_at: string | null;
  readonly source: SourceFreshness;
}


export type EvidenceClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION';
export type AuthorityVerdict = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
export type TaskWireStatus = 'accepted' | 'running' | 'waiting' | 'awaiting_human' | 'completed' | 'stopped' | 'failed';
export type TaskStoredState = 'queued' | 'running' | 'waiting' | 'awaiting_human' | 'completed' | 'stopped' | 'failed';
export type TaskLifecycleState = TaskWireStatus | TaskStoredState;

export interface ApiErrorEnvelope {
  readonly error_code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly details?: Record<string, unknown> | unknown | undefined;
}

import type {
  ProductCapabilityStatus,
  SharedUiState,
  SourceStatus,
  UiRequestState,
} from './types/common.js';

export type {
  ProductCapabilityStatus,
  SharedUiState,
  SourceStatus,
  UiRequestState,
};

export function getSharedUiStateBadgeClass(state: SharedUiState): string {
  return `ui-status ui-status--${state.replaceAll('_', '-')}`;
}

export function getSourceStatusBadgeClass(status: SourceStatus): string {
  return `ui-status ui-status--${status.toLowerCase().replaceAll('_', '-')}`;
}

export function getCapabilityStatusBadgeClass(status: ProductCapabilityStatus): string {
  return `ui-status ui-status--${status.toLowerCase().replaceAll('_', '-')}`;
}

export const SHARED_UI_STATE_LABELS: Record<SharedUiState, string> = {
  idle: 'Idle',
  loading: 'Loading',
  empty: 'No records',
  partial: 'Partial data',
  stale: 'Stale snapshot',
  permission_denied: 'Permission denied',
  dependency_unavailable: 'Dependency unavailable',
  version_conflict: 'Version conflict',
  fail_closed: 'Fail closed',
};

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  LIVE: 'Live',
  STALE: 'Stale',
  NO_DATA: 'No data',
  NOT_INSTRUMENTED: 'Not instrumented',
  UNAVAILABLE: 'Unavailable',
  FAIL_CLOSED: 'Fail closed',
};

export const CAPABILITY_STATUS_LABELS: Record<ProductCapabilityStatus, string> = {
  INTEGRATED: 'Integrated',
  PARTIAL: 'Partial',
  NOT_INTEGRATED: 'Not integrated',
  NOT_CONFIGURED: 'Not configured',
  BLOCKED: 'Blocked',
  DEMO_ONLY: 'Demo only',
};

export const UI_REQUEST_STATE_LABELS: Record<UiRequestState, string> = {
  loading: 'Loading',
  empty: 'No records',
  permission_denied: 'Permission denied',
  dependency_unavailable: 'Dependency unavailable',
  version_conflict: 'Version conflict',
  fail_closed: 'Fail closed',
};

export function statusLabel(
  status: SourceStatus | ProductCapabilityStatus | UiRequestState,
): string {
  if (status in SOURCE_STATUS_LABELS) {
    return SOURCE_STATUS_LABELS[status as SourceStatus];
  }
  if (status in CAPABILITY_STATUS_LABELS) {
    return CAPABILITY_STATUS_LABELS[status as ProductCapabilityStatus];
  }
  return UI_REQUEST_STATE_LABELS[status as UiRequestState];
}

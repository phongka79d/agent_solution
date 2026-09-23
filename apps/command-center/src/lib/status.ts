/**
 * @file apps/command-center/src/lib/status.ts
 * Operational status mappings and visual state helpers.
 * Never invents mock or default success states; strictly distinguishes
 * between idle, loading, empty, stale, permission_denied, dependency_unavailable,
 * version_conflict, and fail_closed.
 */

import type { SharedUiState, SourceStatus } from './api-types';

export type { SharedUiState, SourceStatus };

/**
 * Standard badge visual styling class for each SharedUiState.
 */
export function getSharedUiStateBadgeClass(state: SharedUiState): string {
  switch (state) {
    case 'idle':
      return 'bg-slate-800 text-slate-400 border-slate-700';
    case 'loading':
      return 'bg-sky-950/60 text-sky-400 border-sky-800/80 animate-pulse';
    case 'empty':
      return 'bg-slate-900 text-slate-400 border-slate-800';
    case 'partial':
      return 'bg-amber-950/60 text-amber-400 border-amber-800/80';
    case 'stale':
      return 'bg-amber-950/80 text-amber-300 border-amber-700';
    case 'permission_denied':
      return 'bg-rose-950/80 text-rose-300 border-rose-800';
    case 'dependency_unavailable':
      return 'bg-zinc-800 text-zinc-300 border-zinc-700';
    case 'version_conflict':
      return 'bg-purple-950/80 text-purple-300 border-purple-800';
    case 'fail_closed':
      return 'bg-red-950/90 text-red-400 border-red-800';
    default:
      return 'bg-slate-900 text-slate-400 border-slate-800';
  }
}

/**
 * Standard badge visual styling class for telemetry SourceStatus.
 */
export function getSourceStatusBadgeClass(status: SourceStatus): string {
  switch (status) {
    case 'LIVE':
      return 'bg-emerald-950/60 text-emerald-400 border-emerald-800';
    case 'STALE':
      return 'bg-amber-950/60 text-amber-400 border-amber-800';
    case 'NO_DATA':
      return 'bg-slate-900 text-slate-400 border-slate-800';
    case 'NOT_INSTRUMENTED':
      return 'bg-zinc-900 text-zinc-400 border-zinc-800';
    case 'UNAVAILABLE':
      return 'bg-rose-950/60 text-rose-400 border-rose-800';
    case 'FAIL_CLOSED':
      return 'bg-red-950/90 text-red-400 border-red-800';
    default:
      return 'bg-slate-900 text-slate-400 border-slate-800';
  }
}

/**
 * Human-readable descriptive labels for operational UI states.
 */
export const SHARED_UI_STATE_LABELS: Record<SharedUiState, string> = {
  idle: 'Idle',
  loading: 'Loading...',
  empty: 'No Records',
  partial: 'Partial Data',
  stale: 'Stale Snapshot',
  permission_denied: 'Permission Denied',
  dependency_unavailable: 'Dependency Unavailable',
  version_conflict: 'Version Conflict',
  fail_closed: 'Fail Closed',
};

/**
 * Transport for the platform operations console (T8.3).
 *
 * All traffic is same-origin through the platform BFF (`/api/v1/...`); the browser never holds the
 * API bearer. Retry and reconciliation eligibility is decided by the server (`retry_eligible`,
 * `platform_reconciliation_queue`), never by a client-side rule.
 */

import { platformJson } from '../../lib/platform-client';
import type {
  ItemsEnvelope,
  ReconciliationInput,
  RunFilters,
} from './types';

export const OPERATIONS_PATHS = Object.freeze({
  runs: 'platform/runs',
  summary: 'platform/runs/summary',
} as const);

/** `useApi` select helper: unwraps a derived-row envelope, tolerating a missing `items`. */
export function selectItems<T>(body: unknown): readonly T[] {
  const value = body as ItemsEnvelope<T> | null;
  return value !== null && Array.isArray(value.items) ? value.items : [];
}

function runPath(companyId: string, runId: string): string {
  return `platform/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}`;
}

/** Builds the query string for `GET /platform/runs`; unsupported filters are omitted, never faked. */
export function runsQuery(filters: RunFilters): string {
  const query = new URLSearchParams();
  if (filters.company_id.trim()) query.set('company_id', filters.company_id.trim());
  if (filters.state.trim()) query.set('state', filters.state.trim());
  if (filters.domain.trim()) query.set('domain', filters.domain.trim());
  if (filters.search.trim()) query.set('search', filters.search.trim());
  // The projection supports a single `before` bound; "đến ngày" maps to the end of that day.
  if (filters.to.trim()) query.set('before', `${filters.to.trim()}T23:59:59.999Z`);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

export interface RetryAccepted {
  readonly run_id: string;
  readonly status: string;
  readonly correlation_id: string;
}

export async function retryRun(
  companyId: string,
  runId: string,
  reason: string,
): Promise<RetryAccepted> {
  return platformJson<RetryAccepted>(`${runPath(companyId, runId)}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export interface ReconcileAccepted {
  readonly run_id: string;
  readonly resolution: string;
  readonly correlation_id: string;
}

export async function reconcileRun(
  companyId: string,
  runId: string,
  input: ReconciliationInput,
): Promise<ReconcileAccepted> {
  const body: Record<string, unknown> = { resolution: input.resolution, reason: input.reason };
  if (input.receipt !== undefined) body['receipt'] = input.receipt;
  return platformJson<ReconcileAccepted>(`${runPath(companyId, runId)}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

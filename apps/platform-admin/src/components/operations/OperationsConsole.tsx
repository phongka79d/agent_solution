/**
 * Platform operations console (T8.3): Lượt chạy · Đối soát · Bị kẹt.
 *
 * Reads go to the platform BFF projections; every action is unlocked by server-side eligibility
 * (`retry_eligible` / `retry_eligibility`), never by a client rule. Runs with an indeterminate
 * outcome surface reconciliation only.
 */

'use client';

import { useMemo, useState } from 'react';
import { ErrorBanner, Skeleton, StatusBadge, Tabs } from '@agentos/ui-foundation/react';
import { useApi } from '@agentos/ui-foundation/data';
import { t } from '@agentos/ui-foundation/i18n';
import { statusView } from '@agentos/ui-foundation/status';
import {
  OPERATIONS_PATHS,
  runsQuery,
  selectItems,
} from './api';
import { RunFilterControls } from './RunFilterControls';
import { RunTable } from './RunTable';
import { RetryRunModal } from './RetryRunModal';
import { ReconcileModal } from './ReconcileModal';
import { domainLabel, formatTimestamp, reconciliationReasonLabel } from './format';
import {
  EMPTY_RUN_FILTERS,
  type OperationsTab,
  type PlatformReconciliationItem,
  type PlatformRunListItem,
  type PlatformRunsSummaryRow,
  type RunFilters,
} from './types';

const POLL_MS = 10_000;
const STUCK_STATES: Readonly<Record<string, true>> = { queued: true, waiting: true, awaiting_human: true };

function SummaryTiles({ rows }: { readonly rows: readonly PlatformRunsSummaryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {rows.map((row) => {
        const view = statusView('run', row.state.toUpperCase());
        return (
          <div key={row.state} className="platform-card p-4" data-testid={`run-tile-${row.state}`}>
            <div className="flex items-center justify-between gap-2">
              <StatusBadge code={row.state.toUpperCase()} />
              <span className="text-lg font-semibold text-ink">{row.run_count}</span>
            </div>
            <p className="mt-2 text-xs text-muted">
              {row.tenant_count} công ty
              {row.retry_eligible_count > 0 ? ` · ${row.retry_eligible_count} có thể thử lại` : ''}
              {row.reconciliation_count > 0 ? ` · ${row.reconciliation_count} cần đối soát` : ''}
            </p>
            <span className="sr-only">{t(view.label_key)}</span>
          </div>
        );
      })}
    </div>
  );
}

function StuckTable({ runs }: { readonly runs: readonly PlatformRunListItem[] }) {
  if (runs.length === 0) {
    return <p className="platform-card p-5 text-sm text-muted">Không có lượt chạy nào đang xếp hàng quá lâu.</p>;
  }
  return (
    <div className="platform-card overflow-x-auto rounded-md border border-line" tabIndex={0}>
      <table className="ui-table min-w-[720px] text-xs" role="table">
        <thead>
          <tr>
            <th scope="col">Công ty</th>
            <th scope="col">Lượt chạy</th>
            <th scope="col">Lĩnh vực</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">Chờ từ</th>
            <th scope="col">Số lần thử</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.tenant_id}:${run.run_id}`} className="text-ink-body">
              <td className="max-w-[180px] truncate">{run.display_name}</td>
              <td className="max-w-[160px] truncate font-mono" title={run.run_id}>{run.run_id}</td>
              <td>{domainLabel(run.domain)}</td>
              <td><StatusBadge code={run.state.toUpperCase()} /></td>
              <td>{formatTimestamp(run.updated_at)}</td>
              <td className="ui-table__numeric">{run.attempts}/{run.max_retries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OperationsConsole() {
  const [activeTab, setActiveTab] = useState<OperationsTab>('runs');
  const [draft, setDraft] = useState<RunFilters>(EMPTY_RUN_FILTERS);
  const [applied, setApplied] = useState<RunFilters>(EMPTY_RUN_FILTERS);
  const [retryTarget, setRetryTarget] = useState<PlatformRunListItem | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<PlatformReconciliationItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const summary = useApi<readonly PlatformRunsSummaryRow[]>(`/api/v1/${OPERATIONS_PATHS.summary}`, {
    pollMs: POLL_MS,
    select: selectItems<PlatformRunsSummaryRow>,
  });
  const runs = useApi<readonly PlatformRunListItem[]>(`/api/v1/${OPERATIONS_PATHS.runs}${runsQuery(applied)}`, {
    pollMs: POLL_MS,
    enabled: activeTab !== 'reconcile',
    select: selectItems<PlatformRunListItem>,
  });
  const queue = useApi<readonly PlatformReconciliationItem[]>('/api/v1/platform/runs/reconciliation', {
    pollMs: POLL_MS,
    enabled: activeTab === 'reconcile',
    select: selectItems<PlatformReconciliationItem>,
  });

  const stuckRuns = useMemo(
    () => [...(runs.data ?? [])].filter((run) => STUCK_STATES[run.state] === true).sort((a, b) => a.updated_at.localeCompare(b.updated_at)),
    [runs.data],
  );

  // The lower date bound is not projected by the platform API, so only that bound narrows locally.
  const visibleRuns = useMemo(() => {
    const fromMs = applied.from.trim() ? new Date(`${applied.from}T00:00:00`).getTime() : null;
    return (runs.data ?? []).filter((run) => (
      fromMs === null || new Date(run.created_at).getTime() >= fromMs
    ));
  }, [runs.data, applied.from]);

  function refreshAll(): void {
    summary.refresh();
    runs.refresh();
    queue.refresh();
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Vận hành nền tảng</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">Vận hành</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          Theo dõi mọi lượt chạy trên toàn nền tảng, đối soát kết quả không xác định và xử lý công việc bị kẹt.
        </p>
      </header>

      {notice ? (
        <div role="status" className="platform-alert platform-alert--success flex items-center justify-between text-xs">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Đóng thông báo">&times;</button>
        </div>
      ) : null}

      {summary.error ? <ErrorBanner error={summary.error} onRetry={summary.refresh} /> : null}
      {summary.loading && summary.data === null ? <Skeleton variant="metric" lines={1} /> : null}
      {summary.data ? <SummaryTiles rows={summary.data} /> : null}

      <Tabs
        activeTabId={activeTab}
        onTabChange={(tabId) => setActiveTab(tabId as OperationsTab)}
        tabs={[
          {
            id: 'runs',
            label: 'Lượt chạy',
            content: (
              <div className="space-y-4">
                <RunFilterControls
                  filters={draft}
                  isLoading={runs.loading}
                  onChange={setDraft}
                  onApply={() => setApplied(draft)}
                  onReset={() => { setDraft(EMPTY_RUN_FILTERS); setApplied(EMPTY_RUN_FILTERS); }}
                />
                {runs.error ? <ErrorBanner error={runs.error} onRetry={runs.refresh} /> : null}
                {runs.loading && runs.data === null
                  ? <Skeleton variant="table" lines={6} />
                  : (
                    <RunTable
                      runs={visibleRuns}
                      isLoading={runs.loading}
                      onRetry={setRetryTarget}
                      onReconcile={(run) => setReconcileTarget(reconciliationFromRun(run))}
                    />
                  )}
              </div>
            ),
          },
          {
            id: 'reconcile',
            label: 'Đối soát',
            content: (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  Các lượt chạy có kết quả chưa xác định hoặc đã hết số lần thử. Không bao giờ thử lại trực tiếp — hãy đối soát bằng mã hiệu ứng.
                </p>
                {queue.error ? <ErrorBanner error={queue.error} onRetry={queue.refresh} /> : null}
                {queue.loading && queue.data === null ? <Skeleton variant="table" lines={6} /> : (
                  <div className="platform-card overflow-x-auto rounded-md border border-line" tabIndex={0}>
                    <table className="ui-table min-w-[820px] text-xs" role="table">
                      <thead>
                        <tr>
                          <th scope="col">Cập nhật</th>
                          <th scope="col">Công ty</th>
                          <th scope="col">Lượt chạy</th>
                          <th scope="col">Lĩnh vực</th>
                          <th scope="col">Lý do</th>
                          <th scope="col" className="ui-table__numeric">Số lần thử</th>
                          <th scope="col" className="text-right">Hành động</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(queue.data ?? []).length === 0 && (
                          <tr><td colSpan={7} className="text-center text-muted">Không có lượt chạy cần đối soát.</td></tr>
                        )}
                        {(queue.data ?? []).map((item) => (
                          <tr key={`${item.tenant_id}:${item.run_id}`} className="text-ink-body">
                            <td className="whitespace-nowrap">{formatTimestamp(item.updated_at)}</td>
                            <td className="max-w-[180px] truncate">{item.display_name}</td>
                            <td className="max-w-[160px] truncate font-mono" title={item.run_id}>{item.run_id}</td>
                            <td>{domainLabel(item.domain)}</td>
                            <td>{reconciliationReasonLabel(item.reason)}</td>
                            <td className="ui-table__numeric">{item.attempts}/{item.max_retries}</td>
                            <td className="text-right">
                              <button type="button" className="ui-button ui-button--primary ui-button--compact" onClick={() => setReconcileTarget(item)}>
                                Đối soát
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ),
          },
          {
            id: 'stuck',
            label: 'Bị kẹt',
            content: (
              <div className="space-y-4">
                <p className="text-sm text-muted">Lượt chạy đang xếp hàng hoặc chờ xử lý, xếp theo thời điểm cập nhật cũ nhất.</p>
                {runs.error ? <ErrorBanner error={runs.error} onRetry={runs.refresh} /> : null}
                {runs.loading && runs.data === null ? <Skeleton variant="table" lines={5} /> : <StuckTable runs={stuckRuns} />}
              </div>
            ),
          },
        ]}
      />

      {retryTarget ? (
        <RetryRunModal
          run={retryTarget}
          onClose={() => setRetryTarget(null)}
          onSuccess={(message) => { setNotice(message); refreshAll(); }}
        />
      ) : null}
      {reconcileTarget ? (
        <ReconcileModal
          item={reconcileTarget}
          onClose={() => setReconcileTarget(null)}
          onSuccess={(message) => { setNotice(message); refreshAll(); }}
        />
      ) : null}

      {runs.validating || queue.validating ? (
        <p className="text-center text-[11px] text-muted" role="status">{t('common.loading')}</p>
      ) : null}
    </div>
  );
}

/** Adapts a run row to the minimal reconciliation shape keyed by run, used when the queue omits it. */
function reconciliationFromRun(run: PlatformRunListItem): PlatformReconciliationItem {
  return {
    tenant_id: run.tenant_id,
    display_name: run.display_name,
    run_id: run.run_id,
    domain: run.domain,
    state: run.state,
    failure_class: run.failure_class,
    attempts: run.attempts,
    max_retries: run.max_retries,
    reason: 'INDETERMINATE_OUTCOME',
    correlation_id: run.correlation_id,
    updated_at: run.updated_at,
  };
}

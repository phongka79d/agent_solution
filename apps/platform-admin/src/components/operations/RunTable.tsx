/**
 * Cross-company run table (T8.3): every column is a server projection field and every action is
 * gated by the server `retry_eligible` flag. Indeterminate failures expose reconciliation only.
 */

'use client';

import Link from 'next/link';
import { StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import type { PlatformRunListItem } from './types';
import { failureLabel, formatDuration, formatTimestamp } from './format';

interface RunTableProps {
  readonly runs: readonly PlatformRunListItem[];
  readonly isLoading: boolean;
  readonly onRetry: (run: PlatformRunListItem) => void;
  readonly onReconcile: (run: PlatformRunListItem) => void;
}

export function RunTable({ runs, isLoading, onRetry, onReconcile }: RunTableProps) {
  return (
    <div className="platform-card overflow-x-auto rounded-md border border-line" tabIndex={0}>
      <table className="ui-table min-w-[1100px] text-xs" role="table">
        <caption className="sr-only">Danh sách lượt chạy trên toàn nền tảng</caption>
        <thead>
          <tr>
            <th scope="col">Thời gian</th>
            <th scope="col">Công ty</th>
            <th scope="col">Lĩnh vực</th>
            <th scope="col" className="ui-table__numeric">Giai đoạn</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">Nguyên nhân lỗi</th>
            <th scope="col" className="ui-table__numeric">Thời lượng</th>
            <th scope="col" className="ui-table__numeric">Chi phí</th>
            <th scope="col" className="ui-table__numeric">Số lần thử</th>
            <th scope="col" className="text-right">Hành động</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && !isLoading && (
            <tr>
              <td colSpan={10} className="text-center text-muted">Không có lượt chạy phù hợp với bộ lọc.</td>
            </tr>
          )}
          {runs.map((run) => {
            return (
              <tr key={`${run.tenant_id}:${run.run_id}`} className="text-ink-body hover:bg-surface-low">
                <td className="whitespace-nowrap">{formatTimestamp(run.created_at)}</td>
                <td className="max-w-[180px] truncate" title={run.display_name}>{run.display_name}</td>
                <td>{run.domain}</td>
                <td className="ui-table__numeric text-muted">{run.current_step}</td>
                <td><StatusBadge code={run.state.toUpperCase()} /></td>
                <td className="max-w-[200px] truncate" title={run.failure_class ?? ''}>{failureLabel(run.failure_class)}</td>
                <td className="ui-table__numeric">{formatDuration(run.duration_ms)}</td>
                <td className="ui-table__numeric text-muted" title="Chi phí không có trong thống kê lượt chạy">—</td>
                <td className="ui-table__numeric">{run.attempts}/{run.max_retries}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Link className="ui-button ui-button--secondary ui-button--compact" href={`/operations/runs/${encodeURIComponent(run.tenant_id)}/${encodeURIComponent(run.run_id)}`}>
                      Chi tiết
                    </Link>
                    {run.retry_eligible ? (
                      <button type="button" className="ui-button ui-button--danger ui-button--compact" onClick={() => onRetry(run)}>
                        Thử lại
                      </button>
                    ) : run.state === 'waiting' ? (
                      // The server reconciles only a parked (waiting) run; other runs offer no action.
                      <button type="button" className="ui-button ui-button--secondary ui-button--compact" onClick={() => onReconcile(run)}>
                        Đối soát
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isLoading && <p role="status" className="p-3 text-center text-xs text-muted">{t('common.loading')}</p>}
    </div>
  );
}

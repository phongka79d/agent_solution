/**
 * Interactive list displaying pending AUTH-4 approval requests with risk metrics,
 * distinct visual presentation for AWAITING_HUMAN vs PAUSED, and instrumented expiry display.
 */
'use client';

import type { ApprovalItem } from './types';

interface ApprovalQueueListProps {
  readonly items: readonly ApprovalItem[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onRetry?: (() => void) | undefined;
}

export function ApprovalQueueList({
  items,
  selectedId,
  onSelect,
  isLoading,
  error,
  onRetry,
}: ApprovalQueueListProps) {
  const getStatusBadge = (status: ApprovalItem['status']) => {
    switch (status) {
      case 'AWAITING_HUMAN':
        return 'tenant-approval-status--warning';
      case 'PAUSED':
        return 'tenant-approval-status--info';
      case 'APPROVED':
        return 'tenant-approval-status--success';
      case 'MODIFIED':
        return 'tenant-approval-status--ai';
      case 'REJECTED':
        return 'tenant-approval-status--danger';
      case 'CANCELLED':
      default:
        return 'tenant-approval-status--neutral';
    }
  };

  const getStatusLabel = (item: ApprovalItem) => {
    if (item.isPaused || item.status === 'PAUSED') return 'Tạm dừng';
    if (item.status === 'AWAITING_HUMAN') return 'Chờ phê duyệt';
    if (item.status === 'APPROVED') return 'Đã phê duyệt';
    if (item.status === 'REJECTED') return 'Đã từ chối';
    if (item.status === 'MODIFIED') return 'Đã sửa';
    if (item.status === 'CANCELLED') return 'Đã hủy';
    if (item.status === 'QUEUED') return 'Đang xử lý';
    return 'Chưa phân loại';
  };
  const ageLabel = (createdAt: string): string => {
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return 'Mới';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 60) return `${minutes} phút trước`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} giờ trước`;
    return `${Math.floor(hours / 24)} ngày trước`;
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="ui-state ui-state--loading">
        <span className="ui-loading-state__icon" aria-hidden="true" />
        <p className="text-sm text-muted">
          Loading pending AUTH-4 approvals from R14 GET /api/v1/approvals...
        </p>
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="ui-state ui-state--error text-center">
        <p className="mb-2 text-sm font-semibold text-danger">Failed to load approvals queue</p>
        <p className="mb-4 break-words font-mono text-xs text-muted">{error}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry} className="ui-button ui-button--secondary ui-button--sm">
            Retry Queue Read
          </button>
        ) : null}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="ui-empty-state">
        <p className="ui-empty-state__title">Queue Empty</p>
        <p className="ui-empty-state__description">No AUTH-4 operations currently awaiting human review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3" role="list" aria-label="Pending Approvals">
      {items.map((item) => {
        const isSelected = item.id === selectedId;
        const minutesLeft = item.expiresAt
          ? Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 60000))
          : null;

        return (
          <div
            key={item.id}
            role="listitem"
            tabIndex={0}
            onClick={() => onSelect(item.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item.id);
              }
            }}
            className={`tenant-approval-row ui-focus-ring ${isSelected ? 'tenant-approval-row--selected' : ''}`}
          >
            <div className="flex justify-between items-start mb-2 gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="tenant-approval-row__id">#{item.id}</span>
                  <span className="tenant-approval-row__title">
                    {item.title || 'Đề xuất cần phê duyệt'}
                  </span>
                </div>
              </div>
              <span className={`tenant-approval-status ${getStatusBadge(item.status)}`}>
                {getStatusLabel(item)}
              </span>
            </div>

            <p className="tenant-approval-row__reason">
              <span>Vì sao:</span>
              {item.reason}
            </p>

            <div className="tenant-approval-row__meta">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Soạn bởi: <strong>{item.requestingAgentName ?? item.agentId}</strong>
                </span>
                {item.domain ? <span>Phạm vi: <strong>{item.domain}</strong></span> : null}
                <span>{ageLabel(item.createdAt)}</span>
              </div>
              <div className="text-right">
                {minutesLeft === null ? (
                  <span>Không có hạn xử lý</span>
                ) : (
                  <span>
                    Còn{' '}
                    <strong className={minutesLeft < 10 ? 'text-danger font-bold' : 'text-warning font-semibold'}>
                      {minutesLeft} phút
                    </strong>
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

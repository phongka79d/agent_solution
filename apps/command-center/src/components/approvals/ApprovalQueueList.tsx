/**
 * @file apps/command-center/src/components/approvals/ApprovalQueueList.tsx
 * Interactive list displaying pending AUTH-4 approval requests with risk metrics,
 * distinct visual presentation for AWAITING_HUMAN vs PAUSED, and instrumented expiry display.
 */
'use client';

import React from 'react';
import type { ApprovalItem } from './types';

interface ApprovalQueueListProps {
  readonly items: readonly ApprovalItem[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onRetry?: () => void;
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
        return 'bg-amber-950/80 text-amber-300 border-amber-600 animate-pulse';
      case 'PAUSED':
        return 'bg-sky-950/80 text-sky-300 border-sky-600';
      case 'APPROVED':
        return 'bg-emerald-950/80 text-emerald-300 border-emerald-600';
      case 'MODIFIED':
        return 'bg-teal-950/80 text-teal-300 border-teal-600';
      case 'REJECTED':
        return 'bg-rose-950/80 text-rose-300 border-rose-600';
      case 'CANCELLED':
        return 'bg-slate-800 text-slate-400 border-slate-700';
      default:
        return 'bg-slate-800 text-slate-300 border-slate-700';
    }
  };

  const getStatusLabel = (item: ApprovalItem) => {
    if (item.isPaused || item.status === 'PAUSED') {
      return 'PAUSED (UNDECIDED)';
    }
    if (item.status === 'AWAITING_HUMAN') {
      return 'AWAITING_HUMAN';
    }
    return item.status;
  };

  if (isLoading && items.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-900/60 border border-slate-800 rounded-xl">
        <div className="inline-block w-6 h-6 border-2 border-amber-400 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-xs text-slate-400 font-mono tracking-wide">
          loading: Fetching pending AUTH-4 approvals from R14 GET /api/v1/approvals...
        </p>
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="p-6 bg-rose-950/30 border border-rose-800/80 rounded-xl text-center">
        <p className="text-sm font-semibold text-rose-300 mb-2">Failed to load approvals queue</p>
        <p className="text-xs text-rose-400 font-mono mb-4 break-words">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-3 py-1.5 text-xs font-semibold bg-rose-900/60 hover:bg-rose-800 text-rose-200 border border-rose-700 rounded transition-colors"
          >
            Retry Queue Read
          </button>
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-900/40 border border-dashed border-slate-800 rounded-xl">
        <p className="text-sm font-semibold text-slate-300 mb-1">Queue Empty</p>
        <p className="text-xs text-slate-500 font-mono">
          empty: No AUTH-4 operations currently awaiting human review.
        </p>
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
            className={`p-4 rounded-xl border cursor-pointer transition-all focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              isSelected
                ? 'bg-slate-850 border-sky-500 shadow-lg shadow-sky-950/50'
                : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
            }`}
          >
            <div className="flex justify-between items-start mb-2 gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs font-mono px-1.5 py-0.5 bg-slate-950 rounded border border-slate-800 text-slate-300">
                    #{item.id}
                  </span>
                  <span className="font-semibold text-sm text-slate-100 truncate">
                    {item.title || `AUTH-4 Review: ${item.agentId}`}
                  </span>
                </div>
              </div>
              <span
                className={`px-2.5 py-1 text-[11px] font-mono font-semibold rounded-full border whitespace-nowrap ${getStatusBadge(
                  item.status
                )}`}
              >
                {getStatusLabel(item)}
              </span>
            </div>

            <p className="text-xs text-slate-300 mb-3 line-clamp-2">
              <span className="text-slate-500 font-mono mr-1">Risk:</span>
              {item.reason}
            </p>

            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-850/60">
              <div className="flex items-center gap-3 flex-wrap">
                <span>
                  Agent: <strong className="text-slate-200">{item.agentId}</strong>
                </span>
                <span>
                  Run ID:{' '}
                  <strong className="text-slate-300">
                    {item.runId ? item.runId.slice(0, 12) : '—'}
                  </strong>
                </span>
                {item.effectKey && (
                  <span className="text-slate-500 hidden sm:inline">
                    Effect: {item.effectKey.slice(0, 8)}…
                  </span>
                )}
              </div>
              <div className="text-right">
                {minutesLeft === null ? (
                  <span className="text-slate-500">Expiry: not instrumented</span>
                ) : (
                  <span>
                    TTL:{' '}
                    <strong
                      className={
                        minutesLeft < 10
                          ? 'text-rose-400 font-bold'
                          : 'text-amber-400 font-semibold'
                      }
                    >
                      {minutesLeft}m
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

/**
 * @file apps/command-center/src/components/operations/RunTable.tsx
 * Keyboard-accessible virtualized/paginated tabular view of R16 agent run history.
 */

import React from 'react';
import type { AgentRunProjection } from './types';
import { isRunRetryable } from './retry-helpers';

interface RunTableProps {
  readonly runs: readonly AgentRunProjection[];
  readonly isLoading: boolean;
  readonly selectedRunId: string | null;
  readonly onSelectRun: (run: AgentRunProjection) => void;
  readonly onRetryRun: (run: AgentRunProjection) => void;
  readonly nextCursor: string | null | undefined;
  readonly cursorStackLength: number;
  readonly onNextPage: () => void;
  readonly onPrevPage: () => void;
  readonly totalCount?: number;
}

function getStateBadgeClass(state: string): string {
  switch (state) {
    case 'completed':
    case 'success':
      return 'bg-emerald-950/70 text-emerald-300 border-emerald-800';
    case 'failed':
      return 'bg-rose-950/70 text-rose-300 border-rose-800';
    case 'running':
    case 'executing':
      return 'bg-sky-950/70 text-sky-300 border-sky-800 animate-pulse';
    case 'queued':
    case 'waiting':
      return 'bg-amber-950/70 text-amber-300 border-amber-800';
    case 'awaiting_human':
      return 'bg-purple-950/70 text-purple-300 border-purple-800';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export function RunTable({
  runs,
  isLoading,
  selectedRunId,
  onSelectRun,
  onRetryRun,
  nextCursor,
  cursorStackLength,
  onNextPage,
  onPrevPage,
  totalCount,
}: RunTableProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="font-mono">
          Showing {runs.length} run{runs.length === 1 ? '' : 's'}
          {typeof totalCount === 'number' ? ` of ${totalCount}` : ''}
        </span>
        {isLoading && <span className="font-mono text-sky-400 animate-pulse">Syncing R16...</span>}
      </div>

      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="w-full text-left text-xs border-collapse font-mono" role="table">
          <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
            <tr>
              <th scope="col" className="px-3 py-2.5">Run ID</th>
              <th scope="col" className="px-3 py-2.5">Agent</th>
              <th scope="col" className="px-3 py-2.5">State</th>
              <th scope="col" className="px-3 py-2.5">Steps</th>
              <th scope="col" className="px-3 py-2.5">Latency</th>
              <th scope="col" className="px-3 py-2.5">Cost</th>
              <th scope="col" className="px-3 py-2.5">Retry</th>
              <th scope="col" className="px-3 py-2.5">Error Class</th>
              <th scope="col" className="px-3 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 bg-slate-900/40">
            {runs.length === 0 && !isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-slate-500 font-sans">
                  No run executions found matching active criteria.
                </td>
              </tr>
            )}
            {runs.map((run) => {
              const isSelected = selectedRunId === run.run_id;
              const canRetry = isRunRetryable(run);
              const stepCount = run.steps?.length ?? run.current_step ?? 0;

              return (
                <tr
                  key={run.run_id}
                  tabIndex={0}
                  aria-selected={isSelected}
                  onClick={() => onSelectRun(run)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRun(run);
                    }
                  }}
                  className={`cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 ${
                    isSelected
                      ? 'bg-sky-950/40 text-slate-100'
                      : 'hover:bg-slate-800/50 text-slate-300'
                  }`}
                >
                  <td className="px-3 py-2 text-sky-400 font-semibold truncate max-w-[120px]" title={run.run_id}>
                    {run.run_id.slice(0, 8)}...
                  </td>
                  <td className="px-3 py-2 text-slate-200 font-semibold">{run.agent_id}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${getStateBadgeClass(run.state)}`}>
                      {run.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{stepCount}</td>
                  <td className="px-3 py-2 text-slate-300">
                    {typeof run.latency_ms === 'number' ? `${run.latency_ms}ms` : '-'}
                  </td>
                  <td className="px-3 py-2 text-slate-300">
                    {typeof run.cost === 'number' ? `$${run.cost.toFixed(4)}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-slate-400">r{run.retry_count}</td>
                  <td className="px-3 py-2 text-slate-400 max-w-[130px] truncate" title={run.last_error_class || ''}>
                    {run.last_error_class || '-'}
                  </td>
                  <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1.5 font-sans">
                      <button
                        type="button"
                        onClick={() => onSelectRun(run)}
                        className="rounded px-2 py-1 text-[11px] font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
                      >
                        Inspect
                      </button>
                      <button
                        type="button"
                        disabled={!canRetry}
                        onClick={() => onRetryRun(run)}
                        title={canRetry ? 'Execute safe operator retry' : 'Retry unavailable (only verified side-effect-free failures can be retried)'}
                        className={`rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 ${
                          canRetry
                            ? 'bg-rose-900/60 text-rose-200 hover:bg-rose-800 border border-rose-700 focus-visible:ring-rose-400'
                            : 'bg-slate-800/40 text-slate-600 cursor-not-allowed border border-transparent'
                        }`}
                      >
                        Retry
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-2 text-xs">
        <button
          type="button"
          onClick={onPrevPage}
          disabled={cursorStackLength === 0 || isLoading}
          className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
        >
          &larr; Previous Page
        </button>
        <span className="text-[11px] font-mono text-slate-500">
          Page {cursorStackLength + 1}
        </span>
        <button
          type="button"
          onClick={onNextPage}
          disabled={!nextCursor || isLoading}
          className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
        >
          Next Page &rarr;
        </button>
      </div>
    </div>
  );
}

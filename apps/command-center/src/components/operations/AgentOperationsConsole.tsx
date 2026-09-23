/**
 * @file apps/command-center/src/components/operations/AgentOperationsConsole.tsx
 * Root client component for SCR-002: Agent Operations Console.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiClient, ApiError } from '../../lib/api-client';
import type { SharedUiState } from '../../lib/api-types';
import type { AgentRunProjection, GetRunsParams, RunFilters, TaskAcceptedResponse } from './types';
import { AgentDirectory } from './AgentDirectory';
import { RunFilterControls } from './RunFilterControls';
import { RunTable } from './RunTable';
import { RunInspectionDrawer } from './RunInspectionDrawer';
import { RetryRunModal } from './RetryRunModal';

const DEFAULT_FILTERS: RunFilters = {
  agent_id: '',
  state: '',
  status: '',
  from: '',
  to: '',
  limit: 20,
};

export function AgentOperationsConsole() {
  const [runs, setRuns] = useState<readonly AgentRunProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined);
  const [totalCount, setTotalCount] = useState<number | undefined>(undefined);

  const [filters, setFilters] = useState<RunFilters>(DEFAULT_FILTERS);
  const [uiState, setUiState] = useState<SharedUiState>('loading');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [selectedRun, setSelectedRun] = useState<AgentRunProjection | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<AgentRunProjection | null>(null);
  const [retrySuccessNotice, setRetrySuccessNotice] = useState<string | null>(null);

  const fetchRuns = useCallback(
    async (cursor?: string) => {
      setUiState('loading');
      setStatusMessage(null);

      try {
        const queryParams: GetRunsParams = {
          limit: filters.limit,
          ...(cursor ? { cursor } : {}),
          ...(filters.agent_id.trim() ? { agent_id: filters.agent_id.trim() } : {}),
          ...(filters.state.trim() ? { state: filters.state.trim() } : {}),
          ...(filters.status.trim() ? { status: filters.status.trim() } : {}),
          ...(filters.from.trim() ? { from: filters.from.trim() } : {}),
          ...(filters.to.trim() ? { to: filters.to.trim() } : {}),
        };
        const res = await apiClient.getRuns(queryParams);

        const returnedRuns = res.items;
        setRuns(returnedRuns);
        setNextCursor(res.next_cursor);
        setTotalCount(res.total_count);
        setCurrentCursor(cursor);

        if (returnedRuns.length === 0) {
          setUiState('empty');
          setStatusMessage('No agent runs returned matching current filter parameters.');
        } else {
          setUiState('idle');
        }
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          if (err.status === 401 || err.status === 403) {
            setUiState('permission_denied');
            setStatusMessage(`[${err.errorCode}] Permission Denied: ${err.message}`);
          } else if (err.status >= 502 && err.status <= 504) {
            setUiState('dependency_unavailable');
            setStatusMessage(`[${err.errorCode}] Upstream Gateway Unavailable: ${err.message}`);
          } else {
            setUiState('fail_closed');
            setStatusMessage(`[${err.errorCode}] System Error: ${err.message}`);
          }
        } else {
          setUiState('dependency_unavailable');
          setStatusMessage('Network connectivity error reaching /api/v1/runs');
        }
        setRuns([]);
      }
    },
    [filters]
  );

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorStack((prev) => (currentCursor ? [...prev, currentCursor] : [...prev, '']));
    fetchRuns(nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorStack.length === 0) return;
    const prevCursor = cursorStack[cursorStack.length - 1];
    setCursorStack((prev) => prev.slice(0, -1));
    fetchRuns(prevCursor || undefined);
  };

  const handleFilterChange = (newFilters: RunFilters) => {
    setFilters(newFilters);
  };

  const handleSelectAgent = (agent_id: string) => {
    setFilters((prev) => ({ ...prev, agent_id }));
  };

  const handleRetrySuccess = (receipt: TaskAcceptedResponse) => {
    setRetrySuccessNotice(
      `Task accepted for re-dispatch (Task ID: ${receipt.task_id}, Version: ${receipt.task_version}, Status: ${receipt.status})`
    );
    fetchRuns(currentCursor);
  };

  return (
    <div className="flex flex-col gap-5 p-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-1 border-b border-slate-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold font-mono text-slate-100">SCR-002: Agent Operations Console</h1>
          <p className="text-xs text-slate-400">R16 run telemetry inspection &amp; R13 verified safe retry control</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-500 uppercase">State:</span>
          <span className={`px-2 py-0.5 rounded text-xs font-mono font-semibold border ${
            uiState === 'loading' ? 'bg-sky-950 text-sky-300 border-sky-800' :
            uiState === 'empty' ? 'bg-slate-800 text-slate-400 border-slate-700' :
            uiState === 'permission_denied' ? 'bg-rose-950 text-rose-300 border-rose-800' :
            uiState === 'dependency_unavailable' ? 'bg-orange-950 text-orange-300 border-orange-800' :
            uiState === 'fail_closed' ? 'bg-red-950 text-red-200 border-red-700' :
            'bg-slate-900 text-slate-300 border-slate-800'
          }`}>
            {uiState}
          </span>
        </div>
      </div>

      {statusMessage && (
        <div role="status" className={`rounded p-3 text-xs font-mono border ${
          uiState === 'permission_denied' || uiState === 'fail_closed' ? 'bg-rose-950/60 border-rose-800 text-rose-300' :
          uiState === 'dependency_unavailable' ? 'bg-orange-950/60 border-orange-800 text-orange-300' :
          'bg-slate-900 border-slate-800 text-slate-400'
        }`}>
          {statusMessage}
        </div>
      )}

      {retrySuccessNotice && (
        <div role="status" className="flex items-center justify-between rounded bg-emerald-950/60 border border-emerald-800 p-3 text-xs text-emerald-300 font-mono">
          <span>{retrySuccessNotice}</span>
          <button type="button" onClick={() => setRetrySuccessNotice(null)} className="text-emerald-400 hover:text-emerald-200">&times;</button>
        </div>
      )}

      <AgentDirectory runs={runs} selectedAgentId={filters.agent_id} onSelectAgent={handleSelectAgent} />

      <RunFilterControls
        filters={filters}
        onChange={handleFilterChange}
        onApply={() => { setCursorStack([]); fetchRuns(); }}
        onReset={() => { setFilters(DEFAULT_FILTERS); setCursorStack([]); }}
        isLoading={uiState === 'loading'}
      />

      <RunTable
        runs={runs}
        isLoading={uiState === 'loading'}
        selectedRunId={selectedRun?.run_id ?? null}
        onSelectRun={(run) => { setSelectedRun(run); setIsDrawerOpen(true); }}
        onRetryRun={(run) => setRetryTarget(run)}
        nextCursor={nextCursor}
        cursorStackLength={cursorStack.length}
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
        totalCount={totalCount}
      />

      <RunInspectionDrawer
        run={selectedRun}
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onRetry={(run) => setRetryTarget(run)}
      />

      <RetryRunModal
        run={retryTarget}
        isOpen={Boolean(retryTarget)}
        onClose={() => setRetryTarget(null)}
        onSuccess={handleRetrySuccess}
      />
    </div>
  );
}

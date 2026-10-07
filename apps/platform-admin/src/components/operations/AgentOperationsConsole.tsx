/**
 * Root client component for SCR-002: Agent Operations Console.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ApiError, type SharedUiState } from '@agentos/ui-foundation';
import { StatusBadge, PageHeader } from '@agentos/ui-foundation/react';
import type { Tone } from '@agentos/ui-foundation/status';
import { adminOperationsClient } from '../../lib/admin-operations-client';
import type { AgentRunProjection, GetRunsParams, RunFilters, TaskAcceptedResponse } from './types';
import { AgentDirectory } from './AgentDirectory';
import { RunFilterControls } from './RunFilterControls';
import { RunTable } from './RunTable';
import { RunInspectionDrawer } from './RunInspectionDrawer';
import { RetryRunModal } from './RetryRunModal';
function stateTone(state: SharedUiState): Tone {
  switch (state) {
    case 'loading': return 'info';
    case 'empty': return 'neutral';
    case 'permission_denied': return 'danger';
    case 'dependency_unavailable': return 'warning';
    case 'version_conflict': return 'warning';
    case 'fail_closed': return 'danger';
    case 'stale': return 'warning';
    case 'partial': return 'warning';
    default: return 'neutral';
  }
}
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
  const filtersRef = useRef(filters);
  const requestInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [uiState, setUiState] = useState<SharedUiState>('loading');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<AgentRunProjection | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<AgentRunProjection | null>(null);
  const [retrySuccessNotice, setRetrySuccessNotice] = useState<string | null>(null);

  const fetchRuns = useCallback(async (cursor?: string, append = false) => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUiState('loading');
    setStatusMessage(null);
    const activeFilters = filtersRef.current;
    try {
      const queryParams: GetRunsParams = {
        limit: activeFilters.limit,
        ...(cursor ? { cursor } : {}),
        ...(activeFilters.agent_id.trim() ? { agent_id: activeFilters.agent_id.trim() } : {}),
        ...(activeFilters.state.trim() ? { state: activeFilters.state.trim() } : {}),
        ...(activeFilters.status.trim() ? { status: activeFilters.status.trim() } : {}),
        ...(activeFilters.from.trim() ? { from: activeFilters.from.trim() } : {}),
        ...(activeFilters.to.trim() ? { to: activeFilters.to.trim() } : {}),
      };
      const res = await adminOperationsClient.getRuns(queryParams, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRuns((previous) => append ? [...previous, ...res.items] : res.items);
      setNextCursor(res.next_cursor);
      setTotalCount(res.total_count);
      setCurrentCursor(cursor);
      setUiState(res.items.length === 0 && !append ? 'empty' : 'idle');
      if (res.items.length === 0 && !append) setStatusMessage('Chưa có dữ liệu');
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError) {
        setUiState(err.status === 401 || err.status === 403 ? 'permission_denied' : err.status >= 502 && err.status <= 504 ? 'dependency_unavailable' : 'fail_closed');
        setStatusMessage(err.message);
      } else {
        setUiState('dependency_unavailable');
        setStatusMessage('Không thể tải dữ liệu.');
      }
      if (!append) setRuns([]);
    } finally {
      if (abortRef.current === controller) {
        requestInFlightRef.current = false;
        abortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    filtersRef.current = filters;
    const timer = window.setTimeout(() => {
      setCursorStack([]);
      void fetchRuns();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters, fetchRuns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleNextPage = () => {
    if (!nextCursor || requestInFlightRef.current) return;
    setCursorStack((previous) => [...previous, currentCursor ?? '']);
    void fetchRuns(nextCursor, true);
  };
  const handlePrevPage = () => {
    if (cursorStack.length === 0 || requestInFlightRef.current) return;
    const previousCursor = cursorStack[cursorStack.length - 1];
    setCursorStack((previous) => previous.slice(0, -1));
    void fetchRuns(previousCursor || undefined);
  };
  const handleFilterChange = (newFilters: RunFilters) => {
    filtersRef.current = newFilters;
    setFilters(newFilters);
  };
  const handleSelectAgent = (agent_id: string) => {
    handleFilterChange({ ...filtersRef.current, agent_id });
  };
  const handleRetrySuccess = (receipt: TaskAcceptedResponse) => {
    setRetrySuccessNotice(`Task accepted: ${receipt.task_id}`);
    void fetchRuns(currentCursor);
  };
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Platform operations" title="Tenant vận hành demo" description="Tenant vận hành demo · Tenant-scoped run inspection, cursor filters, and verified safe retry controls." actions={<StatusBadge label={`State: ${uiState.replaceAll('_', ' ')}`} tone={stateTone(uiState)} />} />

      {statusMessage && (
        <div role="status" className={`platform-alert font-mono text-xs ${
          uiState === 'permission_denied' || uiState === 'fail_closed' ? 'platform-alert--danger' :
          uiState === 'dependency_unavailable' ? 'platform-alert--warning' :
          'bg-surface-low text-muted'
        }`}>
          {statusMessage}
        </div>
      )}

      {retrySuccessNotice && (
        <div role="status" className="platform-alert platform-alert--success flex items-center justify-between font-mono text-xs">
          <span>{retrySuccessNotice}</span>
          <button type="button" onClick={() => setRetrySuccessNotice(null)} className="text-success hover:text-brand-deep">&times;</button>
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

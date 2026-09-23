/**
 * @file apps/command-center/src/app/page.tsx
 * Root page pointing directly to the SCR-001 Executive Dashboard.
 * Operates on real /api/v1 contracts; never invents fake metrics or demo numbers.
 * Displays explicit loading, empty, stale, permission_denied, version_conflict,
 * and fail_closed states.
 */
'use client';

import React, { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiClient, ApiError } from '../lib/api-client';
import type { SharedUiState } from '../lib/status';
import { getSharedUiStateBadgeClass, SHARED_UI_STATE_LABELS } from '../lib/status';
import { MetricCardGrid } from '../components/executive/MetricCardGrid';
import type { KpiMetricItem, SourceStatus } from '../components/executive/types';

function ExecutiveDashboardContent() {
  const searchParams = useSearchParams();
  const windowParam = searchParams.get('window') || '24h';
  const tenantIdParam = searchParams.get('tenant_id') || searchParams.get('tenantId') || undefined;

  const [metrics, setMetrics] = useState<KpiMetricItem[]>([]);
  const [uiState, setUiState] = useState<SharedUiState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);

  const fetchKpiSnapshot = useCallback(async () => {
    setUiState('loading');
    setErrorMessage(null);

    try {
      const response = await apiClient.getKpiSnapshot(
        { window: windowParam },
        { tenantId: tenantIdParam }
      );

      // Normalize response metrics into KpiMetricItem[] format
      const rawMetrics = response.metrics;
      const normalizedMetrics: KpiMetricItem[] = [];

      if (Array.isArray(rawMetrics)) {
        for (const item of rawMetrics) {
          if (item && typeof item === 'object') {
            normalizedMetrics.push({
              metric: item.metric || item.name || '',
              value: item.value ?? null,
              source_status: (item.source_status as SourceStatus) || 'NO_DATA',
              observed_at: item.observed_at || response.observed_at || null,
              window: item.window || response.window,
              timezone: item.timezone || response.timezone,
              provisional: item.provisional,
              reason: item.reason || item.note,
            });
          }
        }
      } else if (rawMetrics && typeof rawMetrics === 'object') {
        for (const [key, val] of Object.entries(rawMetrics)) {
          if (val && typeof val === 'object') {
            const typedVal = val as Record<string, unknown>;
            normalizedMetrics.push({
              metric: (typedVal.metric as string) || (typedVal.name as string) || key,
              value: (typedVal.value as number | string | null) ?? null,
              source_status: (typedVal.source_status as SourceStatus) || 'NO_DATA',
              observed_at: (typedVal.observed_at as string) || response.observed_at || null,
              window: (typedVal.window as string) || response.window,
              timezone: (typedVal.timezone as string) || response.timezone,
              provisional: typedVal.provisional as boolean | undefined,
              reason: (typedVal.reason as string) || (typedVal.note as string),
            });
          }
        }
      }

      setObservedAt(response.observed_at || null);
      setMetrics(normalizedMetrics);

      if (normalizedMetrics.length === 0) {
        setUiState('empty');
      } else {
        const hasLive = normalizedMetrics.some((m) => m.source_status === 'LIVE');
        setUiState(hasLive ? 'idle' : 'stale');
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setCorrelationId(err.correlationId || null);
        if (err.status === 401 || err.status === 403) {
          setUiState('permission_denied');
          setErrorMessage(err.message || 'Access denied to telemetry stream.');
        } else if (err.status === 409) {
          setUiState('version_conflict');
          setErrorMessage(err.message || 'Telemetry schema version conflict.');
        } else if (err.status >= 500) {
          setUiState('dependency_unavailable');
          setErrorMessage(err.message || 'Telemetry upstream service unavailable.');
        } else {
          setUiState('fail_closed');
          setErrorMessage(err.message || 'Failed to retrieve telemetry snapshot.');
        }
      } else {
        setUiState('fail_closed');
        setErrorMessage(err instanceof Error ? err.message : 'Unknown telemetry failure.');
      }
      setMetrics([]);
      setObservedAt(null);
    }
  }, [windowParam, tenantIdParam]);

  useEffect(() => {
    void fetchKpiSnapshot();
  }, [fetchKpiSnapshot]);

  return (
    <main
      role="main"
      aria-label="Executive Dashboard"
      className="flex-1 bg-slate-950 text-slate-100 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full"
    >
      {/* Dashboard Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-slate-100">Executive Dashboard</h1>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-medium border ${getSharedUiStateBadgeClass(
                uiState
              )}`}
            >
              {SHARED_UI_STATE_LABELS[uiState]}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            SCR-001 Ten Baseline Indicators &bull; R17 /api/v1/telemetry/kpi-snapshot
          </p>
        </div>

        <div className="flex items-center gap-3">
          {observedAt && (
            <span className="text-xs font-mono text-slate-500">
              Snapshot: {new Date(observedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchKpiSnapshot()}
            disabled={uiState === 'loading'}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-900 text-slate-200 border border-slate-700 hover:bg-slate-800 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            {uiState === 'loading' ? 'Refreshing...' : 'Refresh Snapshot'}
          </button>
        </div>
      </div>

      {/* Operational Warnings / Explicit Error Banners */}
      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="mt-6 p-4 rounded-lg bg-rose-950/40 border border-rose-800/80 text-rose-300"
        >
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold">Telemetry Data Unavailable</h2>
              <p className="text-xs mt-1 text-rose-400 font-mono">{errorMessage}</p>
            </div>
            {correlationId && (
              <span className="text-[10px] font-mono bg-rose-900/60 px-2 py-0.5 rounded border border-rose-700">
                Corr: {correlationId}
              </span>
            )}
          </div>
          <p className="text-[11px] text-rose-500 mt-2">
            No simulated data is rendered. All indicators report their verified source status below.
          </p>
        </div>
      )}

      {/* Empty State Banner */}
      {uiState === 'empty' && (
        <div
          role="status"
          className="mt-6 p-6 rounded-lg bg-slate-900/60 border border-slate-800 text-center"
        >
          <h2 className="text-sm font-semibold text-slate-300">No Telemetry Recorded</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            The telemetry service returned an empty snapshot for the requested window. Indicators are displayed in their uninstrumented baseline state.
          </p>
        </div>
      )}

      {/* Baseline Metric Grid */}
      <section aria-label="Baseline Operational Metrics" className="mt-6">
        <MetricCardGrid metrics={metrics} isLoading={uiState === 'loading'} />
      </section>
    </main>
  );
}

export default function RootPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8 text-slate-400">
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-ping" />
            <span>Loading Executive Dashboard (SCR-001)...</span>
          </div>
        </div>
      }
    >
      <ExecutiveDashboardContent />
    </Suspense>
  );
}

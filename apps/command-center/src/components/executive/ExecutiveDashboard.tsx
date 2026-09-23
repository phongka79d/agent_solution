/**
 * @file apps/command-center/src/components/executive/ExecutiveDashboard.tsx
 * Root client component for SCR-001: Executive Dashboard.
 * Integrates R17 KPI snapshot and R09 SSE telemetry stream.
 * Displays explicit loading, empty, stale, permission denied, dependency unavailable,
 * and fail-closed states per 06 §8.1.3 and 07 §9.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiClient, ApiError } from '../../lib/api-client';
import type { SharedUiState } from '../../lib/api-types';
import type { KpiMetricItem, AnomalyAlert, SourceStatus } from './types';
import { MetricCardGrid } from './MetricCardGrid';
import { RevenueAttributionChart } from './RevenueAttributionChart';
import { AnomalyAlertsFeed } from './AnomalyAlertsFeed';

const STATE_BADGE_STYLES: Record<SharedUiState, string> = {
  idle: 'bg-slate-800 text-slate-300 border-slate-700',
  loading: 'bg-sky-950 text-sky-300 border-sky-800',
  empty: 'bg-slate-800 text-slate-400 border-slate-700',
  partial: 'bg-amber-950 text-amber-300 border-amber-800',
  stale: 'bg-amber-950 text-amber-400 border-amber-800',
  permission_denied: 'bg-rose-950 text-rose-300 border-rose-800',
  dependency_unavailable: 'bg-orange-950 text-orange-300 border-orange-800',
  version_conflict: 'bg-purple-950 text-purple-300 border-purple-800',
  fail_closed: 'bg-red-950 text-red-200 border-red-700',
};

export function ExecutiveDashboard({
  initialWindow = '24h',
  initialTimezone = 'Asia/Taipei',
}: {
  readonly initialWindow?: string;
  readonly initialTimezone?: string;
}) {
  const [windowVal, setWindowVal] = useState<string>(initialWindow);
  const [timezone] = useState<string>(initialTimezone);
  const [metrics, setMetrics] = useState<readonly KpiMetricItem[]>([]);
  const [alerts] = useState<readonly AnomalyAlert[]>([]);
  const [uiState, setUiState] = useState<SharedUiState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);

  const fetchKpiSnapshot = useCallback(async () => {
    setUiState('loading');
    setErrorMessage(null);

    try {
      const response = await apiClient.getKpiSnapshot({
        window: windowVal,
        timezone,
      });

      const rawMetrics: unknown = response.metrics;
      let items: KpiMetricItem[] = [];

      if (Array.isArray(rawMetrics)) {
        for (const item of rawMetrics) {
          if (item && typeof item === 'object') {
            const m = item as Record<string, unknown>;
            const metricName = typeof m.metric === 'string' ? m.metric : (typeof m.name === 'string' ? m.name : '');
            const status = (typeof m.source_status === 'string' ? m.source_status : 'NO_DATA') as SourceStatus;
            const obsAt = typeof m.observed_at === 'string' ? m.observed_at : (typeof response.observed_at === 'string' ? response.observed_at : null);
            const win = typeof m.window === 'string' ? m.window : (typeof response.window === 'string' ? response.window : undefined);
            const tz = typeof m.timezone === 'string' ? m.timezone : (typeof response.timezone === 'string' ? response.timezone : undefined);
            const prov = typeof m.provisional === 'boolean' ? m.provisional : undefined;
            const rsn = typeof m.reason === 'string' ? m.reason : (typeof m.note === 'string' ? m.note : undefined);

            items.push({
              metric: metricName,
              value: (m.value as number | string | null | Record<string, unknown>) ?? null,
              source_status: status,
              observed_at: obsAt,
              ...(win !== undefined ? { window: win } : {}),
              ...(tz !== undefined ? { timezone: tz } : {}),
              ...(prov !== undefined ? { provisional: prov } : {}),
              ...(rsn !== undefined ? { reason: rsn } : {}),
            });
          }
        }
      } else if (rawMetrics && typeof rawMetrics === 'object') {
        items = Object.entries(rawMetrics as Record<string, unknown>).map(([key, val]) => {
          if (val && typeof val === 'object') {
            const vObj = val as Record<string, unknown>;
            const metricName = typeof vObj.metric === 'string' ? vObj.metric : (typeof vObj.name === 'string' ? vObj.name : key);
            const status = (typeof vObj.source_status === 'string' ? vObj.source_status : 'NO_DATA') as SourceStatus;
            const obsAt = typeof vObj.observed_at === 'string' ? vObj.observed_at : (typeof response.observed_at === 'string' ? response.observed_at : null);
            const win = typeof vObj.window === 'string' ? vObj.window : (typeof response.window === 'string' ? response.window : undefined);
            const tz = typeof vObj.timezone === 'string' ? vObj.timezone : (typeof response.timezone === 'string' ? response.timezone : undefined);
            const prov = typeof vObj.provisional === 'boolean' ? vObj.provisional : undefined;
            const rsn = typeof vObj.reason === 'string' ? vObj.reason : (typeof vObj.note === 'string' ? vObj.note : undefined);

            return {
              metric: metricName,
              value: (vObj.value as number | string | null | Record<string, unknown>) ?? null,
              source_status: status,
              observed_at: obsAt,
              ...(win !== undefined ? { window: win } : {}),
              ...(tz !== undefined ? { timezone: tz } : {}),
              ...(prov !== undefined ? { provisional: prov } : {}),
              ...(rsn !== undefined ? { reason: rsn } : {}),
            };
          }
          return {
            metric: key,
            value: (typeof val === 'number' || typeof val === 'string' || val === null) ? val : null,
            source_status: 'NO_DATA',
            observed_at: typeof response.observed_at === 'string' ? response.observed_at : null,
          };
        });
      }

      setMetrics(items);
      setObservedAt(response.observed_at || null);

      if (items.length === 0) {
        setUiState('empty');
      } else if (items.some((i) => i.source_status === 'STALE')) {
        setUiState('stale');
      } else if (items.some((i) => i.source_status === 'FAIL_CLOSED')) {
        setUiState('fail_closed');
      } else if (items.some((i) => i.source_status === 'NO_DATA' || i.source_status === 'NOT_INSTRUMENTED')) {
        setUiState('partial');
      } else {
        setUiState('idle');
      }
    } catch (err: unknown) {
      setMetrics([]);
      setObservedAt(null);
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setUiState('permission_denied');
          setErrorMessage('Permission Denied: Operator session does not hold telemetry:read authority.');
        } else if (err.status === 502 || err.status === 503 || err.status === 504) {
          setUiState('dependency_unavailable');
          setErrorMessage('Dependency Unavailable: Upstream telemetry service is unreachable.');
        } else if (err.status === 409) {
          setUiState('version_conflict');
          setErrorMessage('Version Conflict: Telemetry snapshot calibration mismatch.');
        } else {
          setUiState('fail_closed');
          setErrorMessage(err.message || 'Telemetry evaluation failed closed.');
        }
      } else {
        setUiState('fail_closed');
        setErrorMessage(err instanceof Error ? err.message : 'Unknown telemetry failure. Fail-closed.');
      }
    }
  }, [windowVal, timezone]);

  useEffect(() => {
    void fetchKpiSnapshot();
  }, [fetchKpiSnapshot]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold tracking-tight text-slate-100">
              SCR-001: Executive Telemetry &amp; Indicators
            </h2>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${STATE_BADGE_STYLES[uiState]}`}
            >
              {uiState}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            R17 /api/v1/telemetry/kpi-snapshot &bull; Window: {windowVal} &bull; Timezone: {timezone}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {observedAt && (
            <span className="text-[11px] font-mono text-slate-500">
              Observed: {new Date(observedAt).toLocaleTimeString()}
            </span>
          )}
          <select
            value={windowVal}
            onChange={(e) => setWindowVal(e.target.value)}
            className="px-2 py-1 text-xs font-mono rounded bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-sky-500"
          >
            <option value="24h">Window: 24h</option>
            <option value="7d">Window: 7d</option>
            <option value="30d">Window: 30d</option>
          </select>
          <button
            type="button"
            onClick={() => void fetchKpiSnapshot()}
            disabled={uiState === 'loading'}
            className="px-3 py-1 text-xs font-medium rounded bg-slate-900 text-slate-200 border border-slate-700 hover:bg-slate-800 disabled:opacity-50"
          >
            {uiState === 'loading' ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="p-4 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono"
        >
          <div className="font-bold mb-1">State: {uiState.toUpperCase()}</div>
          <div>{errorMessage}</div>
        </div>
      )}

      <MetricCardGrid metrics={metrics} isLoading={uiState === 'loading'} />

      <RevenueAttributionChart />

      <AnomalyAlertsFeed alerts={alerts} />
    </div>
  );
}

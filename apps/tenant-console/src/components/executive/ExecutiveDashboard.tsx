/**
 * Root client component for SCR-001: Executive Dashboard.
 * Integrates R17 KPI snapshot and R09 SSE telemetry stream.
 * Displays explicit loading, empty, stale, permission denied, dependency unavailable,
 * and fail-closed states per 06 §8.1.3 and 07 §9.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import type { SharedUiState } from '@agentos/ui-foundation';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { MetricCardGrid } from './MetricCardGrid';
import { RevenueAttributionChart } from './RevenueAttributionChart';
import { AnomalyAlertsFeed } from './AnomalyAlertsFeed';
import type { KpiMetricItem, AnomalyAlert, SourceStatus } from './types';

const STATE_BADGE_STYLES: Record<SharedUiState, string> = {
  idle: 'bg-neutral-bg text-muted border-neutral-border',
  loading: 'bg-info-bg text-info border-info-border',
  empty: 'bg-neutral-bg text-muted border-neutral-border',
  partial: 'bg-warning-bg text-warning border-warning-border',
  stale: 'bg-warning-bg text-warning border-warning-border',
  permission_denied: 'bg-danger-bg text-danger border-danger-border',
  dependency_unavailable: 'bg-warning-bg text-warning border-warning-border',
  version_conflict: 'bg-ai-bg text-ai-text border-ai-border',
  fail_closed: 'bg-danger-bg text-danger border-danger-border',
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
  const [alerts, setAlerts] = useState<readonly AnomalyAlert[]>([]);
  const [uiState, setUiState] = useState<SharedUiState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);

  const fetchKpiSnapshot = useCallback(async () => {
    setUiState('loading');
    setErrorMessage(null);

    try {
      const [response, attentionResult] = await Promise.all([
        tenantConsoleClient.getKpiSnapshot({
          window: windowVal,
          timezone,
        }),
        tenantConsoleClient.getCompanyAttention().catch(() => ({ items: [] })),
      ]);

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

      if (attentionResult && Array.isArray(attentionResult.items)) {
        const mappedAlerts: AnomalyAlert[] = attentionResult.items.map((item, idx) => ({
          id: `${item.type}-${item.source_ref}-${idx}`,
          message: item.title_key,
          severity: item.severity === 'danger' ? 'CRITICAL' : item.severity === 'warning' ? 'WARN' : 'INFO',
          timestamp: new Date().toISOString(),
          source: item.domain,
          evidence_reference: item.source_ref,
        }));
        setAlerts(mappedAlerts);
      }

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
      setAlerts([]);
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
      <div className="flex flex-col gap-4 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold tracking-tight text-ink">
              SCR-001: Executive Telemetry &amp; Indicators
            </h2>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${STATE_BADGE_STYLES[uiState]}`}
            >
              {uiState}
            </span>
          </div>
          <p className="mt-1 text-xs font-mono text-muted">
            R17 /api/v1/telemetry/kpi-snapshot &bull; Window: {windowVal} &bull; Timezone: {timezone}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {observedAt && (
            <span className="text-[11px] font-mono text-muted">
              Observed: {new Date(observedAt).toLocaleTimeString()}
            </span>
          )}
          <select
            value={windowVal}
            onChange={(e) => setWindowVal(e.target.value)}
            className="ui-select rounded text-xs font-mono"
          >
            <option value="24h">Window: 24h</option>
            <option value="7d">Window: 7d</option>
            <option value="30d">Window: 30d</option>
          </select>
          <button
            type="button"
            onClick={() => void fetchKpiSnapshot()}
            disabled={uiState === 'loading'}
            className="ui-button ui-button--secondary rounded px-3 py-1 text-xs disabled:opacity-50"
          >
            {uiState === 'loading' ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-danger-border bg-danger-bg p-4 text-xs font-mono text-danger"
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

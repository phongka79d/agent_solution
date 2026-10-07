/**
 * Renders an individual baseline or supplementary KPI indicator card.
 * Handles explicit source_status badges: LIVE, STALE, NO_DATA, NOT_INSTRUMENTED,
 * UNAVAILABLE, and FAIL_CLOSED per 06 §8.1.3 (R17) and 07 §9.
 */

'use client';

import type { ReactNode } from 'react';
import type {
  BaselineIndicatorDefinition,
  KpiMetricItem,
  SourceStatus,
} from './types';

export interface MetricCardProps {
  readonly definition: BaselineIndicatorDefinition;
  readonly metric: KpiMetricItem | undefined;
}

export function getBadgeStyle(status: SourceStatus): string {
  switch (status) {
    case 'LIVE':
      return 'bg-success-bg text-success border-success-border';
    case 'STALE':
      return 'bg-warning-bg text-warning border-warning-border';
    case 'NO_DATA':
      return 'bg-neutral-bg text-muted border-neutral-border';
    case 'NOT_INSTRUMENTED':
      return 'bg-ai-bg text-ai-text border-ai-border';
    case 'UNAVAILABLE':
      return 'bg-danger-bg text-danger border-danger-border';
    case 'FAIL_CLOSED':
      return 'bg-danger-bg text-danger border-danger-border font-bold';
    default:
      return 'bg-neutral-bg text-muted border-neutral-border';
  }
}

export function formatValue(
  value: number | string | null | undefined | Record<string, unknown>,
  format: BaselineIndicatorDefinition['format']
): ReactNode {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle object-wrapped values from BaselineMetricsCollection
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const firstNum = Object.values(obj).find((v) => typeof v === 'number');
    if (typeof firstNum === 'number') {
      return formatValue(firstNum, format);
    }
    const firstStr = Object.values(obj).find((v) => typeof v === 'string');
    if (typeof firstStr === 'string') {
      return <span className="text-xl font-bold font-mono text-ink">{firstStr}</span>;
    }
    return null;
  }

  if (typeof value === 'string') {
    return <span className="text-xl font-bold font-mono text-ink">{value}</span>;
  }

  switch (format) {
    case 'currency':
      return (
        <span className="text-2xl font-bold font-mono text-ink">
          NT${' '}
          {new Intl.NumberFormat('zh-TW', {
            maximumFractionDigits: 0,
          }).format(value)}
        </span>
      );
    case 'percent':
      return (
        <span className="text-2xl font-bold font-mono text-ink">
          {new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 2,
          }).format(value)}
          %
        </span>
      );
    case 'number':
      return (
        <span className="text-2xl font-bold font-mono text-ink">
          {new Intl.NumberFormat('en-US').format(value)}
        </span>
      );
    case 'status':
      return <span className="text-xl font-bold font-mono text-ink">{String(value)}</span>;
    default:
      return <span className="text-xl font-bold font-mono text-ink">{String(value)}</span>;
  }
}

export function MetricCard({ definition, metric }: MetricCardProps) {
  const isPresentInResponse = metric !== undefined;
  const status: SourceStatus = isPresentInResponse ? metric.source_status : 'NOT_INSTRUMENTED';
  const hasValue = isPresentInResponse && metric.value !== null && metric.value !== undefined;
  const isStale = status === 'STALE';
  const isProvisional = metric?.provisional === true;

  const isValueDisplayable =
    hasValue &&
    status !== 'NO_DATA' &&
    status !== 'NOT_INSTRUMENTED' &&
    status !== 'UNAVAILABLE' &&
    status !== 'FAIL_CLOSED';

  const reasonLabel = !isPresentInResponse
    ? 'Not returned in snapshot'
    : status === 'NOT_INSTRUMENTED'
    ? 'Not instrumented'
    : status === 'NO_DATA'
    ? metric?.reason ?? 'No data for window'
    : status === 'UNAVAILABLE'
    ? metric?.reason ?? 'Source unavailable'
    : status === 'FAIL_CLOSED'
    ? metric?.reason ?? 'Fail closed: evaluation blocked'
    : 'No value';

  return (
    <article
      tabIndex={0}
      aria-label={`${definition.label} indicator: ${status}`}
      className="ui-metric-card flex flex-col justify-between rounded-lg border border-line bg-surface p-4 transition-all hover:border-line-strong focus:outline-none focus:ring-2 focus:ring-interactive"
    >
      <div>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-body">
              {definition.label}
            </h3>
            <span className="text-[10px] font-mono text-muted">{definition.key}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 justify-end">
            {isProvisional && (
              <span
                title="Provisional metric pending calibration"
                className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10px] font-mono text-warning"
              >
                PROVISIONAL
              </span>
            )}
            <span
              className={`px-2 py-0.5 text-[10px] font-mono uppercase font-bold rounded border ${getBadgeStyle(
                status
              )}`}
            >
              {status}
            </span>
          </div>
        </div>

        <div className="min-h-[44px] flex items-baseline mt-1">
          {isValueDisplayable ? (
            formatValue(metric.value, definition.format)
          ) : (
            <div className="flex flex-col">
              <span className="text-2xl font-mono font-bold text-muted" aria-label="No data">
                —
              </span>
              <span className="mt-0.5 text-[11px] text-muted">{reasonLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-[11px] font-mono text-muted">
        {isStale && metric?.observed_at ? (
          <span className="truncate text-warning" title={`Observed at: ${metric.observed_at}`}>
            Stale: {metric.observed_at}
          </span>
        ) : metric?.window ? (
          <span>Window: {metric.window}</span>
        ) : (
          <span className="text-muted">Awaiting stream telemetry</span>
        )}
        {metric?.reason && (
          <span className="max-w-[140px] truncate text-muted" title={metric.reason}>
            {metric.reason}
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * @file apps/command-center/src/components/executive/MetricCard.tsx
 * Renders an individual baseline or supplementary KPI indicator card.
 * Handles explicit source_status badges: LIVE, STALE, NO_DATA, NOT_INSTRUMENTED,
 * UNAVAILABLE, and FAIL_CLOSED per 06 §8.1.3 (R17) and 07 §9.
 */

'use client';

import React from 'react';
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
      return 'bg-emerald-950 text-emerald-300 border-emerald-700/80';
    case 'STALE':
      return 'bg-amber-950 text-amber-300 border-amber-700/80';
    case 'NO_DATA':
      return 'bg-slate-800 text-slate-300 border-slate-700';
    case 'NOT_INSTRUMENTED':
      return 'bg-indigo-950 text-indigo-300 border-indigo-700/80';
    case 'UNAVAILABLE':
      return 'bg-rose-950 text-rose-300 border-rose-700/80';
    case 'FAIL_CLOSED':
      return 'bg-red-950 text-red-200 border-red-700 font-bold';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

export function formatValue(
  value: number | string | null | undefined | Record<string, unknown>,
  format: BaselineIndicatorDefinition['format']
): React.ReactNode {
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
      return <span className="text-xl font-bold font-mono text-slate-100">{firstStr}</span>;
    }
    return null;
  }

  if (typeof value === 'string') {
    return <span className="text-xl font-bold font-mono text-slate-100">{value}</span>;
  }

  switch (format) {
    case 'currency':
      return (
        <span className="text-2xl font-bold font-mono text-slate-100">
          NT${' '}
          {new Intl.NumberFormat('zh-TW', {
            maximumFractionDigits: 0,
          }).format(value)}
        </span>
      );
    case 'percent':
      return (
        <span className="text-2xl font-bold font-mono text-slate-100">
          {new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 2,
          }).format(value)}
          %
        </span>
      );
    case 'number':
      return (
        <span className="text-2xl font-bold font-mono text-slate-100">
          {new Intl.NumberFormat('en-US').format(value)}
        </span>
      );
    case 'status':
      return <span className="text-xl font-bold font-mono text-slate-100">{String(value)}</span>;
    default:
      return <span className="text-xl font-bold font-mono text-slate-100">{String(value)}</span>;
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
      className="p-4 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500 transition-all flex flex-col justify-between"
    >
      <div>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              {definition.label}
            </h3>
            <span className="text-[10px] font-mono text-slate-500">{definition.key}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 justify-end">
            {isProvisional && (
              <span
                title="Provisional metric pending calibration"
                className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-800 text-amber-300 border border-slate-700"
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
              <span className="text-2xl font-mono font-bold text-slate-500" aria-label="No data">
                —
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">{reasonLabel}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 font-mono">
        {isStale && metric?.observed_at ? (
          <span className="text-amber-400/90 truncate" title={`Observed at: ${metric.observed_at}`}>
            Stale: {metric.observed_at}
          </span>
        ) : metric?.window ? (
          <span>Window: {metric.window}</span>
        ) : (
          <span className="text-slate-600">Awaiting stream telemetry</span>
        )}
        {metric?.reason && (
          <span className="truncate max-w-[140px] text-slate-400" title={metric.reason}>
            {metric.reason}
          </span>
        )}
      </div>
    </article>
  );
}

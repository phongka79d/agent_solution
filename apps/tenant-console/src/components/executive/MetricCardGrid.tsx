/**
 * Renders all ten baseline SCR-001 indicators with explicit source_status badges.
 * Normalizes flat array KpiMetricItem[] or dictionary KpiSnapshotResponse wire contract (R17).
 * Renders expected-but-absent keys as an explicit "not returned" row rather than dropping them.
 * Never substitutes zeros or illustrative values when data is absent.
 */

'use client';

import {
  BASELINE_INDICATOR_DEFINITIONS,
  type BaselineIndicatorDefinition,
  type KpiMetricItem,
  type SourceStatus,
} from './types';
import { MetricCard } from './MetricCard';

function resolveMetricItem(
  definition: BaselineIndicatorDefinition,
  metricsMap: Map<string, KpiMetricItem>
): KpiMetricItem | undefined {
  if (metricsMap.has(definition.key)) {
    return metricsMap.get(definition.key);
  }
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      if (metricsMap.has(alias)) {
        return metricsMap.get(alias);
      }
    }
  }
  return undefined;
}

export function MetricCardGrid({
  metrics = [],
  isLoading = false,
}: {
  readonly metrics?: readonly KpiMetricItem[] | Record<string, unknown>;
  readonly isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6"
      >
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="flex h-32 flex-col justify-between rounded-lg border border-line bg-surface p-4 animate-pulse"
          >
            <div className="mb-2 h-3 w-1/3 rounded bg-surface-low" />
            <div className="h-8 w-2/3 rounded bg-surface-low" />
            <div className="h-2 w-1/2 rounded bg-surface-low" />
          </div>
        ))}
      </div>
    );
  }

  // Normalize metrics from array or map/dictionary representation
  const normalizedList: KpiMetricItem[] = [];
  if (Array.isArray(metrics)) {
    normalizedList.push(...metrics);
  } else if (metrics && typeof metrics === 'object') {
    for (const [key, val] of Object.entries(metrics as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        const itemObj = val as Record<string, unknown>;
        const rawStatus = typeof itemObj.source_status === 'string' ? itemObj.source_status : 'LIVE';
        normalizedList.push({
          metric: typeof itemObj.metric === 'string' ? itemObj.metric : key,
          value: itemObj.value !== undefined ? (itemObj.value as number | string | null | Record<string, unknown>) : (val as Record<string, unknown>),
          source_status: rawStatus as SourceStatus,
          observed_at: typeof itemObj.observed_at === 'string' ? itemObj.observed_at : null,
          ...(typeof itemObj.window === 'string' ? { window: itemObj.window } : {}),
          ...(typeof itemObj.timezone === 'string' ? { timezone: itemObj.timezone } : {}),
          provisional: Boolean(itemObj.provisional),
          ...(typeof itemObj.reason === 'string' ? { reason: itemObj.reason } : {}),
        });
      } else {
        normalizedList.push({
          metric: key,
          value: (typeof val === 'number' || typeof val === 'string' || val === null) ? val : null,
          source_status: 'LIVE',
          observed_at: null,
        });
      }
    }
  }

  const metricsMap = new Map<string, KpiMetricItem>();
  const extraMetrics: { key: string; metric: KpiMetricItem }[] = [];
  for (const metric of normalizedList) {
    const key = metric.metric ?? metric.name;
    if (!key) continue;
    metricsMap.set(key, metric);
    if (!BASELINE_INDICATOR_DEFINITIONS.some(
      (definition) => definition.key === key || definition.aliases?.includes(key),
    )) {
      extraMetrics.push({ key, metric });
    }
  }

  return (
    <div
      role="region"
      aria-label="Ten Baseline Operational Indicators (SCR-001)"
      className="space-y-4 mb-6"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {BASELINE_INDICATOR_DEFINITIONS.map((definition) => {
          const item = resolveMetricItem(definition, metricsMap);
          return (
            <MetricCard
              key={definition.key}
              definition={definition}
              metric={item}
            />
          );
        })}
      </div>

      {extraMetrics.length > 0 && (
        <div className="pt-2">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            Additional Telemetry Metrics ({extraMetrics.length})
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {extraMetrics.map(({ key, metric }) => (
              <MetricCard
                key={key}
                definition={{
                  key,
                  label: key,
                  format: typeof metric.value === 'number' ? 'number' : 'status',
                  description: key,
                }}
                metric={metric}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import type { KpiMetricItem } from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

const LABELS: Record<string, string> = {
  runs: 'overview.metric.runs',
  completed_runs: 'overview.metric.completed_runs',
  revenue: 'overview.metric.revenue',
};

function normalizeMetrics(raw: readonly KpiMetricItem<unknown>[] | Record<string, KpiMetricItem<unknown>>): readonly KpiMetricItem<unknown>[] {
  return Array.isArray(raw) ? raw : Object.values(raw);
}

function displayValue(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

export function AnalyticsPage() {
  const [metrics, setMetrics] = useState<readonly KpiMetricItem<unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void tenantConsoleClient.getKpiSnapshot({ window: '24h' }).then((response) => {
      if (!cancelled) setMetrics(normalizeMetrics(response.metrics));
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const visible = metrics.filter((metric) => {
    const key = metric.metric ?? metric.name ?? '';
    return LABELS[key] !== undefined && displayValue(metric.value) !== undefined;
  });

  if (loading) return <LoadingState label={t('common.loading')} />;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.analytics')} title={t('analytics.title')} description={t('analytics.description')} />
      {failed ? <ErrorState message={t('common.error')} /> : null}
      <section className="ui-section-card">
        <SectionHeader title={t('analytics.title')} />
        <div className="p-5">
          {visible.length === 0
            ? <EmptyState title={t('analytics.empty')} description={t('analytics.no_source')} status="NO_DATA" />
            : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visible.map((metric, index) => {
              const key = metric.metric ?? metric.name ?? `metric-${index}`;
              return <MetricCard key={key} label={t(LABELS[key] ?? 'analytics.title')} value={displayValue(metric.value)} status={<StatusBadge code={metric.source_status} />} />;
            })}</div>}
        </div>
      </section>
    </div>
  );
}

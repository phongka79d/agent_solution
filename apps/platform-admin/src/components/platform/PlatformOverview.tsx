'use client';

import { useEffect, useState } from 'react';
import { EmptyState, MetricCard, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { listTenants, getReadiness, getUsage, type PlatformTenant, type PlatformUsage } from '../../lib/platform-client';

function last30Days(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function PlatformOverview() {
  const [tenants, setTenants] = useState<readonly PlatformTenant[]>([]);
  const [usage, setUsage] = useState<readonly PlatformUsage[]>([]);
  const [readinessCount, setReadinessCount] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const range = last30Days();
    void Promise.all([listTenants(), getUsage(range.from, range.to)]).then(async ([tenantRows, usageRows]) => {
      const readiness = await Promise.all(tenantRows.map((tenant) => getReadiness(tenant.tenant_id).catch(() => null)));
      if (cancelled) return;
      setTenants(tenantRows);
      setUsage(usageRows);
      setReadinessCount(readiness.filter(Boolean).length || undefined);
    }).catch(() => {
      if (!cancelled) setError(t('common.error'));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const runs = usage.some((row) => row.runs_count !== null)
    ? usage.reduce((total, row) => total + (row.runs_count ?? 0), 0)
    : undefined;
  const readinessStatus = readinessCount === undefined ? 'NO_DATA' : 'ACTIVE';
  const usageStatus = usage.length === 0 ? 'NO_DATA' : 'ACTIVE';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('platform.overview_eyebrow')}
        title={t('platform.overview')}
        description={t('platform.overview_description')}
        actions={<span className="ui-status ui-status--live">{t('platform.live_telemetry')}</span>}
      />
      {error ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{error}</div> : null}
      <section aria-label={t('platform.fleet_summary')} className="space-y-3">
        <SectionHeader title={t('platform.fleet_summary')} description={t('platform.observed_window')} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" id="overview-metrics">
          <MetricCard label={t('nav.companies')} value={tenants.length > 0 ? String(tenants.length) : undefined} status={<StatusBadge code={tenants.length > 0 ? 'ACTIVE' : 'NO_DATA'} />} detail={t('platform.observed_tenants')} />
          <MetricCard label={t('platform.runs_window')} value={runs === undefined ? undefined : String(runs)} status={<StatusBadge code={runs === undefined ? 'NO_DATA' : 'ACTIVE'} />} detail={t('platform.returned_usage')} />
          <MetricCard label={t('nav.system_health')} value={readinessCount === undefined ? undefined : String(readinessCount)} status={<StatusBadge code={readinessStatus} />} detail={t('platform.tenants_readiness')} />
          <MetricCard label={t('platform.usage_records')} value={usage.length > 0 ? String(usage.length) : undefined} status={<StatusBadge code={usageStatus} />} detail={t('platform.returned_usage')} />
        </div>
      </section>

      <section className="platform-card p-4 sm:p-5" aria-label={t('platform.fleet_readiness')}>
        <SectionHeader title={t('platform.fleet_readiness')} description={t('platform.fleet_readiness_description')} />
        {loading ? <p role="status" className="text-sm text-muted">{t('common.loading')}</p> : tenants.length === 0 ? <EmptyState title={t('common.empty')} /> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{tenants.map((tenant) => <a key={tenant.tenant_id} href={`/companies/${encodeURIComponent(tenant.tenant_id)}`} className="ui-focus-ring rounded-md border border-line bg-surface-low p-3 transition hover:border-line-strong hover:bg-surface"><div className="flex items-start justify-between gap-3"><p className="truncate text-sm font-semibold text-ink">{tenant.display_name}</p><StatusBadge code={tenant.status} /></div><p className="mt-1 truncate font-mono text-[11px] text-muted">{tenant.tenant_id}</p></a>)}</div>}
      </section>
    </div>
  );
}

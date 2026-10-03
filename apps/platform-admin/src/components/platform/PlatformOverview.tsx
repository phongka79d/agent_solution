'use client';

import { useMemo, useState } from 'react';
import {
  AttentionCard,
  ErrorBanner,
  MetricCard,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import { useApi, type UseApiResult } from '@agentos/ui-foundation/data';
import { t } from '@agentos/ui-foundation/i18n';
import {
  type PlatformCompany,
  type PlatformLlmProvider,
  type PlatformReconciliationItem,
  type PlatformRunListItem,
  type PlatformRunsSummaryRow,
} from '../../lib/platform-client';

/** Same-origin BFF fetcher used by every card; the proxy owns auth and CSRF. */
async function platformFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
}

const REFRESH_OPTIONS = { fetcher: platformFetch, retry: { attempts: 1 } } as const;

function items<T>(body: unknown): readonly T[] {
  const value = (body as { items?: unknown } | null)?.items;
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

function RefreshStamp({ lastUpdatedAt }: { readonly lastUpdatedAt: string | null }) {
  if (!lastUpdatedAt) return null;
  return (
    <span className="text-xs text-muted">
      {t('platform.updated_at', { time: new Date(lastUpdatedAt).toLocaleTimeString('vi-VN') })}
    </span>
  );
}

function last30Days(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

interface UsageRow {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly usage_day: string;
  readonly domain: string | null;
  readonly model: string | null;
  readonly currency: string | null;
  readonly cost_recorded: boolean;
  readonly record_count: number;
  readonly input_tokens_total: number;
  readonly output_tokens_total: number;
  readonly cached_tokens_total: number;
  readonly tokens_total: number;
  readonly cost_total: string | null;
  readonly monthly_token_budget: number | null;
}

const STUCK_THRESHOLD_MS = 30 * 60 * 1000;
const STUCK_STATES: Readonly<Record<string, true>> = {
  RUNNING: true,
  QUEUED: true,
  WAITING: true,
  ACCEPTED: true,
};

export function PlatformOverview() {
  const [usageRange] = useState(last30Days);
  const companies = useApi<readonly PlatformCompany[]>('/api/v1/platform/companies', {
    ...REFRESH_OPTIONS,
    select: (body) => items<PlatformCompany>(body),
  });
  const summary = useApi<readonly PlatformRunsSummaryRow[]>('/api/v1/platform/runs/summary', {
    ...REFRESH_OPTIONS,
    select: (body) => items<PlatformRunsSummaryRow>(body),
  });
  const reconciliation = useApi<readonly PlatformReconciliationItem[]>('/api/v1/platform/runs/reconciliation', {
    ...REFRESH_OPTIONS,
    select: (body) => items<PlatformReconciliationItem>(body),
  });
  const runs = useApi<readonly PlatformRunListItem[]>('/api/v1/platform/runs?limit=200', {
    ...REFRESH_OPTIONS,
    select: (body) => items<PlatformRunListItem>(body),
  });
  const providers = useApi<readonly PlatformLlmProvider[]>('/api/v1/platform/providers', {
    ...REFRESH_OPTIONS,
    select: (body) => {
      const value = (body as { providers?: unknown } | null)?.providers;
      return Array.isArray(value) ? (value as readonly PlatformLlmProvider[]) : [];
    },
  });
  const usage = useApi<readonly UsageRow[]>(
    `/api/v1/platform/usage?from=${encodeURIComponent(usageRange.from)}&to=${encodeURIComponent(usageRange.to)}`,
    { ...REFRESH_OPTIONS, select: (body) => items<UsageRow>(body) },
  );

  const failedByCause = useMemo(() => {
    const rows = runs.data ?? [];
    const grouped = new Map<string, number>();
    for (const row of rows) {
      if (row.state !== 'FAILED') continue;
      const cause = row.failure_class && row.failure_class.length > 0 ? row.failure_class : 'UNKNOWN';
      grouped.set(cause, (grouped.get(cause) ?? 0) + 1);
    }
    return [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  }, [runs.data]);

  const stuck = useMemo(() => {
    const now = Date.now();
    return (runs.data ?? []).filter(
      (row) => STUCK_STATES[row.state] === true && now - new Date(row.updated_at).getTime() > STUCK_THRESHOLD_MS,
    );
  }, [runs.data]);

  const providerProblems = useMemo(
    () => (providers.data ?? []).filter((provider) => !provider.secret_configured || provider.status === 'FAILED'),
    [providers.data],
  );

  const unconfigured = useMemo(
    () => (companies.data ?? []).filter((company) => company.status === 'PROVISIONED'),
    [companies.data],
  );

  const summaryRows = summary.data ?? [];
  const runsTotal = sum(summaryRows.map((row) => row.run_count));
  const failedTotal = sum(summaryRows.filter((row) => row.state === 'FAILED').map((row) => row.run_count));
  const failureRate = runsTotal > 0 ? `${((failedTotal / runsTotal) * 100).toFixed(1)}%` : null;

  const companiesByStatus = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const company of companies.data ?? []) {
      grouped.set(company.status, (grouped.get(company.status) ?? 0) + 1);
    }
    return [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  }, [companies.data]);

  const costByCurrency = useMemo(() => {
    const recorded = new Map<string, { tokens: number; cost: number }>();
    let unrecordedTokens = 0;
    let unrecordedRecords = 0;
    for (const row of usage.data ?? []) {
      if (!row.cost_recorded || row.currency === null) {
        unrecordedTokens += row.tokens_total;
        unrecordedRecords += row.record_count;
        continue;
      }
      const current = recorded.get(row.currency) ?? { tokens: 0, cost: 0 };
      current.tokens += row.tokens_total;
      current.cost += typeof row.cost_total === 'string' ? Number.parseFloat(row.cost_total) || 0 : 0;
      recorded.set(row.currency, current);
    }
    return {
      recorded: [...recorded.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      unrecorded: unrecordedRecords > 0 ? { tokens: unrecordedTokens, records: unrecordedRecords } : null,
    };
  }, [usage.data]);

  const refreshStamp = companies.lastUpdatedAt ?? runs.lastUpdatedAt ?? summary.lastUpdatedAt;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('platform.overview_eyebrow')}
        title={t('platform.overview')}
        description={t('platform.overview_description')}
        actions={<RefreshStamp lastUpdatedAt={refreshStamp} />}
      />

      <section aria-label={t('platform.attention_queue')} className="space-y-3" data-testid="attention-queue">
        <SectionHeader
          title={t('platform.attention_queue')}
          description={t('platform.attention_queue_description')}
        />
        <div className="grid gap-3 lg:grid-cols-2">
          <AttentionCard
            severity="danger"
            title={t('platform.attention_failed_runs')}
            description={t('platform.attention_by_cause')}
            href="/operations?state=FAILED"
            {...(failedByCause.length > 0
              ? { tag: <StatusBadge tone="danger" label={t('platform.attention_items', { count: sum(failedByCause.map(([, count]) => count)) })} /> }
              : {})}
            {...(runs.error && runs.data === null
              ? { actions: <ErrorBanner error={runs.error} onRetry={runs.refresh} /> }
              : failedByCause.length > 0
                ? {
                    subline: failedByCause
                      .slice(0, 4)
                      .map(([cause, count]) => `${cause} · ${count}`)
                      .join('  ·  '),
                  }
                : { subline: t('platform.attention_empty') })}
          />
          <AttentionCard
            severity="warning"
            title={t('platform.attention_reconciliation')}
            href="/operations?tab=reconciliation"
            subline={
              reconciliation.error && reconciliation.data === null
                ? t('common.error')
                : (reconciliation.data ?? []).slice(0, 3).map((item) => `${item.display_name} · ${item.domain}`).join('  ·  ') ||
                  t('platform.attention_empty')
            }
            {...(reconciliation.data !== null
              ? { tag: <StatusBadge tone="warning" label={t('platform.attention_items', { count: reconciliation.data.length })} /> }
              : {})}
          />
          <AttentionCard
            severity="warning"
            title={t('platform.attention_stuck')}
            description={t('platform.attention_stuck_note')}
            href="/operations?state=stuck"
            {...(stuck.length > 0
              ? { tag: <StatusBadge tone="warning" label={t('platform.attention_items', { count: stuck.length })} /> }
              : { subline: t('platform.attention_empty') })}
          />
          <AttentionCard
            severity="warning"
            title={t('platform.attention_providers')}
            description={t('platform.attention_provider_note')}
            href="/providers"
            {...(providerProblems.length > 0
              ? {
                  tag: <StatusBadge tone="warning" label={t('platform.attention_items', { count: providerProblems.length })} />,
                  subline: providerProblems.map((provider) => `${provider.display_name} · ${provider.status}`).join('  ·  '),
                }
              : { subline: t('platform.attention_empty') })}
          />
          <AttentionCard
            severity="info"
            title={t('platform.attention_unconfigured')}
            href="/companies?status=PROVISIONED"
            {...(unconfigured.length > 0
              ? {
                  tag: <StatusBadge tone="info" label={t('platform.attention_items', { count: unconfigured.length })} />,
                  subline: unconfigured.map((company) => company.display_name).join('  ·  '),
                }
              : { subline: t('platform.attention_empty') })}
          />
        </div>
      </section>

      <section aria-label={t('platform.kpi_companies_status')} className="space-y-3" data-testid="kpi-cards">
        <SectionHeader title={t('platform.kpi_companies_status')} description={t('platform.overview_description')} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label={t('platform.kpi_companies_status')}
            value={<CompaniesStatusValue state={companies} rows={companiesByStatus} />}
            detail={companies.error && companies.data === null
              ? <ErrorBanner error={companies.error} onRetry={companies.refresh} />
              : <RefreshStamp lastUpdatedAt={companies.lastUpdatedAt} />}
          />
          <MetricCard
            label={t('platform.kpi_runs_30d')}
            value={<RunsByStateValue state={summary} rows={summaryRows} />}
            detail={summary.error && summary.data === null
              ? <ErrorBanner error={summary.error} onRetry={summary.refresh} />
              : <RefreshStamp lastUpdatedAt={summary.lastUpdatedAt} />}
          />
          <MetricCard
            label={t('platform.kpi_failure_rate')}
            value={failureRate ?? t('common.empty')}
            status={<StatusBadge code={failureRate === null ? 'NO_DATA' : failedTotal > 0 ? 'ATTENTION' : 'ACTIVE'} />}
            detail={summary.error && summary.data === null
              ? <ErrorBanner error={summary.error} onRetry={summary.refresh} />
              : <span className="text-xs text-muted">{failedTotal} / {runsTotal}</span>}
          />
          <MetricCard
            label={t('platform.kpi_tokens_cost')}
            value={<CostByCurrencyValue state={usage} rows={costByCurrency} />}
            detail={usage.error && usage.data === null
              ? <ErrorBanner error={usage.error} onRetry={usage.refresh} />
              : <RefreshStamp lastUpdatedAt={usage.lastUpdatedAt} />}
          />
        </div>
      </section>
    </div>
  );
}

function CompaniesStatusValue({
  state,
  rows,
}: {
  readonly state: UseApiResult<readonly PlatformCompany[]>;
  readonly rows: readonly (readonly [string, number])[];
}) {
  if (state.loading && state.data === null) return <span className="text-muted">{t('common.loading')}</span>;
  if (state.error && state.data === null) return t('common.error');
  if (rows.length === 0) return t('common.empty');
  return (
    <span className="flex flex-wrap items-center gap-2">
      {rows.map(([status, count]) => (
        <span key={status} className="inline-flex items-center gap-1">
          <StatusBadge code={status} />
          <span className="text-sm font-semibold text-ink">{count}</span>
        </span>
      ))}
    </span>
  );
}

function RunsByStateValue({
  state,
  rows,
}: {
  readonly state: UseApiResult<readonly PlatformRunsSummaryRow[]>;
  readonly rows: readonly PlatformRunsSummaryRow[];
}) {
  if (state.loading && state.data === null) return <span className="text-muted">{t('common.loading')}</span>;
  if (state.error && state.data === null) return t('common.error');
  if (rows.length === 0) return t('common.empty');
  return (
    <span className="flex flex-wrap items-center gap-2">
      {rows.map((row) => (
        <span key={row.state} className="inline-flex items-center gap-1">
          <StatusBadge code={row.state} />
          <span className="text-sm font-semibold text-ink">{row.run_count}</span>
        </span>
      ))}
    </span>
  );
}

function CostByCurrencyValue({
  state,
  rows,
}: {
  readonly state: UseApiResult<readonly UsageRow[]>;
  readonly rows: {
    readonly recorded: readonly (readonly [string, { tokens: number; cost: number }])[];
    readonly unrecorded: { tokens: number; records: number } | null;
  };
}) {
  if (state.loading && state.data === null) return <span className="text-muted">{t('common.loading')}</span>;
  if (state.error && state.data === null) return t('common.error');
  if (rows.recorded.length === 0 && rows.unrecorded === null) return t('common.empty');
  return (
    <span className="space-y-1">
      {rows.recorded.map(([currency, totals]) => (
        <span key={currency} className="block">
          <span className="text-sm font-semibold text-ink">{`${totals.cost.toLocaleString('vi-VN', { maximumFractionDigits: 4 })} ${currency}`}</span>
          <span className="ml-2 text-xs text-muted">{totals.tokens.toLocaleString('vi-VN')} token</span>
        </span>
      ))}
      {rows.unrecorded ? (
        <span className="block">
          <span className="text-sm font-semibold text-muted">{t('platform.cost_unrecorded')}</span>
          <span className="ml-2 text-xs text-muted">{rows.unrecorded.records.toLocaleString('vi-VN')} · {rows.unrecorded.tokens.toLocaleString('vi-VN')} token</span>
        </span>
      ) : null}
    </span>
  );
}

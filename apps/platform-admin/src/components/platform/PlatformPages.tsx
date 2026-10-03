'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, DataTable, EmptyState, PageHeader, SectionHeader } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { getUsage, type PlatformUsage } from '../../lib/platform-client';

export { SettingsPage } from './SettingsPage';

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }

export interface UsageCurrencyTotal {
  readonly currency: string;
  readonly cost: number;
  readonly tokens: number;
  readonly records: number;
}

export interface UsageCurrencySummary {
  readonly currencies: readonly UsageCurrencyTotal[];
  readonly unrecorded: { readonly records: number; readonly tokens: number };
}

/**
 * Groups recorded cost rows by currency. Rows flagged `cost_recorded === false` are never
 * summed into a currency; they are counted under a separate unrecorded bucket so two
 * currencies can never be combined into one total.
 */
export function summarizeUsageByCurrency(rows: readonly PlatformUsage[]): UsageCurrencySummary {
  const currencies = new Map<string, { cost: number; tokens: number; records: number }>();
  let unrecordedRecords = 0;
  let unrecordedTokens = 0;
  for (const row of rows) {
    if (!row.cost_recorded) {
      unrecordedRecords += row.record_count;
      unrecordedTokens += row.tokens_total;
      continue;
    }
    const currency = row.currency ?? '';
    const current = currencies.get(currency) ?? { cost: 0, tokens: 0, records: 0 };
    current.cost += Number.parseFloat(row.cost_total ?? '0') || 0;
    current.tokens += row.tokens_total;
    current.records += row.record_count;
    currencies.set(currency, current);
  }
  return {
    currencies: [...currencies.entries()].map(([currency, totals]) => ({ currency, ...totals })),
    unrecorded: { records: unrecordedRecords, tokens: unrecordedTokens },
  };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes usage rows for download; recorded and unrecorded rows keep distinct currencies. */
export function usageCsv(rows: readonly PlatformUsage[]): string {
  const header = [
    'tenant_id',
    'display_name',
    'usage_day',
    'domain',
    'model',
    'currency',
    'cost_recorded',
    'record_count',
    'input_tokens_total',
    'output_tokens_total',
    'cached_tokens_total',
    'tokens_total',
    'cost_total',
    'monthly_token_budget',
  ];
  const body = rows.map((row) => [
    row.tenant_id,
    row.display_name,
    row.usage_day,
    row.domain ?? '',
    row.model ?? '',
    row.currency ?? '',
    row.cost_recorded ? 'RECORDED' : 'UNAVAILABLE',
    String(row.record_count),
    String(row.input_tokens_total),
    String(row.output_tokens_total),
    String(row.cached_tokens_total),
    String(row.tokens_total),
    row.cost_total ?? '',
    row.monthly_token_budget === null ? '' : String(row.monthly_token_budget),
  ]);
  return [header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\n');
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatAmount(value: number): string {
  return value.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
}

export function UsagePage() {
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getTime() - 30 * 86400000)));
  const [to, setTo] = useState(isoDate(now));
  const [rows, setRows] = useState<readonly PlatformUsage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const load = () => {
    if (!from || !to) return;
    setLoading(true);
    setError(false);
    void getUsage(new Date(`${from}T00:00:00.000Z`).toISOString(), new Date(`${to}T23:59:59.999Z`).toISOString()).then(setRows).catch(() => setError(true)).finally(() => { setLoading(false); setLoaded(true); });
  };
  useEffect(() => { load(); }, []);
  const summary = useMemo(() => summarizeUsageByCurrency(rows), [rows]);
  const budgets = useMemo(() => {
    const grouped = new Map<string, { name: string; tokens: number; budget: number | null }>();
    for (const row of rows) {
      const current = grouped.get(row.tenant_id) ?? { name: row.display_name, tokens: 0, budget: null };
      current.tokens += row.tokens_total;
      if (current.budget === null && row.monthly_token_budget !== null) current.budget = row.monthly_token_budget;
      grouped.set(row.tenant_id, current);
    }
    return [...grouped.values()];
  }, [rows]);
  const columns = useMemo(() => [
    { key: 'display_name', header: t('platform.tenant'), render: (row: PlatformUsage) => <span className="text-sm text-ink">{row.display_name}</span> },
    { key: 'usage_day', header: t('platform.usage_day'), render: (row: PlatformUsage) => row.usage_day },
    { key: 'domain', header: t('platform.usage_domain'), render: (row: PlatformUsage) => row.domain ?? t('common.empty') },
    { key: 'model', header: t('platform.usage_model'), render: (row: PlatformUsage) => row.model ?? t('common.empty') },
    { key: 'currency', header: t('platform.usage_currency'), render: (row: PlatformUsage) => row.cost_recorded ? (row.currency ?? t('common.empty')) : t('platform.usage_unrecorded') },
    { key: 'record_count', header: t('platform.usage_records'), numeric: true, render: (row: PlatformUsage) => row.record_count },
    { key: 'tokens_total', header: t('platform.usage_tokens'), numeric: true, render: (row: PlatformUsage) => row.tokens_total.toLocaleString('vi-VN') },
    { key: 'cost_total', header: t('platform.cost'), numeric: true, render: (row: PlatformUsage) => row.cost_recorded && row.cost_total !== null ? `${formatAmount(Number.parseFloat(row.cost_total))} ${row.currency ?? ''}`.trim() : t('platform.usage_unrecorded') },
  ], []);
  const hasRows = rows.length > 0;
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('platform.usage')} description={t('platform.usage_description')} />
    <section className="platform-card p-4 sm:p-5" aria-label={t('platform.usage_date_range')}><SectionHeader title={t('platform.usage_date_range')} description={t('platform.usage_date_description')} /><div className="flex flex-wrap items-end gap-3"><label className="text-xs font-medium text-ink-body">{t('platform.date_from')}<input className="ui-input mt-1 block" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="text-xs font-medium text-ink-body">{t('platform.date_to')}<input className="ui-input mt-1 block" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><Button size="sm" type="button" onClick={load} disabled={loading}>{loading ? t('common.loading') : t('platform.load')}</Button><Button size="sm" type="button" variant="secondary" onClick={() => downloadCsv(`platform-usage-${from}-${to}.csv`, usageCsv(rows))} disabled={!hasRows}>{t('platform.usage_export_csv')}</Button></div></section>
    {error ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div> : null}
    {hasRows ? <section className="platform-card p-4 sm:p-5" aria-label={t('platform.usage_totals')}><SectionHeader title={t('platform.usage_totals')} /><div className="mt-3 flex flex-wrap gap-4">{summary.currencies.map((total) => <div key={total.currency} className="rounded-lg border border-line px-4 py-3"><div className="text-xs uppercase tracking-wide text-muted">{total.currency || t('common.empty')}</div><div className="mt-1 text-lg font-semibold text-ink">{formatAmount(total.cost)} {total.currency}</div><div className="text-xs text-muted">{total.tokens.toLocaleString('vi-VN')} token · {total.records} {t('platform.usage_records')}</div></div>)}{summary.unrecorded.records > 0 ? <div className="rounded-lg border border-dashed border-line px-4 py-3"><div className="text-xs uppercase tracking-wide text-muted">{t('platform.usage_unrecorded')}</div><div className="mt-1 text-lg font-semibold text-ink">{summary.unrecorded.records} {t('platform.usage_records')}</div><div className="text-xs text-muted">{summary.unrecorded.tokens.toLocaleString('vi-VN')} token</div></div> : null}</div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{budgets.map((company) => <div key={company.name} className="rounded-lg border border-line px-4 py-3"><dt className="text-xs uppercase tracking-wide text-muted">{company.name}</dt><dd className="mt-1 text-sm text-ink">{company.budget === null ? t('platform.usage_no_budget') : <>{company.tokens.toLocaleString('vi-VN')} / {company.budget.toLocaleString('vi-VN')} token</>}</dd></div>)}</dl>
    </section> : null}
    {loaded && !loading && rows.length === 0 && !error ? <EmptyState title={t('common.empty')} /> : <DataTable rows={rows} loading={loading} caption={t('platform.usage')} getRowKey={(row, index) => `${row.tenant_id}-${row.usage_day}-${row.domain ?? ''}-${row.model ?? ''}-${row.currency ?? 'unrecorded'}-${index}`} className="platform-card" empty={<EmptyState title={t('common.empty')} />} columns={columns} />}
  </div>;
}

export function SubscriptionsPage() {
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('nav.subscriptions')} description={t('platform.subscriptions_description')} /><section className="platform-card p-5"><EmptyState title={t('status.not_integrated')} status="NOT_INTEGRATED" /></section></div>;
}

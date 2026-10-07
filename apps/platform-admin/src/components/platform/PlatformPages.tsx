'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, DataTable, EmptyState, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { getUsage, listProviders, type PlatformProvider, type PlatformUsage } from '../../lib/platform-client';
import { useSession } from '../auth/SessionProvider';

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }

export function UsagePage() {
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getTime() - 30 * 86400000)));
  const [to, setTo] = useState(isoDate(now));
  const [rows, setRows] = useState<readonly PlatformUsage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const load = () => {
    setLoading(true);
    setError(false);
    void getUsage(new Date(`${from}T00:00:00.000Z`).toISOString(), new Date(`${to}T23:59:59.999Z`).toISOString()).then(setRows).catch(() => setError(true)).finally(() => { setLoading(false); setLoaded(true); });
  };
  useEffect(() => { load(); }, []);
  const columns = useMemo(() => [
    { key: 'tenant_id', header: t('platform.tenant'), render: (row: PlatformUsage) => <span className="font-mono text-xs text-ink-body">{row.tenant_id}</span> },
    { key: 'runs_count', header: t('platform.runs'), numeric: true, render: (row: PlatformUsage) => row.runs_count === null ? t('common.empty') : row.runs_count },
    { key: 'estimated_cost_total', header: t('platform.cost'), numeric: true, render: (row: PlatformUsage) => row.estimated_cost_total ?? t('common.empty') },
    { key: 'input_tokens_total', header: t('platform.input_tokens'), numeric: true, render: (row: PlatformUsage) => row.input_tokens_total ?? t('common.empty') },
    { key: 'output_tokens_total', header: t('platform.output_tokens'), numeric: true, render: (row: PlatformUsage) => row.output_tokens_total ?? t('common.empty') },
  ], []);
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('platform.usage')} description={t('platform.usage_description')} />
    <section className="platform-card p-4 sm:p-5" aria-label={t('platform.usage_date_range')}><SectionHeader title={t('platform.usage_date_range')} description={t('platform.usage_date_description')} /><div className="flex flex-wrap items-end gap-3"><label className="text-xs font-medium text-ink-body">{t('platform.date_from')}<input className="ui-input mt-1 block" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="text-xs font-medium text-ink-body">{t('platform.date_to')}<input className="ui-input mt-1 block" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><Button size="sm" type="button" onClick={load} disabled={loading}>{loading ? t('common.loading') : t('platform.load')}</Button></div></section>
    {error ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div> : null}
    {loaded && !loading && rows.length === 0 && !error ? <EmptyState title={t('common.empty')} /> : <DataTable rows={rows} loading={loading} caption={t('platform.usage')} getRowKey={(row, index) => `${row.tenant_id}-${index}`} className="platform-card" empty={<EmptyState title={t('common.empty')} />} columns={columns} />}
  </div>;
}

export function ProvidersPage() {
  const [rows, setRows] = useState<readonly PlatformProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => { void listProviders().then(setRows).catch(() => setError(true)).finally(() => setLoading(false)); }, []);
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('platform.providers')} description={t('platform.providers_description')} />{error ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div> : null}<DataTable rows={rows} loading={loading} caption={t('platform.providers')} getRowKey={(row) => row.provider} empty={<EmptyState title={t('common.empty')} />} className="platform-card" columns={[{ key: 'provider', header: t('platform.provider'), render: (row) => <span className="font-mono text-xs text-ink-body">{row.provider}</span> }, { key: 'configured', header: t('platform.configured'), render: (row) => <StatusBadge code={row.configured ? 'ACTIVE' : 'NOT_CONFIGURED'} /> }, { key: 'mode', header: t('platform.mode'), render: (row) => <StatusBadge code={row.mode} /> }]} /></div>;
}

export function SubscriptionsPage() {
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('nav.subscriptions')} description={t('platform.subscriptions_description')} /><section className="platform-card p-5"><EmptyState title={t('status.not_integrated')} status="NOT_INTEGRATED" /></section></div>;
}

export function SettingsPage() {
  const session = useSession();
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('nav.settings')} description={t('platform.settings_description')} /><section className="platform-card p-4 sm:p-5"><SectionHeader title={t('platform.account')} description={t('platform.settings_secret_note')} /><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.identity')}</dt><dd className="mt-1 text-sm text-ink">{session.identity.display_name}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">Email</dt><dd className="mt-1 text-sm text-ink-body">{session.identity.email}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">Scope</dt><dd className="mt-1"><StatusBadge code={session.membership.scope === 'platform' ? 'ACTIVE' : 'UNKNOWN'} /></dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">Role</dt><dd className="mt-1 font-mono text-xs text-ink-body">{session.membership.role}</dd></div></dl></section><section className="platform-card p-5"><EmptyState title={t('status.not_integrated')} description={t('platform.settings_preferences_not_integrated')} status="NOT_INTEGRATED" /></section></div>;
}

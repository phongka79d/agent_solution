'use client';

import { useEffect, useState } from 'react';
import { AdvancedDetails, Button, DataTable, EmptyState, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { getReadiness, getTenant, listTenants, type PlatformReadiness, type PlatformTenant } from '../../lib/platform-client';

function StatusMap({ values }: { readonly values: Readonly<Record<string, string>> | null }) {
  const entries = values ? Object.entries(values) : [];
  if (entries.length === 0) return <span className="text-sm text-muted">{t('common.empty')}</span>;
  return <div className="space-y-2">{entries.map(([key, value]) => <div className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0" key={key}><span className="font-mono text-xs text-ink-body">{key}</span><StatusBadge code={value} /></div>)}</div>;
}

export function CompaniesPage() {
  const [rows, setRows] = useState<readonly PlatformTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => { void listTenants().then(setRows).catch(() => setError(true)).finally(() => setLoading(false)); }, []);
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.overview_eyebrow')} title={t('nav.companies')} description={t('platform.read_only_directory_description')} />
    {error ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('common.error')}</div> : null}
    <section aria-label={t('nav.companies')} className="space-y-3"><SectionHeader title={t('nav.companies')} description={t('platform.directory_description')} /><DataTable rows={rows} loading={loading} caption={t('nav.companies')} getRowKey={(row) => row.tenant_id} empty={<EmptyState title={t('common.empty')} />} className="platform-card" columns={[
      { key: 'display_name', header: t('platform.company_name'), render: (row) => <a className="ui-focus-ring font-semibold text-brand hover:text-brand-deep" href={`/companies/${encodeURIComponent(row.tenant_id)}`}>{row.display_name}</a> },
      { key: 'status', header: t('platform.status'), render: (row) => <StatusBadge code={row.status} /> },
      { key: 'enabled_modules', header: t('platform.enabled_modules'), render: (row) => row.enabled_modules?.length ? <span className="text-ink-body">{row.enabled_modules.join(', ')}</span> : <span className="text-muted">{t('common.empty')}</span> },
      { key: 'created_at', header: t('platform.created_at'), render: (row) => <span className="font-mono text-xs text-muted">{new Date(row.created_at).toLocaleDateString('vi-VN')}</span> },
    ]} /></section>
  </div>;
}

export function CompanyDetail({ id }: { readonly id: string }) {
  const [tenant, setTenant] = useState<PlatformTenant | null>(null);
  const [readiness, setReadiness] = useState<PlatformReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => { let cancelled = false; void Promise.all([getTenant(id), getReadiness(id)]).then(([tenantRow, readinessRow]) => { if (!cancelled) { setTenant(tenantRow); setReadiness(readinessRow); } }).catch(() => { if (!cancelled) setError(true); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [id]);
  if (loading) return <p role="status" className="platform-card p-4 text-sm text-muted">{t('common.loading')}</p>;
  if (error || !tenant) return <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div>;
  return <div className="space-y-6"><PageHeader eyebrow={t('platform.company_detail')} title={tenant.display_name} description={t('platform.company_detail')} actions={<Button variant="secondary" size="sm" onClick={() => window.history.back()}>{t('platform.back')}</Button>} />
    <section className="platform-card p-4 sm:p-5"><SectionHeader title={t('platform.directory')} /><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.status')}</dt><dd className="mt-1"><StatusBadge code={tenant.status} /></dd></div><div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.created_at')}</dt><dd className="mt-1 font-mono text-xs text-ink-body">{new Date(tenant.created_at).toLocaleDateString('vi-VN')}</dd></div><div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.modules')}</dt><dd className="mt-1 text-sm text-ink-body">{tenant.enabled_modules?.length ? tenant.enabled_modules.join(', ') : t('common.empty')}</dd></div></dl><AdvancedDetails value={tenant.tenant_id} /></section>
    <section className="platform-card p-4 sm:p-5"><SectionHeader title={t('platform.readiness')} description={t('platform.readiness_description')} /><div className="mt-4 grid gap-6 md:grid-cols-3"><div><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('platform.capabilities')}</h3><StatusMap values={readiness?.capability_statuses ?? null} /></div><div><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('platform.connectors')}</h3><StatusMap values={readiness?.connector_statuses ?? null} /></div><div><h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{t('platform.owner_inputs')}</h3><StatusMap values={readiness?.owner_input_statuses ?? null} /></div></div></section>
  </div>;
}

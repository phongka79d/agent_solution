'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  DataClassBadge,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  SectionHeader,
  Select,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import { statusView } from '@agentos/ui-foundation/status';
import { t } from '@agentos/ui-foundation/i18n';
import {
  getCompanyOverview,
  getReadiness,
  listCompanies,
  provisionTenant,
  type PlatformCompany,
  type PlatformCompanyOverview,
  type PlatformReadiness,
} from '../../../lib/platform-client';

const DATA_CLASS_OPTIONS = ['PRODUCTION', 'DEMO', 'TEST'] as const;
const LOCALE_OPTIONS = ['vi-VN', 'en-US'] as const;
const CURRENCY_OPTIONS = ['VND', 'USD'] as const;

interface DirectoryRow {
  readonly company: PlatformCompany;
  readonly overview: PlatformCompanyOverview | null;
  readonly readiness: PlatformReadiness | null;
}

/** Tenant lifecycle label resolved through the `tenant` status domain. */
function TenantStatusBadge({ status }: { readonly status: string }) {
  const view = statusView('tenant', status);
  return <StatusBadge tone={view.tone} label={t(view.label_key)} />;
}

/** Compact domain readiness indicator: one dot per observed capability status. */
function ReadinessDots({ readiness }: { readonly readiness: PlatformReadiness | null }) {
  const entries = readiness?.capability_statuses ? Object.entries(readiness.capability_statuses) : [];
  if (entries.length === 0) return <span className="text-xs text-muted">{t('common.empty')}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label={t('platform.domain_readiness')}>
      {entries.map(([key, code]) => {
        const view = statusView(code);
        const label = `${key}: ${t(view.label_key)}`;
        return <span key={key} role="img" aria-label={label} title={label} className={`ui-readiness-dot ui-readiness-dot--${view.tone}`} />;
      })}
    </span>
  );
}

async function loadDirectory(): Promise<readonly DirectoryRow[]> {
  const companies = await listCompanies();
  return Promise.all(
    companies.map(async (company) => {
      const [overview, readiness] = await Promise.all([
        getCompanyOverview(company.tenant_id).catch(() => null),
        getReadiness(company.tenant_id).catch(() => null),
      ]);
      return { company, overview, readiness };
    }),
  );
}

function CompanyWizard({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [dataClass, setDataClass] = useState<string>('PRODUCTION');
  const [locale, setLocale] = useState<string>('vi-VN');
  const [currency, setCurrency] = useState<string>('VND');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length === 0) {
      setError(t('platform.wizard_name_required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await provisionTenant({ display_name: name, data_class: dataClass, locale, currency });
      setDisplayName('');
      onCreated();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('platform.wizard_failed'));
    } finally {
      setBusy(false);
    }
  }, [currency, dataClass, displayName, locale, onClose, onCreated]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('platform.create_company')}
      description={t('platform.wizard_description')}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="company-provision-form" loading={busy}>
            {busy ? t('platform.wizard_creating') : t('platform.wizard_submit')}
          </Button>
        </>
      }
    >
      <form id="company-provision-form" onSubmit={submit} className="space-y-4">
        <Field label={t('platform.wizard_name')}>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            invalid={error !== null}
            autoFocus
          />
        </Field>
        <Field label={t('platform.wizard_data_class')} hint={t('platform.data_class_immutable')}>
          <Select value={dataClass} onChange={(event) => setDataClass(event.target.value)}>
            {DATA_CLASS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('platform.wizard_locale')}>
            <Select value={locale} onChange={(event) => setLocale(event.target.value)}>
              {LOCALE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('platform.wizard_currency')}>
            <Select value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? <div role="alert" className="text-sm text-danger">{error}</div> : null}
      </form>
    </Modal>
  );
}

export function CompaniesPage() {
  const [rows, setRows] = useState<readonly DirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadDirectory()
      .then((directory) => { if (!cancelled) setRows(directory); })
      .catch((caught) => { if (!cancelled) setError(caught); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [generation]);

  const statusOptions = useMemo(() => {
    const values = new Set(rows.map((row) => row.company.status));
    return [{ value: 'ALL', label: t('common.all') }, ...[...values].map((value) => ({ value, label: value }))];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'ALL' && row.company.status !== statusFilter) return false;
      if (needle.length === 0) return true;
      return row.company.display_name.toLowerCase().includes(needle) || row.company.tenant_id.toLowerCase().includes(needle);
    });
  }, [query, rows, statusFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('platform.overview_eyebrow')}
        title={t('nav.companies')}
        description={t('platform.directory_description')}
        actions={<Button variant="primary" onClick={() => setWizardOpen(true)}>{t('platform.create_company')}</Button>}
      />
      <section aria-label={t('nav.companies')} className="space-y-3">
        <SectionHeader title={t('nav.companies')} description={t('platform.read_only_directory_description')} />
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            label={t('platform.search_companies')}
            placeholder={t('platform.search_companies')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="text-xs font-medium text-ink-body">
            {t('platform.status')}
            <Select
              className="mt-1 block"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={statusOptions}
            />
          </label>
        </div>
        {error ? <ErrorBanner error={error} onRetry={() => setGeneration((value) => value + 1)} /> : null}
        <DataTable
          rows={filtered}
          loading={loading}
          caption={t('nav.companies')}
          getRowKey={(row) => row.company.tenant_id}
          empty={<EmptyState title={t('common.empty')} />}
          className="platform-card"
          columns={[
            {
              key: 'display_name',
              header: t('platform.company_name'),
              render: (row) => (
                <a className="ui-focus-ring font-semibold text-brand hover:text-brand-deep" href={`/companies/${encodeURIComponent(row.company.tenant_id)}`}>
                  {row.company.display_name}
                </a>
              ),
            },
            {
              key: 'data_class',
              header: t('platform.data_class'),
              render: (row) => row.overview ? <DataClassBadge code={row.overview.data_class} /> : <span className="text-muted">{t('common.empty')}</span>,
            },
            { key: 'status', header: t('platform.status'), render: (row) => <TenantStatusBadge status={row.company.status} /> },
            { key: 'readiness', header: t('platform.domain_readiness'), render: (row) => <ReadinessDots readiness={row.readiness} /> },
            { key: 'runs', header: t('platform.runs'), numeric: true, render: (row) => row.overview?.runs_total ?? t('common.empty') },
            { key: 'failures', header: t('platform.failures'), numeric: true, render: (row) => row.overview?.runs_failed ?? t('common.empty') },
            { key: 'attention', header: t('platform.attention_column'), render: (row) => row.overview ? <StatusBadge code={row.overview.needs_attention ? 'ATTENTION' : 'ACTIVE'} /> : <span className="text-muted">{t('common.empty')}</span> },
            { key: 'last_activity', header: t('platform.last_activity'), render: (row) => <span className="text-xs text-muted">{row.overview?.last_activity_at ? new Date(row.overview.last_activity_at).toLocaleString('vi-VN') : t('common.empty')}</span> },
          ]}
        />
      </section>
      <CompanyWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onCreated={() => setGeneration((value) => value + 1)} />
    </div>
  );
}

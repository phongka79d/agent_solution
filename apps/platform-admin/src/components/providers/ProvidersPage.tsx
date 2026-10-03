'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  listProviderConfigs,
  saveProviderConfig,
  testProviderConnection,
  type PlatformLlmProvider,
  type ProviderProbeView,
} from '../../lib/platform-client';
import { ProviderEditDrawer, type ProviderDraftSubmit } from './ProviderEditDrawer';

const PROBE_STORAGE_KEY = 'agentos.platform.provider-probes';

type EditingTarget = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly provider: PlatformLlmProvider } | null;

function readStoredProbes(): Record<string, ProviderProbeView> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(PROBE_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, ProviderProbeView>
      : {};
  } catch {
    return {};
  }
}

function persistProbes(probes: Record<string, ProviderProbeView>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(probes));
  } catch {
    /* storage can be unavailable (private mode); probes stay in memory only */
  }
}

function probeLabel(probe: ProviderProbeView): string {
  if (probe.outcome === 'PASS') {
    return probe.latency_ms === null ? t('platform.probe_pass') : `${t('platform.probe_pass')} · ${probe.latency_ms} ms`;
  }
  return [t('platform.probe_fail'), probe.error_class, probe.http_status === null ? null : `HTTP ${probe.http_status}`]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

function persistedStatus(provider: PlatformLlmProvider) {
  if (provider.status === 'VERIFIED') return <StatusBadge tone="success" label={t('platform.probe_pass')} />;
  if (provider.status === 'FAILED') return <StatusBadge tone="danger" label={t('platform.probe_fail')} />;
  return <StatusBadge tone="neutral" label={t('platform.not_tested')} />;
}

export function ProvidersPage() {
  const [providers, setProviders] = useState<readonly PlatformLlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProviderProbeView>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<EditingTarget>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDefault, setConfirmingDefault] = useState<PlatformLlmProvider | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => { setProbes(readStoredProbes()); }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    return listProviderConfigs()
      .then((items) => setProviders(items))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runTest = useCallback((provider: PlatformLlmProvider) => {
    setTesting((current) => ({ ...current, [provider.provider_id]: true }));
    void testProviderConnection(provider.provider_id)
      .then((result) => {
        setProbes((current) => {
          const next = { ...current, [provider.provider_id]: result };
          persistProbes(next);
          return next;
        });
      })
      .catch(() => {
        setProbes((current) => {
          const next = {
            ...current,
            [provider.provider_id]: { outcome: 'FAIL' as const, latency_ms: null, http_status: null, error_class: 'PROBE_REQUEST_FAILED' },
          };
          persistProbes(next);
          return next;
        });
      })
      .finally(() => setTesting((current) => ({ ...current, [provider.provider_id]: false })));
  }, []);

  const submitDraft = useCallback((submit: ProviderDraftSubmit) => {
    setSaving(true);
    setSaveError(null);
    void saveProviderConfig(submit.provider_id, submit.input)
      .then(() => {
        setNotice(t('platform.provider_saved'));
        setEditing(null);
        return load();
      })
      .catch(() => setSaveError(t('platform.provider_save_failed')))
      .finally(() => setSaving(false));
  }, [load]);

  const submitDefault = useCallback((event: FormEvent) => {
    event.preventDefault();
    const provider = confirmingDefault;
    if (provider === null || reason.trim().length === 0) return;
    setSaving(true);
    setSaveError(null);
    void saveProviderConfig(provider.provider_id, {
      display_name: provider.display_name,
      base_url: provider.base_url,
      reasoning_model: provider.reasoning_model,
      fast_model: provider.fast_model,
      timeout_ms: provider.timeout_ms,
      structured_mode: provider.structured_mode,
      is_default: true,
      api_key: null,
    })
      .then(() => {
        setNotice(t('platform.provider_saved'));
        setConfirmingDefault(null);
        setReason('');
        return load();
      })
      .catch(() => setSaveError(t('platform.provider_save_failed')))
      .finally(() => setSaving(false));
  }, [confirmingDefault, reason, load]);

  const columns = useMemo(() => [
    {
      key: 'provider',
      header: t('platform.provider'),
      render: (row: PlatformLlmProvider) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{row.display_name}</span>
            {row.is_default ? <StatusBadge tone="info" label={t('platform.default_badge')} /> : null}
          </div>
          <span className="font-mono text-xs text-muted">{row.provider_id}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('platform.status'),
      render: (row: PlatformLlmProvider) => persistedStatus(row),
    },
    {
      key: 'models',
      header: t('platform.models'),
      render: (row: PlatformLlmProvider) => (
        <div className="space-y-0.5 text-xs">
          <div><span className="text-muted">{t('platform.reasoning_model')}: </span>{row.reasoning_model}</div>
          <div><span className="text-muted">{t('platform.fast_model')}: </span>{row.fast_model}</div>
        </div>
      ),
    },
    {
      key: 'timeout_ms',
      header: t('platform.timeout_ms'),
      numeric: true,
      render: (row: PlatformLlmProvider) => row.timeout_ms,
    },
    {
      key: 'secret',
      header: t('platform.api_key'),
      render: (row: PlatformLlmProvider) => (
        <span className="text-xs text-ink-body">{row.secret_configured ? t('platform.api_key_configured') : t('platform.api_key_missing')}</span>
      ),
    },
    {
      key: 'probe',
      header: t('platform.last_probe'),
      render: (row: PlatformLlmProvider) => {
        const probe = probes[row.provider_id];
        if (probe === undefined) return <span className="text-xs text-muted">{t('platform.not_tested')}</span>;
        return (
          <div className="flex flex-col gap-0.5 text-xs">
            <StatusBadge
              tone={probe.outcome === 'PASS' ? 'success' : 'danger'}
              label={probe.outcome === 'PASS' ? t('platform.probe_pass') : t('platform.probe_fail')}
            />
            <span className="text-muted">{probeLabel(probe)}</span>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: t('platform.actions'),
      render: (row: PlatformLlmProvider) => (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={testing[row.provider_id] === true}
            loadingLabel={t('platform.testing')}
            onClick={() => runTest(row)}
          >
            {t('platform.test_connection')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSaveError(null); setEditing({ mode: 'edit', provider: row }); }}>
            {t('platform.edit_provider')}
          </Button>
          {!row.is_default ? (
            <Button size="sm" variant="ghost" onClick={() => { setSaveError(null); setReason(''); setConfirmingDefault(row); }}>
              {t('platform.make_default')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ], [probes, testing, runTest]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('platform.overview_eyebrow')}
        title={t('platform.providers')}
        description={t('platform.providers_description')}
        actions={
          <Button type="button" onClick={() => { setSaveError(null); setEditing({ mode: 'create' }); }}>
            {t('platform.add_provider')}
          </Button>
        }
      />

      {notice ? <div role="status" className="platform-alert platform-alert--success text-sm">{notice}</div> : null}
      {loadError ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{t('platform.failed_load')}</div> : null}
      {saveError && editing === null && confirmingDefault === null
        ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{saveError}</div>
        : null}

      <DataTable
        rows={providers}
        loading={loading}
        caption={t('platform.providers')}
        className="platform-card"
        getRowKey={(row) => row.provider_id}
        empty={<EmptyState title={t('common.empty')} />}
        columns={columns}
      />

      <section className="platform-card p-4 sm:p-5" aria-label={t('platform.per_company_overrides')}>
        <SectionHeader title={t('platform.per_company_overrides')} description={t('platform.per_company_overrides_description')} />
        <div className="mt-3">
          <a className="ui-button ui-button--secondary ui-button--sm ui-focus-ring" href="/companies">
            {t('platform.view_companies')}
          </a>
        </div>
      </section>

      <ProviderEditDrawer
        open={editing !== null}
        provider={editing !== null && editing.mode === 'edit' ? editing.provider : null}
        saving={saving}
        error={saveError}
        onClose={() => { setEditing(null); setSaveError(null); }}
        onSubmit={submitDraft}
      />

      <Modal
        open={confirmingDefault !== null}
        onClose={() => { setConfirmingDefault(null); setReason(''); }}
        title={t('platform.default_confirm_title')}
        description={t('platform.default_confirm_description')}
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => { setConfirmingDefault(null); setReason(''); }}>
              {t('platform.cancel')}
            </Button>
            <Button type="submit" form="provider-default-form" disabled={reason.trim().length === 0} loading={saving}>
              {t('platform.confirm')}
            </Button>
          </>
        }
      >
        <form id="provider-default-form" className="space-y-4" onSubmit={submitDefault}>
          <p className="text-sm text-ink-body">{confirmingDefault?.display_name}</p>
          <Field label={t('platform.reason')} hint={t('platform.reason_required')}>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              aria-label={t('platform.reason')}
            />
          </Field>
          {saveError ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{saveError}</div> : null}
        </form>
      </Modal>
    </div>
  );
}

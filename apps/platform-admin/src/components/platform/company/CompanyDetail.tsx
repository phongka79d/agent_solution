'use client';

import { can } from '@agentos/ui-foundation/auth';
import { useEffect, useState } from 'react';
import {
  Button,
  DataClassBadge,
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@agentos/ui-foundation/react';
import { statusView } from '@agentos/ui-foundation/status';
import { t } from '@agentos/ui-foundation/i18n';
import {
  changeCompanyLifecycle,
  getCompanyOverview,
  getReadiness,
  getTenant,
  type PlatformCompanyOverview,
  type PlatformReadiness,
  type PlatformTenant,
} from '../../../lib/platform-client';
import { useSession } from '../../auth/SessionProvider';
import { CompanyAiTeamTab, CompanyAuditTab, CompanyAutonomyTab, CompanyRunsTab, CompanyUsageTab } from './CompanyDataTabs';
import { CompanyUsersTab } from './CompanyUsersTab';
import { ReasonActionDialog } from './ReasonActionDialog';

function TenantStatusBadge({ status }: { readonly status: string }) {
  const view = statusView('tenant', status);
  return <StatusBadge tone={view.tone} label={t(view.label_key)} />;
}

function ConnectionMap({ values }: { readonly values: Readonly<Record<string, string>> | null }) {
  const entries = values ? Object.entries(values) : [];
  if (entries.length === 0) return <EmptyState title={t('common.empty')} />;
  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0" key={key}>
          <span className="font-mono text-xs text-ink-body">{key}</span>
          <StatusBadge code={value} />
        </div>
      ))}
    </div>
  );
}

type LifecycleAction = 'suspend' | 'resume';

export function CompanyDetail({ id }: { readonly id: string }) {
  const session = useSession();
  const canManage = can(session, 'platform:companies:write');
  const [tenant, setTenant] = useState<PlatformTenant | null>(null);
  const [overview, setOverview] = useState<PlatformCompanyOverview | null>(null);
  const [readiness, setReadiness] = useState<PlatformReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([getTenant(id), getCompanyOverview(id), getReadiness(id)])
      .then(([tenantRow, overviewRow, readinessRow]) => {
        if (cancelled) return;
        setTenant(tenantRow);
        setOverview(overviewRow);
        setReadiness(readinessRow);
      })
      .catch((caught) => { if (!cancelled) setError(caught); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [generation, id]);

  const confirmLifecycleAction = async () => {
    if (lifecycleAction === null || reason.trim().length === 0) return;
    setBusy(true);
    setActionFailed(false);
    try {
      await changeCompanyLifecycle(id, lifecycleAction, reason.trim());
      setLifecycleAction(null);
      setReason('');
      setGeneration((value) => value + 1);
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="platform-card p-4"><Skeleton variant="card" /></div>;
  if (error && !tenant) return <ErrorBanner error={error} />;
  if (!tenant) return <div className="platform-card p-4"><EmptyState title={t('common.empty')} /></div>;

  const summaryTab = (
    <dl className="grid gap-4 sm:grid-cols-2">
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.data_class')}</dt><dd className="mt-1">{overview ? <DataClassBadge code={overview.data_class} /> : t('common.empty')}</dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.status')}</dt><dd className="mt-1"><TenantStatusBadge status={tenant.status} /></dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.total_runs')}</dt><dd className="mt-1 text-sm text-ink">{overview?.runs_total ?? t('common.empty')}</dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.failures')}</dt><dd className="mt-1 text-sm text-ink">{overview?.runs_failed ?? t('common.empty')}</dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.attention_reconciliation')}</dt><dd className="mt-1 text-sm text-ink">{overview?.reconciliation_count ?? t('common.empty')}</dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.last_activity')}</dt><dd className="mt-1 text-sm text-ink">{overview?.last_activity_at ? new Date(overview.last_activity_at).toLocaleString('vi-VN') : t('common.empty')}</dd></div>
      <div><dt className="text-xs uppercase tracking-wide text-muted">{t('platform.created_at')}</dt><dd className="mt-1 font-mono text-xs text-ink-body">{new Date(tenant.created_at).toLocaleDateString('vi-VN')}</dd></div>
    </dl>
  );

  const isSuspended = tenant.status === 'SUSPENDED';
  const actionTitle = lifecycleAction === 'suspend' ? t('platform.company.suspend_title') : t('platform.company.resume_title');
  const actionDescription = lifecycleAction === 'suspend' ? t('platform.company.suspend_description') : t('platform.company.resume_description');
  const actionLabel = lifecycleAction === 'suspend' ? t('platform.company.suspend') : t('platform.company.resume');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('platform.company_detail')}</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">{tenant.display_name}</h1>
          <p className="mt-1 font-mono text-xs text-muted">{tenant.tenant_id}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <Button variant={isSuspended ? 'primary' : 'danger'} size="sm" onClick={() => setLifecycleAction(isSuspended ? 'resume' : 'suspend')}>
              {isSuspended ? t('platform.company.resume') : t('platform.company.suspend')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => window.history.back()}>{t('platform.back')}</Button>
        </div>
      </header>
      {error ? <ErrorBanner error={error} /> : null}
      {actionFailed ? <p role="alert" className="text-sm text-danger">{t('platform.company.action_error')}</p> : null}
      <section className="platform-card p-4 sm:p-5">
        <Tabs
          tabs={[
            { id: 'overview', label: t('platform.tab_overview'), content: summaryTab },
            { id: 'users', label: t('platform.tab_users'), content: <CompanyUsersTab companyId={id} canManage={canManage} /> },
            { id: 'ai-team', label: t('platform.tab_ai_team'), content: <CompanyAiTeamTab readiness={readiness} /> },
            { id: 'connections', label: t('platform.tab_connections'), content: <ConnectionMap values={readiness?.connector_statuses ?? null} /> },
            { id: 'usage', label: t('platform.tab_usage'), content: <CompanyUsageTab companyId={id} /> },
            { id: 'runs', label: t('platform.tab_runs'), content: <CompanyRunsTab companyId={id} /> },
            { id: 'autonomy', label: t('platform.tab_autonomy'), content: <CompanyAutonomyTab companyId={id} /> },
            { id: 'audit', label: t('platform.tab_audit'), content: <CompanyAuditTab companyId={id} /> },
          ]}
        />
      </section>
      <ReasonActionDialog
        open={lifecycleAction !== null}
        title={actionTitle}
        description={actionDescription}
        confirmLabel={actionLabel}
        reason={reason}
        busy={busy}
        onReasonChange={setReason}
        onClose={() => { setLifecycleAction(null); setReason(''); }}
        onConfirm={() => { void confirmLifecycleAction(); }}
      />
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import type { CompanyGovernanceResponse } from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';

export function SettingsPage() {
  const session = useSession();
  const canReadGovernance = can(session, 'approval:read');
  const [governance, setGovernance] = useState<CompanyGovernanceResponse | null>(null);
  const [loading, setLoading] = useState(canReadGovernance);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!canReadGovernance) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    void tenantConsoleClient.getCompanyGovernance().then((response) => {
      if (!cancelled) setGovernance(response);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [canReadGovernance]);

  if (loading) return <LoadingState label={t('common.loading')} />;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.settings')} title={t('settings.title')} description={t('settings.description')} />
      <section className="ui-section-card">
        <SectionHeader title={t('settings.identity')} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div><p className="text-sm text-muted">{t('auth.email')}</p><p className="mt-1 font-medium text-ink">{session?.identity.email ?? t('common.empty')}</p></div>
          <div><p className="text-sm text-muted">{t('auth.company_workspace')}</p><p className="mt-1 font-medium text-ink">{session?.membership.tenant_name ?? session?.membership.tenant_id ?? t('common.empty')}</p></div>
        </div>
      </section>
      <section className="ui-section-card">
        <SectionHeader title={t('settings.governance')} />
        <div className="p-5">
          {!canReadGovernance
            ? <EmptyState title={t('auth.forbidden')} status="NOT_INTEGRATED" />
            : failed || governance === null
              ? <ErrorState message={failed ? t('settings.governance_unavailable') : t('common.empty')} />
              : <div className="flex flex-wrap items-center gap-3"><StatusBadge code={governance.require_distinct_approver ? 'ACTIVE' : 'NO_DATA'} /><span className="text-sm text-ink">{governance.require_distinct_approver ? t('settings.distinct_approver') : t('settings.no_distinct_approver')}</span></div>}
          <p className="mt-4 text-sm leading-6 text-muted">{t('settings.notice')}</p>
        </div>
      </section>
    </div>
  );
}

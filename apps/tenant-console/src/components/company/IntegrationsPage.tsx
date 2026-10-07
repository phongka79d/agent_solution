'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, ErrorState, LoadingState, PageHeader, SectionHeader, StatusBadge } from '@agentos/ui-foundation/react';
import type { CompanyIntegrationItem } from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

export function IntegrationsPage() {
  const [items, setItems] = useState<readonly CompanyIntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void tenantConsoleClient.getCompanyIntegrations().then((response) => {
      if (!cancelled) setItems(response.items);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <LoadingState label={t('common.loading')} />;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.integrations')} title={t('integrations.title')} description={t('integrations.description')} />
      {failed ? <ErrorState message={t('common.error')} /> : null}
      <section className="ui-section-card">
        <SectionHeader title={t('integrations.title')} description={t('integrations.detail')} />
        <div className="p-5">
          {items.length === 0
            ? <EmptyState title={t('integrations.empty')} status="NO_DATA" />
            : <ul className="divide-y divide-line">{items.map((item) => (
              <li key={`${item.category}-${item.key}`} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div>
                  <h2 className="font-semibold text-ink">{item.key}</h2>
                  <p className="mt-1 text-sm text-muted">{item.category}</p>
                </div>
                <StatusBadge code={item.status} />
              </li>
            ))}</ul>}
        </div>
      </section>
    </div>
  );
}

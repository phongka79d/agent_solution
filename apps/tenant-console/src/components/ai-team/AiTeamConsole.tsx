'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { AgentCard, ActivityTimeline, EmptyState, ErrorState, LoadingState, PageHeader, SectionHeader } from '@agentos/ui-foundation/react';
import type { CompanyActivityItem, CompanyAiTeamAgent } from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

export type AiTeamDomain = 'marketing' | 'sales' | 'care';

function isDomain(value: string): value is AiTeamDomain {
  return value === 'marketing' || value === 'sales' || value === 'care';
}

function paramsFor(params: Readonly<Record<string, string | number | boolean>>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function nameFor(domain: string): string {
  return isDomain(domain) ? t(`aiTeam.${domain}.name`) : t('aiTeam.title');
}

function purposeFor(domain: string): string {
  return isDomain(domain) ? t(`aiTeam.${domain}.purpose`) : t('aiTeam.description');
}

function hrefFor(domain: string): string | undefined {
  return isDomain(domain) ? `/ai-team/${domain}` : undefined;
}

function activityItems(items: readonly CompanyActivityItem[]) {
  return items.map((item) => {
    const href = item.run_id ? `/runs/${encodeURIComponent(item.run_id)}` : undefined;
    return {
      id: `${item.kind}-${item.run_id}-${item.occurred_at}`,
      time: formatTime(item.occurred_at),
      title: t(item.sentence_key, paramsFor(item.params)),
      ...(href === undefined ? {} : {
        href,
        description: <Link href={href} className="font-semibold text-brand hover:text-brand-deep">{t('aiTeam.runs.view')}</Link>,
      }),
    };
  });
}

export function AiTeamConsole({ domain }: { readonly domain?: AiTeamDomain | undefined }) {
  const [agents, setAgents] = useState<readonly CompanyAiTeamAgent[]>([]);
  const [activity, setActivity] = useState<readonly CompanyActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.allSettled([
      tenantConsoleClient.getCompanyAiTeam(),
      tenantConsoleClient.getCompanyActivity({ limit: 20 }),
    ]).then(([agentsResult, activityResult]) => {
      if (cancelled) return;
      if (agentsResult.status === 'fulfilled') setAgents(agentsResult.value.agents);
      if (activityResult.status === 'fulfilled') setActivity(activityResult.value.items);
      if (agentsResult.status === 'rejected' && activityResult.status === 'rejected') setFailed(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedAgents = useMemo(
    () => domain === undefined ? agents : agents.filter((agent) => agent.domain === domain),
    [agents, domain],
  );
  const selectedActivity = useMemo(
    () => domain === undefined ? activity : activity.filter((item) => item.domain === domain),
    [activity, domain],
  );
  const title = domain === undefined ? t('aiTeam.title') : nameFor(domain);
  const description = domain === undefined ? t('aiTeam.description') : purposeFor(domain);

  if (loading) return <LoadingState label={t('common.loading')} />;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.ai_team')} title={title} description={description} />
      {failed ? <ErrorState message={t('common.error')} /> : null}
      <section aria-labelledby="ai-team-agents-heading">
        <SectionHeader title={t('aiTeam.title')} />
        {selectedAgents.length === 0
          ? <EmptyState title={t('common.empty')} status="NO_DATA" />
          : <div className="grid gap-3 md:grid-cols-3">{selectedAgents.map((agent) => (
            <AgentCard
              key={agent.domain}
              name={nameFor(agent.domain)}
              purpose={purposeFor(agent.domain)}
              status={agent.status}
              {...(agent.runs_today === undefined ? {} : { metric: `${agent.runs_today}` })}
              {...(() => {
                const href = hrefFor(agent.domain);
                return href === undefined ? {} : { href };
              })()}
            />
          ))}</div>}
      </section>
      <section aria-labelledby="ai-team-runs-heading" className="ui-section-card p-5">
        <SectionHeader title={t('aiTeam.runs.title')} />
        {selectedActivity.length === 0
          ? <EmptyState title={t('aiTeam.runs.empty')} status="NO_DATA" />
          : <ActivityTimeline items={activityItems(selectedActivity)} />}
      </section>
      {domain === 'sales' ? <Link href="/ai-team/sales/try" className="font-semibold text-brand hover:text-brand-deep ui-focus-ring">{t('nav.try_assistant')}</Link> : null}
    </div>
  );
}

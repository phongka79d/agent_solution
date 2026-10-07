'use client';

import { useEffect, useMemo, useState } from 'react';
import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import {
  ActivityTimeline,
  AgentCard,
  AttentionCard,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  SectionHeader,
} from '@agentos/ui-foundation/react';
import type {
  CompanyActivityItem,
  CompanyAiTeamAgent,
  CompanyAttentionItem,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';

type OverviewState = 'loading' | 'ready' | 'error';

type MetricEntry = [string, number];

function translationParams(params: Readonly<Record<string, string | number | boolean>>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]));
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function domainLabel(domain: string): string {
  const key = domain === 'marketing' || domain === 'sales' || domain === 'care' ? `aiTeam.${domain}.name` : 'nav.overview';
  return t(key);
}

function agentName(domain: string): string {
  return domain === 'marketing' || domain === 'sales' || domain === 'care'
    ? t(`aiTeam.${domain}.name`)
    : t('aiTeam.title');
}

function agentPurpose(domain: string): string {
  return domain === 'marketing' || domain === 'sales' || domain === 'care'
    ? t(`aiTeam.${domain}.purpose`)
    : t('aiTeam.description');
}

function agentHref(domain: string): string | undefined {
  return domain === 'marketing' || domain === 'sales' || domain === 'care' ? `/ai-team/${domain}` : undefined;
}

function metricLabel(key: string): string | undefined {
  if (key === 'runs' || key === 'completed_runs' || key === 'revenue') return t(`overview.metric.${key}`);
  return undefined;
}

export function CompanyOverview() {
  const session = useSession();
  const allowed = can(session, 'telemetry:read');
  const canReadRuns = can(session, 'run:read');
  const [state, setState] = useState<OverviewState>('loading');
  const [attention, setAttention] = useState<readonly CompanyAttentionItem[]>([]);
  const [agents, setAgents] = useState<readonly CompanyAiTeamAgent[]>([]);
  const [activity, setActivity] = useState<readonly CompanyActivityItem[]>([]);
  const [metrics, setMetrics] = useState<readonly MetricEntry[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!allowed) {
      setState('ready');
      return () => { cancelled = true; };
    }
    setState('loading');
    setFailed(false);
    const activityRequest = canReadRuns
      ? tenantConsoleClient.getCompanyActivity({ limit: 20 })
      : Promise.resolve({ items: [], next_cursor: null });
    void Promise.allSettled([
      tenantConsoleClient.getCompanyAttention(),
      tenantConsoleClient.getCompanyAiTeam(),
      activityRequest,
    ]).then(([attentionResult, agentsResult, activityResult]) => {
      if (cancelled) return;
      let hadSuccess = false;
      if (attentionResult.status === 'fulfilled') {
        setAttention(attentionResult.value.items);
        hadSuccess = true;
      }
      if (agentsResult.status === 'fulfilled') {
        setAgents(agentsResult.value.agents);
        hadSuccess = true;
      }
      if (activityResult.status === 'fulfilled') {
        setActivity(activityResult.value.items);
        hadSuccess = true;
      }
      if (!hadSuccess) setFailed(true);
      setState('ready');
    });
    return () => { cancelled = true; };
  }, [allowed, canReadRuns]);

  useEffect(() => {
    let cancelled = false;
    if (!allowed) return () => { cancelled = true; };
    void tenantConsoleClient.getCompanyOverview().then((response) => {
      if (!cancelled && response.metrics) {
        setMetrics(Object.entries(response.metrics).filter((entry): entry is MetricEntry => metricLabel(entry[0]) !== undefined));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [allowed]);

  const activityItems = useMemo(() => activity.map((item) => {
    const href = canReadRuns && item.run_id ? `/runs/${encodeURIComponent(item.run_id)}` : undefined;
    return {
      id: `${item.kind}-${item.run_id}-${item.occurred_at}`,
      time: formatActivityTime(item.occurred_at),
      title: t(item.sentence_key, translationParams(item.params)),
      ...(href === undefined ? {} : { href }),
      description: domainLabel(item.domain),
    };
  }), [activity, canReadRuns]);

  if (state === 'loading') return <LoadingState label={t('common.loading')} />;
  if (!allowed) return <ErrorState message={t('auth.forbidden')} />;

  return (
    <div className="space-y-8" aria-label={t('nav.overview')}>
      <PageHeader
        eyebrow={t('auth.company_workspace')}
        title={t('overview.welcome', { name: session?.identity.display_name ?? '' })}
        description={t('overview.description')}
      />

      {failed ? <ErrorState message={t('common.error')} /> : null}

      {metrics.length > 0 ? (
        <section aria-labelledby="overview-metrics-heading">
          <SectionHeader title={t('overview.metrics.title')} />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map(([key, value]) => <MetricCard key={key} label={metricLabel(key)} value={value} />)}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="overview-attention-heading">
        <SectionHeader title={t('overview.attention.title')} />
        {attention.length === 0
          ? <EmptyState title={t('overview.attention.empty')} description={t('common.empty')} status="NO_DATA" />
          : <div className="space-y-2">{attention.map((item) => (
            <AttentionCard
              key={`${item.type}-${item.source_ref}`}
              severity={item.severity}
              title={t(item.title_key, translationParams(item.params))}
              href={item.href}
              domain={domainLabel(item.domain)}
            />
          ))}</div>}
      </section>

      <section aria-labelledby="overview-ai-heading">
        <SectionHeader title={t('overview.ai_team.title')} description={t('overview.ai_team.description')} />
        {agents.length === 0
          ? <EmptyState title={t('common.empty')} status="NO_DATA" />
          : <div className="grid gap-3 md:grid-cols-3">{agents.map((agent) => (
            <AgentCard
              key={agent.domain}
              name={agentName(agent.domain)}
              purpose={agentPurpose(agent.domain)}
              status={agent.status}
              {...(agent.runs_today === undefined ? {} : { metric: `${agent.runs_today}` })}
              {...(() => {
                const href = agentHref(agent.domain);
                return href === undefined ? {} : { href };
              })()}
            />
          ))}</div>}
      </section>

      <section aria-labelledby="overview-activity-heading" className="ui-section-card p-5">
        <SectionHeader title={t('overview.activity.title')} />
        {activityItems.length === 0
          ? <EmptyState title={t('overview.activity.empty')} status="NO_DATA" />
          : <ActivityTimeline items={activityItems} />}
      </section>
    </div>
  );
}

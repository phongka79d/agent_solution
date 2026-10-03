'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { can } from '@agentos/ui-foundation/auth';
import { statusView } from '@agentos/ui-foundation/status';
import { t } from '@agentos/ui-foundation/i18n';
import {
  ActivityTimeline,
  AgentCard,
  AttentionCard,
  EmptyState,
  ErrorBanner,
  MetricCard,
  PageHeader,
  SectionHeader,
  Skeleton,
} from '@agentos/ui-foundation/react';
import type { CompanyOverviewResponse } from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';
import { companyActivitySentence } from './company-activity';

type Overview = CompanyOverviewResponse;
type AttentionGroup = Overview['attention'][number];
type AiTeamEntry = Overview['ai_team'][number];
type TodayMetric = NonNullable<Overview['today']>['metrics'][number];

function domainLabel(domain: string): string {
  return domain === 'marketing' || domain === 'sales' || domain === 'care'
    ? t(`aiTeam.${domain}.name`)
    : t('nav.overview');
}

function formatTime(value: string | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function todayMetricLabel(metric: TodayMetric): string {
  if (metric.key === 'campaigns_by_state') {
    const state = String(metric.params?.['state'] ?? '');
    return t('overview.metric.campaigns_by_state', { state: t(statusView('campaign', state).label_key) });
  }
  return t(`overview.metric.${metric.key}`);
}

function SectionError({ onRetry }: { readonly onRetry: () => void }) {
  return <ErrorBanner error={{ retryable: true, message: t('overview.section.error') }} onRetry={onRetry} />;
}

function aiTeamCounter(entry: AiTeamEntry): string | undefined {
  if (entry.counter_key === undefined || entry.counter_value === undefined) return undefined;
  return t(`overview.ai_team.counter.${entry.counter_key}`, { count: entry.counter_value });
}

export function CompanyOverview() {
  const session = useSession();
  const allowed = can(session, 'telemetry:read');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    tenantConsoleClient.getCompanyOverview()
      .then((response) => {
        setOverview(response);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        setError(cause);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    load();
  }, [allowed, load]);

  const companyName = session?.membership.tenant_name ?? '';
  const sections = overview?.sections;

  const attention = useMemo(() => overview?.attention ?? [], [overview]);
  const aiTeam = useMemo(() => overview?.ai_team ?? [], [overview]);
  const metrics = useMemo(() => overview?.today?.metrics ?? [], [overview]);
  const activity = useMemo(() => overview?.activity ?? [], [overview]);
  const workspace = overview?.workspace;

  const activityItems = useMemo(() => activity.map((item) => ({
    id: `${item.kind}-${item.run_id}-${item.occurred_at}`,
    time: formatTime(item.occurred_at),
    title: companyActivitySentence(item),
    href: `/runs/${encodeURIComponent(item.run_id)}`,
    description: t('overview.activity.href'),
  })), [activity]);

  if (!allowed) return <ErrorBanner error={new Error(t('auth.forbidden'))} />;
  if (loading) {
    return (
      <div className="space-y-8" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="card" />
        <Skeleton variant="metric" lines={4} />
      </div>
    );
  }
  if (error !== null) return <ErrorBanner error={error} onRetry={load} />;
  if (overview === null) return <ErrorBanner error={new Error(t('common.error'))} onRetry={load} />;

  const attentionTitle = (group: AttentionGroup) =>
    t(group.title_key, Object.fromEntries(Object.entries(group.params).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value])));

  return (
    <div className="space-y-8" aria-label={t('nav.overview')}>
      <PageHeader
        eyebrow={t('auth.company_workspace')}
        title={t('overview.welcome', { name: session?.identity.display_name ?? '' })}
        description={companyName}
      />

      <section aria-labelledby="overview-attention-heading">
        <SectionHeader title={t('overview.attention.title')} />
        {sections?.attention === 'ERROR' ? (
          <SectionError onRetry={load} />
        ) : attention.length === 0 ? (
          <EmptyState title={t('overview.attention.all_clear')} />
        ) : (
          <div className="space-y-2">
            {attention.map((group) => (
              <AttentionCard
                key={group.type}
                severity={group.severity}
                title={attentionTitle(group)}
                href={group.href}
                domain={domainLabel(group.domain)}
                actions={<span className="ui-attention-card__cta">{t(group.cta_key)}</span>}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="overview-ai-heading">
        <SectionHeader title={t('overview.ai_team.title')} description={t('overview.ai_team.description')} />
        {sections?.ai_team === 'ERROR' ? (
          <SectionError onRetry={load} />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {aiTeam.map((entry) => {
              const counter = aiTeamCounter(entry);
              return (
                <AgentCard
                  key={entry.domain}
                  name={domainLabel(entry.domain)}
                  purpose={t('aiTeam.description')}
                  status={entry.status}
                  {...(counter === undefined ? {} : { metric: counter })}
                  footer={t(entry.reason_key)}
                  href={`/ai-team/${entry.domain}`}
                />
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="overview-today-heading">
        <SectionHeader
          title={t('overview.today.title')}
          {...(overview.today === undefined ? {} : { description: t('overview.today.updated', { time: formatTime(overview.today.updated_at) }) })}
        />
        {sections?.today === 'ERROR' ? (
          <SectionError onRetry={load} />
        ) : metrics.length === 0 ? (
          <EmptyState title={t('overview.today.empty')} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((metric) => (
              <MetricCard
                key={`${metric.key}-${String(metric.params?.['state'] ?? '')}`}
                label={todayMetricLabel(metric)}
                value={metric.count}
                detail={t('overview.today.updated', { time: formatTime(metric.updated_at) })}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="overview-activity-heading" className="ui-section-card p-5">
        <SectionHeader title={t('overview.activity.title')} />
        {sections?.activity === 'ERROR' ? (
          <SectionError onRetry={load} />
        ) : activityItems.length === 0 ? (
          <EmptyState title={t('overview.activity.empty')} />
        ) : (
          <ActivityTimeline items={activityItems} />
        )}
      </section>

      {workspace !== undefined ? (
        <section aria-labelledby="overview-workspace-heading" className="ui-section-card p-5">
          <SectionHeader
            title={t('overview.workspace.title')}
            description={t('overview.workspace.status', { status: t(statusView('tenant', workspace.status).label_key) })}
          />
          {sections?.workspace === 'ERROR' ? (
            <SectionError onRetry={load} />
          ) : (
            <ul className="space-y-2">
              {workspace.checklist.map((item) => (
                <li key={item.key}>
                  <a href={item.href} className="ui-focus-ring">
                    <span aria-hidden="true">{item.done ? '✓' : '○'}</span> {t(item.label_key)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

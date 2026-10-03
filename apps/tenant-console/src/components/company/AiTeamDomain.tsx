'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  ActivityTimeline,
  Button,
  EmptyState,
  ErrorState,
  KeyValueList,
  PageHeader,
  SectionHeader,
  Skeleton,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import type {
  AiTeamDomain,
  AiTeamDomainResponse,
  AiTeamPrerequisite,
  CompanyActivityItem,
  CompanySkill,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { SalesTryChat } from '../testing/SalesTryChat';
import { reasonLabel, unmetFromError } from './AiTeamConsole';
import { companyActivitySentence } from './company-activity';

const TABS: readonly { readonly segment: string; readonly labelKey: string }[] = [
  { segment: '', labelKey: 'aiTeam.tabs.overview' },
  { segment: 'skills', labelKey: 'aiTeam.tabs.skills' },
  { segment: 'sources', labelKey: 'aiTeam.tabs.sources' },
  { segment: 'try', labelKey: 'aiTeam.tabs.try' },
  { segment: 'technical', labelKey: 'aiTeam.tabs.technical' },
];

export function AiTeamTabs({ domain }: { readonly domain: AiTeamDomain }) {
  const pathname = usePathname();
  const base = `/ai-team/${domain}`;
  return (
    <nav aria-label={t('aiTeam.title')} className="flex flex-wrap gap-1 border-b border-line">
      {TABS.map((tab) => {
        const href = tab.segment === '' ? base : `${base}/${tab.segment}`;
        const active = tab.segment === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={tab.segment}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`ui-focus-ring rounded-t-lg px-3 py-2 text-sm font-medium ${active ? 'bg-surface text-brand' : 'text-muted hover:text-ink'}`}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function AiTeamDomainOverview({ domain }: { readonly domain: AiTeamDomain }) {
  const [detail, setDetail] = useState<AiTeamDomainResponse | null>(null);
  const [activity, setActivity] = useState<readonly CompanyActivityItem[]>([]);
  const [unmet, setUnmet] = useState<readonly AiTeamPrerequisite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    void Promise.allSettled([
      tenantConsoleClient.getAiTeamDomain(domain),
      tenantConsoleClient.getCompanyActivity({ limit: 20 }),
    ]).then(([detailResult, activityResult]) => {
      if (detailResult.status === 'fulfilled') setDetail(detailResult.value);
      if (activityResult.status === 'fulfilled') {
        setActivity(activityResult.value.items.filter((item) => item.domain === domain));
      }
      setLoading(false);
    });
  }, [domain]);

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(() => {
    const action = detail?.activation_status === 'ACTIVE' ? 'pause' : 'activate';
    setBusy(true);
    void tenantConsoleClient
      .changeAiTeamDomain(domain, action)
      .then((response) => { setDetail(response); setUnmet([]); })
      .catch((error: unknown) => setUnmet(unmetFromError(error)))
      .finally(() => setBusy(false));
  }, [domain, detail]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
    );
  }

  const status = detail?.activation_status ?? 'NOT_ACTIVATED';
  const agent = detail?.agent;
  const attention = (agent?.pending_approvals ?? 0) + (agent?.open_handoffs ?? 0);
  const visibleUnmet = unmet.length > 0 ? unmet : (detail?.unmet ?? []);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(`aiTeam.${domain}.name`)}
        description={t(`aiTeam.${domain}.purpose`)}
        actions={<div className="flex items-center gap-3"><StatusBadge code={status} /><Button size="sm" loading={busy} onClick={toggle}>{status === 'ACTIVE' ? t('aiTeam.card.pause') : t('aiTeam.card.activate')}</Button></div>}
      />
      {visibleUnmet.length > 0 ? (
        <div>
          <p className="text-sm font-medium text-warning">{t('aiTeam.card.prerequisites')}</p>
          <ul className="mt-1 space-y-1 text-sm text-muted">
            {visibleUnmet.map((prerequisite) => (
              <li key={prerequisite.reason_key} className="flex flex-wrap items-center justify-between gap-2">
                <span>{reasonLabel(prerequisite.reason_key)}</span>
                <Link href={prerequisite.cta.href} className="ui-focus-ring font-semibold text-brand hover:text-brand-deep">
                  {t(prerequisite.cta.label_key)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <section className="ui-surface p-5">
        <SectionHeader title={t('aiTeam.overview.current')} />
        {agent?.runs_today ? <p className="mt-2 text-sm text-ink">{t('aiTeam.card.attention_count', { count: agent.runs_today })}</p> : <EmptyState title={t('aiTeam.card.no_activity')} status="NO_DATA" />}
        {attention > 0 ? <p className="mt-2 text-sm text-warning">{t('aiTeam.overview.attention')}: {t('aiTeam.card.attention_count', { count: attention })}</p> : null}
      </section>
      <section className="ui-surface p-5">
        <SectionHeader title={t('aiTeam.overview.recent')} />
        {activity.length === 0
          ? <EmptyState title={t('aiTeam.runs.empty')} status="NO_DATA" />
          : (
            <ActivityTimeline
              items={activity.map((item) => ({
                id: `${item.kind}-${item.run_id}-${item.occurred_at}`,
                time: new Date(item.occurred_at).toLocaleString('vi-VN'),
                title: companyActivitySentence(item),
                ...(item.run_id ? { href: `/runs/${encodeURIComponent(item.run_id)}` } : {}),
              }))}
            />
          )}
      </section>
    </div>
  );
}

export function AiTeamSources({ domain }: { readonly domain: AiTeamDomain }) {
  return (
    <section className="ui-surface space-y-4 p-5">
      <SectionHeader title={t('aiTeam.sources.title')} description={t('aiTeam.sources.description')} />
      <p className="text-sm text-muted">{domain === 'care' ? t('aiTeam.sources.knowledge') : t('aiTeam.sources.connectors')}</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/integrations" className="ui-button ui-button--secondary ui-button--sm ui-focus-ring">{t('aiTeam.sources.open_connectors')}</Link>
        <Link href="/knowledge" className="ui-button ui-button--secondary ui-button--sm ui-focus-ring">{t('aiTeam.sources.open_knowledge')}</Link>
      </div>
    </section>
  );
}

export function AiTeamTry({ domain }: { readonly domain: AiTeamDomain }) {
  return (
    <section className="ui-surface space-y-4 p-5">
      <SectionHeader title={t('aiTeam.try.title')} description={t('aiTeam.try.description')} />
      {domain === 'sales' ? (
        <Link href="/ai-team/sales/try" className="ui-button ui-button--primary ui-button--sm ui-focus-ring">
          {t('aiTeam.try.sales_action')}
        </Link>
      ) : domain === 'care' ? (
        <SalesTryChat promptSuggestion={t('aiTeam.try.care_question')} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('aiTeam.try.marketing_preview_description')}</p>
          <Link href="/campaigns/new" className="ui-button ui-button--primary ui-button--sm ui-focus-ring">
            {t('aiTeam.try.marketing_preview_action')}
          </Link>
        </div>
      )}
    </section>
  );
}

export function AiTeamTechnical({
  domain,
  detail,
  skills,
  skillsError,
  onRetry,
}: {
  readonly domain: AiTeamDomain;
  readonly detail: AiTeamDomainResponse | null;
  readonly skills: readonly CompanySkill[];
  readonly skillsError: boolean;
  readonly onRetry: () => void;
}) {
  const agent = detail?.agent;
  const items = [
    { key: 'domain', label: t('aiTeam.technical.agent_code'), value: domain },
    { key: 'status', label: t('aiTeam.technical.readiness'), value: <StatusBadge code={detail?.activation_status ?? agent?.status ?? 'NO_DATA'} /> },
    { key: 'enabled', label: t('aiTeam.technical.enabled'), value: agent?.enabled === undefined ? undefined : (agent.enabled ? t('common.confirm') : t('common.close')) },
    { key: 'autonomy', label: t('aiTeam.technical.autonomy'), value: agent?.readiness ?? undefined },
  ];
  return (
    <section className="ui-surface space-y-4 p-5">
      <SectionHeader title={t('aiTeam.technical.title')} />
      <KeyValueList items={items} />
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">{t('aiTeam.technical.skill_authority')}</h3>
        {skillsError ? (
          <ErrorState message={t('common.error')} onRetry={onRetry} />
        ) : skills.length === 0 ? (
          <div className="space-y-3">
            <EmptyState title={t('skills.empty')} status="NO_DATA" />
            <Link href={`/ai-team/${domain}/skills`} className="ui-button ui-button--secondary ui-button--sm ui-focus-ring">
              {t('aiTeam.tabs.skills')}
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {skills.map((skill) => {
              const label = t(skill.display_key);
              return (
                <li key={skill.skill_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="font-medium text-ink">{label === skill.display_key ? skill.skill_id : label}</span>
                  <span className="text-sm text-muted">{skill.required_authority}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export function AiTeamTechnicalPanel({ domain }: { readonly domain: AiTeamDomain }) {
  const [detail, setDetail] = useState<AiTeamDomainResponse | null>(null);
  const [skills, setSkills] = useState<readonly CompanySkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDetailError(false);
    setSkillsError(false);
    void Promise.allSettled([
      tenantConsoleClient.getAiTeamDomain(domain),
      tenantConsoleClient.getSkills(),
    ] as const).then(([detailResult, skillsResult]) => {
      if (!active) return;
      if (detailResult.status === 'fulfilled') setDetail(detailResult.value);
      else {
        setDetail(null);
        setDetailError(true);
      }
      if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value.skills.filter((skill) => skill.domain === domain));
      else {
        setSkills([]);
        setSkillsError(true);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [domain, reload]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="card" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {detailError ? <ErrorState message={t('common.error')} onRetry={() => setReload((current) => current + 1)} /> : null}
      <AiTeamTechnical
        domain={domain}
        detail={detail}
        skills={skills}
        skillsError={skillsError}
        onRetry={() => setReload((current) => current + 1)}
      />
    </div>
  );
}

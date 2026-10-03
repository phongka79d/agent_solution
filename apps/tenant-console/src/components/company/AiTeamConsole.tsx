'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '@agentos/ui-foundation/react';
import type {
  AiTeamActivationAction,
  AiTeamDomain,
  AiTeamDomainResponse,
  AiTeamPrerequisite,
  CompanyActivityItem,
  CompanyAiTeamAgent,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

export type { AiTeamDomain };

const DOMAINS: readonly AiTeamDomain[] = ['marketing', 'sales', 'care'];

type DomainState = Partial<Record<AiTeamDomain, AiTeamDomainResponse>>;

/** Runtime guard for the prerequisite shape carried in an activation 409 `details.unmet`. */
function isPrerequisite(entry: unknown): entry is AiTeamPrerequisite {
  if (typeof entry !== 'object' || entry === null) return false;
  if (!('reason_key' in entry) || typeof entry.reason_key !== 'string') return false;
  if (!('cta' in entry) || typeof entry.cta !== 'object' || entry.cta === null) return false;
  return 'href' in entry.cta && typeof entry.cta.href === 'string'
    && 'label_key' in entry.cta && typeof entry.cta.label_key === 'string';
}

/** Reads the unmet prerequisites the activation 409 carries in `details.unmet`. */
export function unmetFromError(error: unknown): readonly AiTeamPrerequisite[] {
  if (typeof error !== 'object' || error === null || !('details' in error)) return [];
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('unmet' in details)) return [];
  const unmet = details.unmet;
  return Array.isArray(unmet) ? unmet.filter(isPrerequisite) : [];
}

export function reasonLabel(reasonKey: string): string {
  const key = `aiTeam.reason.${reasonKey}`;
  const label = t(key);
  return label === key ? t('aiTeam.reason.unknown') : label;
}

function prerequisiteRow(prerequisite: AiTeamPrerequisite) {
  return (
    <li key={prerequisite.reason_key} className="flex flex-wrap items-center justify-between gap-2">
      <span>{reasonLabel(prerequisite.reason_key)}</span>
      <Link href={prerequisite.cta.href} className="ui-focus-ring font-semibold text-brand hover:text-brand-deep">
        {t(prerequisite.cta.label_key)}
      </Link>
    </li>
  );
}

function AiTeamCard({
  domain,
  agent,
  detail,
  activityItems,
  unmetOverride,
  busy,
  onActivate,
}: {
  readonly domain: AiTeamDomain;
  readonly agent: CompanyAiTeamAgent | undefined;
  readonly detail: AiTeamDomainResponse | undefined;
  readonly activityItems: readonly CompanyActivityItem[];
  readonly unmetOverride: readonly AiTeamPrerequisite[];
  readonly busy: boolean;
  readonly onActivate: (domain: AiTeamDomain) => void;
}) {
  const status = detail?.activation_status ?? agent?.status ?? 'NO_DATA';
  const unmet = unmetOverride.length > 0 ? unmetOverride : (detail?.unmet ?? []);
  const active = status === 'ACTIVE';
  const attention = (agent?.pending_approvals ?? 0) + (agent?.open_handoffs ?? 0);
  const activity = activityItems.filter((item) => item.domain === domain).length;
  const action: AiTeamActivationAction = status === 'PAUSED' ? 'resume' : 'activate';

  return (
    <article className="ui-surface flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{t(`aiTeam.${domain}.name`)}</h3>
          <p className="mt-1 text-sm text-muted">{t(`aiTeam.${domain}.purpose`)}</p>
        </div>
        <StatusBadge code={status} />
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-muted">{t('aiTeam.card.activity')}</dt>
          <dd className="font-medium text-ink">
            {activity > 0 ? t('aiTeam.card.attention_count', { count: activity }) : t('aiTeam.card.no_activity')}
          </dd>
        </div>
        <div>
          <dt className="text-muted">{t('aiTeam.card.needs_attention')}</dt>
          <dd className="font-medium text-ink">
            {attention > 0 ? t('aiTeam.card.attention_count', { count: attention }) : t('common.empty')}
          </dd>
        </div>
      </dl>

      {unmet.length > 0 ? (
        <div>
          <p className="text-sm font-medium text-warning">{t('aiTeam.card.prerequisites')}</p>
          <ul className="mt-1 space-y-1 text-sm text-muted">{unmet.map(prerequisiteRow)}</ul>
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-2">
        {active ? (
          <Link href={`/ai-team/${domain}`} className="ui-button ui-button--secondary ui-button--sm ui-focus-ring">
            {t('aiTeam.card.view')}
          </Link>
        ) : (
          <Button size="sm" variant="primary" loading={busy} loadingLabel={t('aiTeam.card.activating')} onClick={() => onActivate(domain)}>
            {t(action === 'resume' ? 'aiTeam.card.resume' : 'aiTeam.card.activate')}
          </Button>
        )}
        {!active ? (
          <Link href={`/ai-team/${domain}`} className="ui-focus-ring text-sm font-semibold text-brand hover:text-brand-deep">
            {t('aiTeam.card.view')}
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function AiTeamConsole() {
  const [agents, setAgents] = useState<readonly CompanyAiTeamAgent[]>([]);
  const [activity, setActivity] = useState<readonly CompanyActivityItem[]>([]);
  const [details, setDetails] = useState<DomainState>({});
  const [unmetByDomain, setUnmetByDomain] = useState<Partial<Record<AiTeamDomain, readonly AiTeamPrerequisite[]>>>({});
  const [busy, setBusy] = useState<AiTeamDomain | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    void Promise.allSettled([
      tenantConsoleClient.getCompanyAiTeam(),
      tenantConsoleClient.getCompanyActivity({ limit: 20 }),
      ...DOMAINS.map((domain) => tenantConsoleClient.getAiTeamDomain(domain)),
    ]).then((results) => {
      const [agentsResult, activityResult, ...domainResults] = results;
      if (agentsResult?.status === 'fulfilled') setAgents(agentsResult.value.agents);
      if (activityResult?.status === 'fulfilled') setActivity(activityResult.value.items);
      const nextDetails: DomainState = {};
      DOMAINS.forEach((domain, index) => {
        const result = domainResults[index];
        if (result?.status === 'fulfilled') nextDetails[domain] = result.value;
      });
      setDetails(nextDetails);
      if (agentsResult?.status === 'rejected' && activityResult?.status === 'rejected') setFailed(true);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const activate = useCallback((domain: AiTeamDomain) => {
    setBusy(domain);
    void tenantConsoleClient
      .changeAiTeamDomain(domain, (details[domain]?.activation_status ?? 'NOT_ACTIVATED') === 'PAUSED' ? 'resume' : 'activate')
      .then((response) => {
        setDetails((current) => ({ ...current, [domain]: response }));
        setUnmetByDomain((current) => ({ ...current, [domain]: [] }));
      })
      .catch((error: unknown) => {
        setUnmetByDomain((current) => ({ ...current, [domain]: unmetFromError(error) }));
      })
      .finally(() => setBusy(null));
  }, [details]);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('aiTeam.title')} description={t('aiTeam.description')} />
      {failed ? <ErrorState message={t('common.error')} onRetry={load} /> : null}
      {agents.length === 0 && !failed
        ? <EmptyState title={t('common.empty')} status="NO_DATA" />
        : (
          <div className="grid gap-4 md:grid-cols-3">
            {DOMAINS.map((domain) => (
              <AiTeamCard
                key={domain}
                domain={domain}
                agent={agents.find((entry) => entry.domain === domain)}
                detail={details[domain]}
                activityItems={activity}
                unmetOverride={unmetByDomain[domain] ?? []}
                busy={busy === domain}
                onActivate={activate}
              />
            ))}
          </div>
        )}
    </div>
  );
}

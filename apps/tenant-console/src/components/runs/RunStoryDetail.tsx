'use client';

import Link from 'next/link';
import { useApi } from '@agentos/ui-foundation/data';
import { t } from '@agentos/ui-foundation/i18n';
import { statusView } from '@agentos/ui-foundation/status';
import { AdvancedDetails, EmptyState, ErrorBanner, PageHeader, SectionHeader, Skeleton, StatusBadge } from '@agentos/ui-foundation/react';

type RunDomain = 'sales' | 'care' | 'marketing' | 'platform';
type Scalar = string | number;
type Summary = Readonly<Record<string, unknown>>;

interface RunStoryStep {
  readonly name: string;
  readonly status: string;
  readonly duration_ms: number;
  readonly summary_key: string | null;
  readonly summary: Summary;
}

interface RunStory {
  readonly domain: RunDomain;
  readonly title_key: string;
  readonly title_params: Readonly<Record<string, Scalar>>;
  readonly state: string;
  readonly retries: number;
  readonly retry_eligibility: { readonly retryable: boolean; readonly reason_code: string };
  readonly steps: readonly RunStoryStep[];
  readonly final_outcome: { readonly status: string; readonly reason_key: string | null };
  readonly duration_ms: number;
}

const BACK_LINKS: Readonly<Record<RunDomain, string>> = {
  sales: '/conversations',
  care: '/conversations',
  marketing: '/campaigns',
  platform: '/ai-team',
};


function durationLabel(duration_ms: number): string {
  if (duration_ms < 1000) return `${Math.max(0, Math.round(duration_ms))} ms`;
  const seconds = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(duration_ms / 1000);
  return `${seconds} giây`;
}

function summaryText(summary: Summary): string | null {
  if (typeof summary['customer_verified'] === 'boolean') {
    return t(summary['customer_verified'] ? 'company.run.summary.customer_verified' : 'company.run.summary.customer_unverified');
  }
  if (Array.isArray(summary['steps'])) return t('company.run.summary.plan_steps', { count: summary['steps'].length });
  if (typeof summary['intent'] === 'string') return t('company.run.summary.intent');
  if (typeof summary['attempts'] === 'number') return t('company.run.summary.attempts', { count: summary['attempts'] });
  return null;
}

function nextAction(story: RunStory): { readonly href: string; readonly label_key: string } | null {
  if (story.state === 'AWAITING_HUMAN_APPROVAL') return { href: '/approvals', label_key: 'company.run.action.approvals' };
  if (story.state === 'NEEDS_RECONCILIATION') return { href: '/integrations', label_key: 'company.run.action.connections' };
  if (story.state !== 'FAILED') return null;
  if (story.domain === 'marketing') return { href: '/campaigns', label_key: 'company.run.action.campaigns' };
  return { href: '/integrations', label_key: 'company.run.action.connections' };
}

function failureText(story: RunStory): string | null {
  if (story.state === 'NEEDS_RECONCILIATION') return t('company.run.failure.reconciliation');
  if (story.state !== 'FAILED') return null;
  return t(story.retry_eligibility.retryable ? 'company.run.failure.retryable' : 'company.run.failure.blocked');
}

export function RunStoryDetail({ runId }: { readonly runId: string }) {
  const story = useApi<RunStory>(`/api/v1/runs/${encodeURIComponent(runId)}/story`);
  if (story.loading) return <Skeleton variant="card" />;
  if (story.error) return <ErrorBanner error={story.error} onRetry={story.refresh} />;
  const data = story.data;
  if (data === null) return <EmptyState status="NOT_FOUND" title={t('common.empty')} />;

  const state = statusView('run', data.state);
  const action = nextAction(data);
  const failure = failureText(data);
  return (
    <div className="space-y-6">
      <PageHeader
        title={t(data.title_key, data.title_params)}
        description={t('runs.title')}
        actions={<Link href={BACK_LINKS[data.domain]} className="ui-button ui-button--secondary">Quay lại</Link>}
      />
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionHeader title={t('company.run.outcome')} />
            <p className="mt-2 text-sm text-muted">{durationLabel(data.duration_ms)}</p>
          </div>
          <StatusBadge tone={state.tone} label={t(state.label_key)} />
        </div>
        <p className="mt-3 text-sm text-muted">{t('company.run.retries', { count: data.retries })}</p>
      </section>

      {failure ? (
        <section role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-5">
          <h2 className="text-sm font-semibold text-danger">{failure}</h2>
          {action ? <Link href={action.href} className="mt-3 inline-block text-sm font-medium text-primary hover:underline">{t(action.label_key)} →</Link> : null}
        </section>
      ) : data.state === 'AWAITING_HUMAN_APPROVAL' && action ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <p className="text-sm text-ink">{t('status.approval_pending')}</p>
          <Link href={action.href} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">{t(action.label_key)} →</Link>
        </section>
      ) : null}

      <section className="rounded-xl border border-line bg-surface p-5">
        <SectionHeader title={t('company.run.steps')} />
        {data.steps.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t('company.run.steps.empty')}</p>
        ) : (
          <ol className="mt-3 divide-y divide-line">
            {data.steps.map((step, index) => {
              const stepState = statusView('run', step.status);
              const summary = summaryText(step.summary);
              return (
                <li key={`${step.name}-${index}`} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <h3 className="font-medium text-ink">{step.name}</h3>
                    {summary ? <p className="mt-1 text-sm text-muted">{summary}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusBadge tone={stepState.tone} label={t(stepState.label_key)} />
                    {step.duration_ms > 0 ? <span className="text-xs text-muted">{durationLabel(step.duration_ms)}</span> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <AdvancedDetails summary="Chi tiết kỹ thuật">
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <div><dt className="text-muted">run_id</dt><dd className="break-all font-mono text-ink">{runId}</dd></div>
          <div><dt className="text-muted">domain</dt><dd className="font-mono text-ink">{data.domain}</dd></div>
          <div><dt className="text-muted">state</dt><dd className="font-mono text-ink">{data.state}</dd></div>
          <div><dt className="text-muted">retry_eligibility</dt><dd className="font-mono text-ink">{data.retry_eligibility.reason_code}</dd></div>
          {data.final_outcome.reason_key ? <div><dt className="text-muted">reason_key</dt><dd className="font-mono text-ink">{data.final_outcome.reason_key}</dd></div> : null}
        </dl>
        <pre className="mt-4 overflow-auto rounded-md bg-canvas p-3 text-xs text-muted">{JSON.stringify(data.steps.map((step) => ({ summary_key: step.summary_key, summary: step.summary })), null, 2)}</pre>
      </AdvancedDetails>
    </div>
  );
}

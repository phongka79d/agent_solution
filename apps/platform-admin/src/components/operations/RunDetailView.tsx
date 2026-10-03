/**
 * Platform-scoped run diagnostics. The API projection is allowlisted before it reaches this view;
 * export keeps that same boundary and never downloads raw task, provider, evidence, or audit payloads.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApi } from '@agentos/ui-foundation/data';
import { t } from '@agentos/ui-foundation/i18n';
import { ErrorBanner, Skeleton, StageTimeline, StatusBadge } from '@agentos/ui-foundation/react';
import type { StageState, StageTimelineItem } from '@agentos/ui-foundation/react';
import { buildRunDetailExportJson, failureLabel, formatDuration, formatTimestamp, reconciliationReasonLabel } from './format';
import { ReconcileModal } from './ReconcileModal';
import { RetryRunModal } from './RetryRunModal';
import type { PlatformReconciliationItem, PlatformRunDetail, PlatformRunTrace } from './types';

const RUN_STAGES: readonly string[] = [
  'SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN',
  'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
];

const STAGE_LABEL_KEYS: Readonly<Record<string, string>> = {
  SIGNAL: 'platform.run_detail.stage_signal',
  CONTEXT: 'platform.run_detail.stage_context',
  HYPOTHESIS: 'platform.run_detail.stage_hypothesis',
  DECISION: 'platform.run_detail.stage_decision',
  PLAN: 'platform.run_detail.stage_plan',
  ACTION: 'platform.run_detail.stage_action',
  APPROVAL: 'platform.run_detail.stage_approval',
  EXECUTION: 'platform.run_detail.stage_execution',
  EVIDENCE: 'platform.run_detail.stage_evidence',
  OUTCOME: 'platform.run_detail.stage_outcome',
  LEARNING: 'platform.run_detail.stage_learning',
};

const STATUS_TO_STAGE: Readonly<Record<string, StageState>> = {
  completed: 'done',
  failed: 'failed',
  refused: 'failed',
  awaiting_human: 'active',
};

function stageTimeline(trace: PlatformRunTrace | null): readonly StageTimelineItem[] {
  return RUN_STAGES.map((stage) => {
    const record = [...(trace?.stages ?? [])].reverse().find((entry) => entry.stage === stage);
    const state: StageState = record === undefined ? 'pending' : (STATUS_TO_STAGE[record.status] ?? 'active');
    const evidenceRefs = record?.evidence_refs ?? [];
    const detail = record === undefined ? null : (
      <>
        {record.skill_id ?? record.agent_code ?? '—'} · {formatDuration(record.duration_ms)}
        {record.summary_key ? ` · ${record.summary_key}` : ''}
        {Object.keys(record.detail).length > 0 ? ` · ${JSON.stringify(record.detail)}` : ''}
        {record.error_class ? ` · ${failureLabel(record.error_class)}` : ''}
        {evidenceRefs.length > 0
          ? ` · ${t('platform.run_detail.evidence_refs')}: ${evidenceRefs.join(', ')}`
          : ''}
      </>
    );
    return {
      key: stage,
      label: t(STAGE_LABEL_KEYS[stage] ?? stage),
      state,
      at: record?.started_at ?? null,
      detail,
    };
  });
}

function reconciliationFromDetail(detail: PlatformRunDetail): PlatformReconciliationItem {
  return {
    tenant_id: detail.tenant_id,
    display_name: detail.display_name,
    run_id: detail.run_id,
    domain: detail.domain,
    state: detail.state,
    failure_class: detail.failure_class,
    attempts: detail.attempts,
    max_retries: detail.max_retries,
    reason: 'INDETERMINATE_OUTCOME',
    correlation_id: detail.correlation_id,
    updated_at: detail.updated_at,
  };
}

export function RunDetailView({ companyId, runId }: { readonly companyId: string; readonly runId: string }) {
  const detail = useApi<PlatformRunDetail>(
    `/api/v1/platform/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}`,
    { pollMs: 10_000 },
  );
  const trace = useApi<PlatformRunTrace>(
    `/api/v1/platform/companies/${encodeURIComponent(companyId)}/runs/${encodeURIComponent(runId)}/trace`,
    { pollMs: 10_000 },
  );
  const [retryOpen, setRetryOpen] = useState(false);
  const [reconcile, setReconcile] = useState<PlatformReconciliationItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const run = detail.data;

  async function copyCorrelationId(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(run?.correlation_id ?? '');
      setCopyNotice(t('platform.run_detail.copied'));
    } catch {
      setCopyNotice(t('platform.run_detail.copy_failed'));
    }
  }

  function downloadTrace(): void {
    if (run === null || trace.data === null) return;
    const blob = new Blob([buildRunDetailExportJson(run, trace.data)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `run-${run.run_id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }

  return (
    <div className="space-y-5">
      <div>
        <Link href="/operations" className="text-xs text-brand hover:underline">&larr; {t('platform.run_detail.back_to_operations')}</Link>
      </div>
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('platform.run_detail.title')}</p>
        <h1 className="font-mono text-xl font-semibold text-ink">{runId}</h1>
        {run ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <StatusBadge code={run.state.toUpperCase()} />
            <span>{run.display_name}</span>
            <span>{t('platform.run_detail.domain')}: {run.domain}</span>
            <span>{t('platform.run_detail.attempts')}: {run.attempts}/{run.max_retries}</span>
            <span>{t('platform.run_detail.duration')}: {formatDuration(run.duration_ms)}</span>
            <span>{t('platform.run_detail.lease_expiry')}: {formatTimestamp(run.lease_expires_at)}</span>
            <span>
              {t('platform.run_detail.lease_owner')}: {run.lease_owner ?? '—'}
            </span>
            <span>
              {t('platform.run_detail.cost')}:{' '}
              {run.cost_breakdown.length === 0
                ? t('platform.usage_unrecorded')
                : run.cost_breakdown.map((cost) => (
                  cost.cost_recorded
                    ? `${cost.cost_total ?? '—'}${cost.currency ? ` ${cost.currency}` : ''}`
                    : t('platform.usage_unrecorded')
                )).join(', ')}
            </span>
            <span>
              {t('platform.run_detail.tokens')}: {t('platform.run_detail.input_tokens')} {run.input_tokens_total.toLocaleString()} ·{' '}
              {t('platform.run_detail.output_tokens')} {run.output_tokens_total.toLocaleString()} ·{' '}
              {t('platform.run_detail.cached_tokens')} {run.cached_tokens_total.toLocaleString()}
            </span>
            <button
              type="button"
              className="ui-button ui-button--secondary ui-button--compact font-mono"
              aria-label={t('platform.run_detail.copy_correlation')}
              onClick={() => { void copyCorrelationId(); }}
            >
              {t('platform.run_detail.copy_correlation')}: {run.correlation_id}
            </button>
          </div>
        ) : null}
        {copyNotice ? <p className="text-xs text-muted" role="status">{copyNotice}</p> : null}
      </header>

      {notice ? <div role="status" className="platform-alert platform-alert--success text-xs">{notice}</div> : null}
      {detail.error ? <ErrorBanner error={detail.error} onRetry={detail.refresh} /> : null}
      {detail.loading && run === null ? <Skeleton variant="card" /> : null}

      {run ? (
        <section className="platform-card space-y-2 p-4">
          <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.reconcile_actions')}</h2>
          <p className="text-sm text-muted">
            {t('platform.run_detail.failure_cause')}: {failureLabel(run.failure_class)}
            {run.state === 'waiting' ? ` · ${reconciliationReasonLabel('INDETERMINATE_OUTCOME')}` : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {run.retry_eligible ? (
              <button type="button" className="ui-button ui-button--danger ui-button--compact" onClick={() => setRetryOpen(true)}>{t('platform.run_detail.retry')}</button>
            ) : run.state === 'waiting' ? (
              <button type="button" className="ui-button ui-button--primary ui-button--compact" onClick={() => setReconcile(reconciliationFromDetail(run))}>{t('platform.run_detail.reconcile')}</button>
            ) : null}
          </div>
        </section>
      ) : null}

      <details className="platform-card space-y-2 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink">{t('platform.run_detail.advanced')}</summary>
        {run ? (
          <dl className="grid gap-2 pt-2 text-xs sm:grid-cols-2">
            <div><dt className="text-muted">{t('platform.run_detail.conversation_id')}</dt><dd className="break-all font-mono" id={run.conversation_id ? `conversation-${run.conversation_id}` : undefined}>{run.conversation_id ?? '—'}</dd></div>
            <div><dt className="text-muted">{t('platform.run_detail.correlation_id')}</dt><dd className="break-all font-mono">{run.correlation_id}</dd></div>
            <div><dt className="text-muted">{t('platform.run_detail.task_version')}</dt><dd>{run.task_version}</dd></div>
            <div><dt className="text-muted">{t('platform.run_detail.error_code')}</dt><dd>{run.error_code ?? '—'}</dd></div>
            <div><dt className="text-muted">{t('platform.run_detail.stage_event_count')}</dt><dd>{run.stage_event_count}</dd></div>
            <div><dt className="text-muted">{t('platform.run_detail.evidence_count')}</dt><dd>{run.evidence_count}</dd></div>
            {trace.data?.approval_id ? (
              <div>
                <dt className="text-muted">{t('platform.run_detail.approvals')}</dt>
                <dd className="break-all font-mono">
                  <a className="text-brand hover:underline" href={`#approval-${encodeURIComponent(trace.data.approval_id)}`}>
                    {trace.data.approval_id}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {run && trace.data ? (
          <button type="button" className="ui-button ui-button--secondary ui-button--compact" onClick={downloadTrace}>
            {t('platform.run_detail.export')}
          </button>
        ) : null}
      </details>

      <section className="platform-card space-y-3 p-4">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.stages')}</h2>
        {trace.error ? <ErrorBanner error={trace.error} onRetry={trace.refresh} /> : null}
        {trace.loading && trace.data === null ? <Skeleton variant="text" lines={6} /> : <StageTimeline stages={stageTimeline(trace.data)} />}
      </section>

      <section className="platform-card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.provider_calls')}</h2>
        <div className="overflow-x-auto rounded-md border border-line" tabIndex={0}>
          <table className="ui-table min-w-[740px] text-xs" role="table">
            <thead>
              <tr>
                <th scope="col">{t('platform.run_detail.provider')} / {t('platform.usage_model')}</th>
                <th scope="col" className="ui-table__numeric">{t('platform.run_detail.latency')}</th>
                <th scope="col" className="ui-table__numeric">{t('platform.input_tokens')}</th>
                <th scope="col" className="ui-table__numeric">{t('platform.output_tokens')}</th>
                <th scope="col">{t('platform.cost')}</th>
                <th scope="col">{t('platform.run_detail.outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {(trace.data?.provider_calls ?? []).length === 0 && (
                <tr><td colSpan={6} className="text-center text-muted">{t('platform.run_detail.no_provider_calls')}</td></tr>
              )}
              {(trace.data?.provider_calls ?? []).map((call, index) => (
                <tr key={`${call.model}-${index}`} className="text-ink-body">
                  <td>{call.provider} · {call.model}</td>
                  <td className="ui-table__numeric">{formatDuration(call.latency_ms)}</td>
                  <td className="ui-table__numeric">{call.input_tokens ?? '—'}</td>
                  <td className="ui-table__numeric">{call.output_tokens ?? '—'}</td>
                  <td>{call.estimated_cost_amount === null ? '—' : `${call.estimated_cost_amount} ${call.currency ?? ''}`}</td>
                  <td>{call.outcome}{call.cost_status ? ` · ${call.cost_status}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">{t('platform.run_detail.effect_key')}: {(trace.data?.effect_keys ?? []).join(', ') || '—'}</p>
      </section>

      <section className="platform-card space-y-3 p-4">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.steps')}</h2>
        <div className="overflow-x-auto rounded-md border border-line" tabIndex={0}>
          <table className="ui-table min-w-[1320px] text-xs" role="table">
            <thead>
              <tr>
                <th scope="col">{t('platform.run_detail.agent')}</th>
                <th scope="col">{t('platform.run_detail.skill')}</th>
                <th scope="col">{t('platform.run_detail.tool_binding')}</th>
                <th scope="col">{t('platform.run_detail.authority')}</th>
                <th scope="col">{t('platform.run_detail.execution_status')}</th>
                <th scope="col">{t('platform.run_detail.autonomy_decision')}</th>
                <th scope="col">{t('platform.run_detail.effect_key')}</th>
                <th scope="col">{t('platform.run_detail.receipt_ref')}</th>
                <th scope="col">{t('platform.run_detail.error_code')} / {t('platform.run_detail.error_hint')}</th>
              </tr>
            </thead>
            <tbody>
              {(trace.data?.steps ?? []).length === 0 && (
                <tr><td colSpan={9} className="text-center text-muted">{t('platform.run_detail.no_steps')}</td></tr>
              )}
              {(trace.data?.steps ?? []).map((step) => (
                <tr key={`${step.step_index}:${step.skill}`} className="text-ink-body">
                  <td>{step.agent}</td>
                  <td title={step.skill}>{step.skill.split('.').at(-1)?.replaceAll('_', ' ') ?? step.skill}</td>
                  <td>{step.tool_binding}</td>
                  <td>{step.authority}</td>
                  <td>{step.execution_status}</td>
                  <td>{Object.entries(step.autonomy_decision).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—'}</td>
                  <td>
                    {step.effect_key ?? '—'}
                    {step.reservation_status ? <span className="block text-muted">{t('platform.run_detail.reservation_status')}: {step.reservation_status}</span> : null}
                  </td>
                  <td className="font-mono">{step.receipt_ref ?? '—'}</td>
                  <td>
                    {step.error_code ?? '—'}
                    {step.error_hint ? <span className="block text-muted">{step.error_hint}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="platform-card space-y-2 p-4" id="run-approvals">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.approvals')}</h2>
        {(trace.data?.approvals ?? []).length === 0 ? <p className="text-xs text-muted">{t('platform.run_detail.no_approvals')}</p> : (
          <ul className="space-y-2 text-xs">
            {(trace.data?.approvals ?? []).map((approval) => (
              <li key={approval.approval_id} id={`approval-${approval.approval_id}`} className="flex flex-wrap gap-x-3">
                <span className="font-mono">{approval.approval_id}</span>
                <span>{approval.status}</span>
                <span>{t('platform.run_detail.effect_key')}: {approval.effect_key}</span>
                <time>{formatTimestamp(approval.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="platform-card space-y-2 p-4" id="run-handoffs">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.handoffs')}</h2>
        {(trace.data?.handoffs ?? []).length === 0 ? <p className="text-xs text-muted">{t('platform.run_detail.no_handoffs')}</p> : (
          <ul className="space-y-2 text-xs">
            {(trace.data?.handoffs ?? []).map((handoff) => (
              <li key={handoff.handoff_id} className="flex flex-wrap gap-x-3">
                <a className="font-mono text-brand hover:underline" href={`#conversation-${encodeURIComponent(handoff.conversation_id)}`}>
                  {handoff.handoff_id}
                </a>
                <span>{handoff.status}</span>
                <span>{t('platform.run_detail.effect_key')}: {handoff.effect_key}</span>
                <span className="font-mono" id={`conversation-${handoff.conversation_id}`}>{t('platform.run_detail.conversation_id')}: {handoff.conversation_id}</span>
                <time>{formatTimestamp(handoff.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="platform-card space-y-2 p-4" id="run-audit">
        <h2 className="text-sm font-semibold text-ink">{t('platform.run_detail.audit_entries')}</h2>
        {(trace.data?.audit_entries ?? []).length === 0 ? <p className="text-xs text-muted">{t('platform.run_detail.no_audit_entries')}</p> : (
          <ul className="space-y-2 text-xs">
            {(trace.data?.audit_entries ?? []).map((entry) => (
              <li key={entry.audit_ref} id={`audit-${entry.audit_ref}`} className="flex flex-wrap gap-x-3">
                <span className="font-mono">{entry.audit_ref}</span>
                <span>{entry.agent} · {entry.skill}</span>
                <span>{entry.tool_binding} · {entry.authority}</span>
                <span>{entry.execution_status}</span>
                <time>{formatTimestamp(entry.created_at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      {retryOpen && run ? (
        <RetryRunModal
          run={{
            tenant_id: run.tenant_id, display_name: run.display_name, run_id: run.run_id, domain: run.domain,
            current_step: run.current_step, state: run.state, failure_class: run.failure_class,
            retry_eligible: run.retry_eligible, attempts: run.attempts, max_retries: run.max_retries,
            duration_ms: run.duration_ms, created_at: run.created_at, updated_at: run.updated_at,
            correlation_id: run.correlation_id,
          }}
          onClose={() => setRetryOpen(false)}
          onSuccess={(message) => { setNotice(message); detail.refresh(); }}
        />
      ) : null}
      {reconcile ? (
        <ReconcileModal
          item={reconcile}
          onClose={() => setReconcile(null)}
          onSuccess={(message) => { setNotice(message); detail.refresh(); }}
        />
      ) : null}
    </div>
  );
}

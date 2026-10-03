'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Field, Input, SectionHeader, Select, StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { auditActionLabel, auditActorKindLabel, auditReasonLabel } from '../../../lib/audit-format';
import {
  executeCompanyAutonomyAction,
  getCompanyAutonomy,
  getCompanyUsage,
  listCompanyAuditEvents,
  listCompanyRuns,
  type PlatformAutonomyAction,
  type PlatformCompanyAutonomy,
  type PlatformCompanyAuditEvent,
  type PlatformRunListItem,
  type PlatformUsage,
  type PlatformReadiness,
} from '../../../lib/platform-client';
import { ReasonActionDialog } from './ReasonActionDialog';

function StatusMap({ values }: { readonly values: Readonly<Record<string, string>> | null }) {
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

export function CompanyAiTeamTab({ readiness }: { readonly readiness: PlatformReadiness | null }) {
  return <StatusMap values={readiness?.capability_statuses ?? null} />;
}

export function CompanyUsageTab({ companyId }: { readonly companyId: string }) {
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<readonly PlatformUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fromDate = Date.parse(from);
    const toDate = Date.parse(to);
    if (!from || !to || !Number.isFinite(fromDate) || !Number.isFinite(toDate) || fromDate > toDate) {
      setRows([]);
      setLoading(false);
      setFailed(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setFailed(false);
    const fromAt = new Date(`${from}T00:00:00.000Z`).toISOString();
    const toAt = new Date(`${to}T23:59:59.999Z`).toISOString();
    void getCompanyUsage(companyId, fromAt, toAt)
      .then((items) => { if (!cancelled) setRows(items); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, from, generation, to]);

  return (
    <div className="space-y-4">
      <SectionHeader title={t('platform.tab_usage')} description={t('platform.company.usage_window')} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('platform.usage_date_range')}>
          <Input type="date" value={from} max={to} onChange={(event) => setFrom(event.currentTarget.value)} />
        </Field>
        <Field label={t('platform.company.usage_to')}>
          <Input type="date" value={to} min={from} onChange={(event) => setTo(event.currentTarget.value)} />
        </Field>
      </div>
      {failed ? <p role="alert" className="text-sm text-danger">{t('platform.company.data_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !failed && rows.length === 0 ? <EmptyState title={t('common.empty')} /> : null}
      {!loading && !failed && rows.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead><tr className="border-b border-default text-xs text-muted">
              <th className="px-3 py-2 font-medium">{t('platform.usage_day')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.usage_domain')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.usage_model')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.usage_tokens')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.usage_currency')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.cost')}</th>
            </tr></thead>
            <tbody className="divide-y divide-default">
              {rows.map((row) => (
                <tr key={`${row.usage_day}:${row.domain}:${row.model}:${row.currency}`}>
                  <td className="px-3 py-3">{row.usage_day}</td>
                  <td className="px-3 py-3">{row.domain ?? t('common.empty')}</td>
                  <td className="px-3 py-3">{row.model ?? t('common.empty')}</td>
                  <td className="px-3 py-3">{row.tokens_total.toLocaleString()}</td>
                  <td className="px-3 py-3">{row.currency ?? t('common.empty')}</td>
                  <td className="px-3 py-3">{row.cost_recorded ? row.cost_total ?? '0' : t('platform.cost_unrecorded')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => setGeneration((value) => value + 1)} disabled={loading}>
        {t('platform.refresh')}
      </Button>
    </div>
  );
}

export function CompanyRunsTab({ companyId }: { readonly companyId: string }) {
  const [runs, setRuns] = useState<readonly PlatformRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void listCompanyRuns(companyId)
      .then((items) => { if (!cancelled) setRuns(items); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, generation]);

  return (
    <div className="space-y-4">
      <SectionHeader title={t('platform.tab_runs')} description={t('platform.company.recent_runs')} />
      {failed ? <p role="alert" className="text-sm text-danger">{t('platform.company.data_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !failed && runs.length === 0 ? <EmptyState title={t('common.empty')} /> : null}
      {!loading && !failed && runs.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead><tr className="border-b border-default text-xs text-muted">
              <th className="px-3 py-2 font-medium">{t('platform.company.run')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.usage_domain')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.status')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.company.failure')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.last_activity')}</th>
            </tr></thead>
            <tbody className="divide-y divide-default">
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td className="px-3 py-3 font-mono text-xs">{run.run_id}</td>
                  <td className="px-3 py-3">{run.domain}</td>
                  <td className="px-3 py-3"><StatusBadge code={run.state} /></td>
                  <td className="px-3 py-3">{run.failure_class ?? t('common.empty')}</td>
                  <td className="px-3 py-3">{new Date(run.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => setGeneration((value) => value + 1)} disabled={loading}>
        {t('platform.refresh')}
      </Button>
    </div>
  );
}

export function CompanyAutonomyTab({ companyId }: { readonly companyId: string }) {
  const [inspection, setInspection] = useState<PlatformCompanyAutonomy | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<PlatformAutonomyAction | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const data = await getCompanyAutonomy(companyId);
      setInspection(data);
      setSelectedSkillId((current) => current || data.current[0]?.skill_id || '');
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [generation, load]);

  const currentAction = action;
  const confirmAction = async () => {
    if (currentAction === null || reason.trim().length === 0) return;
    setBusy(true);
    setActionFailed(false);
    setNotice('');
    try {
      await executeCompanyAutonomyAction(companyId, currentAction, {
        reason: reason.trim(),
        ...(currentAction === 'demote' ? { skill_id: selectedSkillId } : {}),
      });
      setAction(null);
      setReason('');
      setNotice(t('platform.autonomy.action_saved'));
      setGeneration((value) => value + 1);
    } catch {
      setActionFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const title = action === 'pause'
    ? t('platform.autonomy.pause_title')
    : action === 'resume'
      ? t('platform.autonomy.resume_title')
      : t('platform.autonomy.demote_title');
  const confirmLabel = action === 'pause'
    ? t('platform.autonomy.pause')
    : action === 'resume'
      ? t('platform.autonomy.resume')
      : t('platform.autonomy.demote');

  return (
    <div className="space-y-4">
      <SectionHeader title={t('platform.tab_autonomy')} description={t('platform.autonomy.evidence_description')} />
      {failed ? <p role="alert" className="text-sm text-danger">{t('platform.company.data_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !failed && inspection ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-default p-4">
            <span className="text-sm font-semibold">{t('platform.autonomy.company_state')}</span>
            <StatusBadge code={inspection.paused ? 'PAUSED' : 'ACTIVE'} />
            {!inspection.paused ? <Button size="sm" variant="danger" onClick={() => setAction('pause')}>{t('platform.autonomy.pause')}</Button> : null}
            {inspection.paused ? <Button size="sm" variant="secondary" onClick={() => setAction('resume')}>{t('platform.autonomy.resume')}</Button> : null}
            <Button size="sm" variant="secondary" disabled={inspection.current.length === 0} onClick={() => setAction('demote')}>
              {t('platform.autonomy.demote')}
            </Button>
          </div>
          <h3 className="text-sm font-semibold text-ink">{t('platform.autonomy.current_policies')}</h3>
          {inspection.current.length === 0 ? <EmptyState title={t('common.empty')} /> : (
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[38rem] text-left text-sm">
                <thead><tr className="border-b border-default text-xs text-muted">
                  <th className="px-3 py-2 font-medium">{t('platform.autonomy.skill')}</th>
                  <th className="px-3 py-2 font-medium">{t('platform.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('platform.autonomy.evidence_window')}</th>
                  <th className="px-3 py-2 font-medium">{t('platform.reason')}</th>
                </tr></thead>
                <tbody className="divide-y divide-default">
                  {inspection.current.map((record) => (
                    <tr key={`${record.skill_id}:${record.policy_version}`}>
                      <td className="px-3 py-3 font-mono text-xs">{record.skill_id}</td>
                      <td className="px-3 py-3"><StatusBadge code={record.state} /></td>
                      <td className="px-3 py-3 font-mono text-xs">{record.evidence_window_ref ?? t('common.empty')}</td>
                      <td className="px-3 py-3">{record.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="text-sm font-semibold text-ink">{t('platform.autonomy.history')}</h3>
          {inspection.history.length === 0 ? <EmptyState title={t('common.empty')} /> : (
            <ul className="space-y-2">
              {inspection.history.slice(0, 10).map((record) => (
                <li key={`${record.policy_id}:${record.effective_at}`} className="rounded-lg border border-default p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">{record.skill_id}</span>
                    <StatusBadge code={record.state} />
                  </div>
                  <p className="mt-2 text-xs text-muted">{record.evidence_window_ref ?? t('common.empty')} · {new Date(record.effective_at).toLocaleString()}</p>
                  <p className="mt-1">{record.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {actionFailed ? <p role="alert" className="text-sm text-danger">{t('platform.autonomy.action_error')}</p> : null}
      {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}
      {inspection ? (
        <ReasonActionDialog
          open={action !== null}
          title={title}
          description={t('platform.autonomy.action_description')}
          confirmLabel={confirmLabel}
          reason={reason}
          busy={busy}
          onReasonChange={setReason}
          onClose={() => { setAction(null); setReason(''); }}
          onConfirm={() => { void confirmAction(); }}
          additionalField={action === 'demote' ? (
            <Field label={t('platform.autonomy.skill')}>
              <Select value={selectedSkillId} onChange={(event) => setSelectedSkillId(event.currentTarget.value)}>
                {inspection.current.map((record) => <option key={record.skill_id} value={record.skill_id}>{record.skill_id}</option>)}
              </Select>
            </Field>
          ) : null}
        />
      ) : null}
    </div>
  );
}

export function CompanyAuditTab({ companyId }: { readonly companyId: string }) {
  const [events, setEvents] = useState<readonly PlatformCompanyAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void listCompanyAuditEvents(companyId)
      .then((items) => { if (!cancelled) setEvents(items); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId]);

  return (
    <div className="space-y-4">
      <SectionHeader title={t('platform.tab_audit')} description={t('platform.company.audit_recent')} />
      {failed ? <p role="alert" className="text-sm text-danger">{t('platform.company.data_error')}</p> : null}
      {loading ? <p className="text-sm text-muted" aria-busy="true">{t('common.loading')}</p> : null}
      {!loading && !failed && events.length === 0 ? <EmptyState title={t('common.empty')} /> : null}
      {!loading && !failed && events.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead><tr className="border-b border-default text-xs text-muted">
              <th className="px-3 py-2 font-medium">{t('platform.company.audit_time')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.company.audit_action')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.company.audit_actor')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.status')}</th>
              <th className="px-3 py-2 font-medium">{t('platform.reason')}</th>
            </tr></thead>
            <tbody className="divide-y divide-default">
              {events.map((event) => (
                <tr key={event.event_id}>
                  <td className="px-3 py-3">{new Date(event.created_at).toLocaleString('vi-VN')}</td>
                  <td className="px-3 py-3">
                    {auditActionLabel(event.action)}
                    <details className="mt-1 text-xs text-muted">
                      <summary>Chi tiết kỹ thuật</summary>
                      <code className="font-mono">{event.action}</code>
                    </details>
                  </td>
                  <td className="px-3 py-3">{auditActorKindLabel(event.actor_kind)} · <span className="font-mono text-xs">{event.actor_id}</span></td>
                  <td className="px-3 py-3"><StatusBadge code={event.outcome} /></td>
                  <td className="px-3 py-3">{auditReasonLabel(event.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

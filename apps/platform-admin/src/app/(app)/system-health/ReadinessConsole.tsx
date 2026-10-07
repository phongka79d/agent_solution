'use client';

import { can, type AuthSession } from '@agentos/ui-foundation/auth';
import { StatusBadge as FoundationStatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
type ProviderModel = {
  readonly model?: unknown;
  readonly configured?: unknown;
  readonly probe?: unknown;
};

type ReadinessSnapshot = {
  readonly demo_mode?: unknown;
  readonly observed_at?: unknown;
  readonly provider?: {
    readonly provider?: unknown;
    readonly configured?: unknown;
    readonly probe?: unknown;
    readonly models?: readonly ProviderModel[];
  };
  readonly connectors?: {
    readonly erp?: { readonly class?: unknown; readonly probe?: unknown };
    readonly events?: { readonly class?: unknown; readonly probe?: unknown };
  };
  readonly ledger?: {
    readonly status?: unknown;
    readonly stage_event_count?: unknown;
    readonly provider_call_count?: unknown;
  };
};

type TraceStage = {
  readonly attempt_ordinal?: unknown;
  readonly step_index?: unknown;
  readonly stage?: unknown;
  readonly entered_at?: unknown;
  readonly evidence_ref_count?: unknown;
};

type ProviderCall = {
  readonly step_index?: unknown;
  readonly stage?: unknown;
  readonly call_index?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly status?: unknown;
  readonly latency_ms?: unknown;
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly cached_tokens?: unknown;
  readonly recorded_at?: unknown;
};

type TraceResponse = {
  readonly run_id?: unknown;
  readonly lifecycle_state?: unknown;
  readonly stages?: readonly TraceStage[];
  readonly provider_calls?: readonly ProviderCall[];
  readonly observed_counts?: {
    readonly stage_events?: unknown;
    readonly provider_calls?: unknown;
  };
};

type SessionState = 'loading' | 'authenticated' | 'unauthenticated' | 'disabled' | 'permission' | 'error';

const SAFE_UNAVAILABLE = t('common.empty');

function stringValue(value: unknown, fallback = SAFE_UNAVAILABLE): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function countValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : SAFE_UNAVAILABLE;
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return SAFE_UNAVAILABLE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? SAFE_UNAVAILABLE : date.toLocaleString();
}

function errorMessage(status: number, payload: unknown): string {
  const code = typeof payload === 'object' && payload !== null && 'error' in payload
    ? stringValue(payload.error)
    : '';
  if (status === 404 && code === 'NOT_FOUND') return 'Demo mode is not available in this environment.';
  if (status === 401 || code === 'UNAUTHENTICATED') return 'Sign in as a platform administrator to view demo readiness.';
  if (status === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') return 'Your platform administrator session cannot view this readiness data.';
  if (status >= 500) return 'The demo readiness service is unavailable. Try again later.';
  return 'Readiness data could not be loaded.';
}

function isPlatformAuthSession(value: unknown): value is AuthSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('permissions' in value) || !Array.isArray(value.permissions)) return false;
  return can(value as AuthSession, 'platform:admin');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson(path: string): Promise<{ readonly response: Response; readonly payload: unknown }> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  return { response, payload: await readJson(response) };
}

function StatusBadge({ value, kind = 'status' }: { readonly value: unknown; readonly kind?: 'status' | 'probe' }) {
  const raw = stringValue(value);
  const normalized = raw.toUpperCase();
  const code = normalized === SAFE_UNAVAILABLE.toUpperCase()
    ? 'NO_DATA'
    : normalized === 'PASS' || normalized === 'OBSERVED' || normalized === 'LIVE' || normalized === 'CONFIGURED'
      ? 'ACTIVE'
      : kind === 'probe' && normalized === 'FAILED'
        ? 'FAILED'
        : raw;
  return <FoundationStatusBadge code={code} />;
}

function Panel({ title, children, description }: { readonly title: string; readonly children: ReactNode; readonly description?: string }) {
  const titleId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-title`;
  return (
    <section className="ui-section-card p-4 sm:p-5" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-sm font-semibold uppercase tracking-[0.16em] text-ink">{title}</h2>
      {description ? <p className="mt-2 text-xs leading-5 text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ReadinessConsole() {
  const [sessionState, setSessionState] = useState<SessionState>('loading');
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [runId, setRunId] = useState('');
  const [loading, setLoading] = useState(true);
  const [traceLoading, setTraceLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [traceMessage, setTraceMessage] = useState<string | null>(null);

  const loadReadiness = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const session = await getJson('/api/auth/session');
      if (!session.response.ok) {
        setSessionState(
          session.response.status === 404
            ? 'disabled'
            : session.response.status === 403
              ? 'permission'
              : session.response.status >= 500
                ? 'error'
                : 'unauthenticated',
        );
        setMessage(errorMessage(session.response.status, session.payload));
        return;
      }
      if (!isPlatformAuthSession(session.payload)) {
        setSessionState('permission');
        setMessage('Your session is not authorized for platform readiness.');
        return;
      }
      const readiness = await getJson('/api/v1/demo/readiness');
      if (!readiness.response.ok) {
        setSessionState(
          readiness.response.status === 404
            ? 'disabled'
            : readiness.response.status === 403
              ? 'permission'
              : readiness.response.status === 401
                ? 'unauthenticated'
                : 'authenticated',
        );
        setMessage(errorMessage(readiness.response.status, readiness.payload));
        return;
      }
      setSessionState('authenticated');
      setSnapshot(readiness.payload as ReadinessSnapshot);
    } catch {
      setSessionState('error');
      setMessage('The platform admin service is unavailable. Try again later.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

  const loadTrace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedRunId = runId.trim();
    if (normalizedRunId.length === 0 || normalizedRunId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalizedRunId)) {
      setTraceMessage('Enter a valid run id using letters, numbers, dots, underscores, colons, or hyphens.');
      setTrace(null);
      return;
    }
    setTraceLoading(true);
    setTraceMessage(null);
    setTrace(null);
    try {
      const result = await getJson(`/api/v1/runs/${encodeURIComponent(normalizedRunId)}/trace`);
      if (!result.response.ok) {
        setTraceMessage(errorMessage(result.response.status, result.payload));
        return;
      }
      setTrace(result.payload as TraceResponse);
    } catch {
      setTraceMessage('Run trace is unavailable. Try again later.');
    } finally {
      setTraceLoading(false);
    }
  };

  const logout = async () => {
    setMessage(null);
    const csrf = typeof document === 'undefined' ? '' : document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('agentos_platform_csrf='))?.slice('agentos_platform_csrf='.length) ?? '';
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': csrf ? decodeURIComponent(csrf) : '' },
      });
    } finally {
      window.location.assign('/sign-in');
    }
  };

  const provider = snapshot?.provider;
  const connectors = snapshot?.connectors;
  const ledger = snapshot?.ledger;
  const models = useMemo(() => Array.isArray(provider?.models) ? provider.models : [], [provider?.models]);

  if (sessionState !== 'authenticated' && !loading) {
    return (
      <div className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <section className="platform-card w-full p-6 sm:p-8" role="alert" aria-labelledby="readiness-access-title">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand">Platform Admin / Demo Readiness</p>
          <h1 id="readiness-access-title" className="mt-3 text-2xl font-semibold text-ink">Readiness access</h1>
          <p className="mt-3 text-sm leading-6 text-muted">{message ?? 'This readiness view is not available.'}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            {sessionState === 'unauthenticated' ? <a href="/sign-in" className="ui-button ui-button--primary">Sign in</a> : null}
            <button type="button" onClick={() => void loadReadiness()} className="ui-button ui-button--secondary">Try again</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand">Platform operations / Demo readiness</p>
          <div className="mt-2 flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Runtime readiness</h1><span className="ui-status ui-status--demo-only" role="status">Demo only</span></div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Observed capability state for the local demo. Provider content, prompts, credentials, and customer data are never shown here.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted">{formatDate(snapshot?.observed_at)}</span>
          <button type="button" onClick={() => void logout()} className="ui-button ui-button--ghost ui-button--sm">Sign out</button>
        </div>
      </header>

      {loading ? <p role="status" className="platform-card p-4 text-sm text-muted">Loading observed readiness…</p> : null}
      {message ? <div role="alert" className="platform-alert platform-alert--danger text-sm">{message}</div> : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Provider" description="Configured model probes are reported without provider payloads.">
          <dl className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3"><dt className="text-muted">Provider</dt><dd className="font-mono text-ink">{stringValue(provider?.provider)}</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted">Configured</dt><dd><StatusBadge value={provider?.configured === true ? 'CONFIGURED' : provider?.configured === false ? 'UNBOUND' : SAFE_UNAVAILABLE} /></dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-muted">Probe</dt><dd><StatusBadge value={provider?.probe} kind="probe" /></dd></div>
          </dl>
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            {models.length > 0 ? models.map((model, index) => <div key={`${stringValue(model.model)}-${index}`} className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-mono text-muted">{stringValue(model.model)}</span><StatusBadge value={model.probe} kind="probe" /></div>) : <p className="font-mono text-xs text-muted">{SAFE_UNAVAILABLE}</p>}
          </div>
        </Panel>

        <Panel title="Connectors" description="DEMO_MOCK is synthetic local data; LIVE is an observed external binding; UNBOUND is not configured.">
          <div className="space-y-3">
            {(['erp', 'events'] as const).map((name) => {
              const connector = connectors?.[name];
              return <div key={name} className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-low px-3 py-3"><div><p className="text-sm font-medium capitalize text-ink">{name}</p><p className="mt-1 text-xs text-muted">Connector class</p></div><div className="flex flex-wrap justify-end gap-2"><StatusBadge value={connector?.class} /><StatusBadge value={connector?.probe} kind="probe" /></div></div>;
            })}
          </div>
        </Panel>

        <Panel title="Observed ledger" description="Counts are read from the server ledger. Missing observations remain unavailable, not zero.">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-line bg-surface-low p-3"><dt className="text-xs text-muted">Stage events</dt><dd className="mt-1 font-mono text-xl text-ink">{countValue(ledger?.stage_event_count)}</dd></div>
            <div className="rounded-md border border-line bg-surface-low p-3"><dt className="text-xs text-muted">Provider calls</dt><dd className="mt-1 font-mono text-xl text-ink">{countValue(ledger?.provider_call_count)}</dd></div>
          </dl>
          <div className="mt-4 flex items-center justify-between text-xs"><span className="text-muted">Ledger status</span><StatusBadge value={ledger?.status} /></div>
        </Panel>
      </div>

      <Panel title="Run trace" description="Enter a server-issued run id to inspect redacted stages and provider timing/token observations.">
        <form onSubmit={loadTrace} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1"><label htmlFor="run-id" className="text-xs font-medium text-ink-body">Run id</label><input id="run-id" value={runId} onChange={(event) => setRunId(event.target.value)} maxLength={128} autoComplete="off" className="ui-input mt-1 w-full font-mono text-sm" placeholder="run_…" /></div>
          <button type="submit" disabled={traceLoading} className="ui-button ui-button--primary disabled:cursor-not-allowed">{traceLoading ? 'Loading…' : 'Inspect trace'}</button>
        </form>
        {traceMessage ? <p role="alert" className="platform-alert platform-alert--danger mt-4 text-sm">{traceMessage}</p> : null}
        {trace ? <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4"><div><p className="text-xs uppercase tracking-wider text-muted">Run</p><p className="mt-1 font-mono text-sm text-ink">{stringValue(trace.run_id)}</p></div><div className="flex items-center gap-2"><span className="text-xs text-muted">Lifecycle</span><StatusBadge value={trace.lifecycle_state} /></div></div>
          <div><h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Stages</h3><div className="mt-2 overflow-x-auto rounded-md border border-line"><table className="ui-table min-w-full text-left text-xs"><thead><tr><th scope="col">Stage</th><th scope="col">Step</th><th scope="col">Attempt</th><th scope="col">Entered</th><th scope="col">Evidence refs</th></tr></thead><tbody>{Array.isArray(trace.stages) && trace.stages.length > 0 ? trace.stages.map((stage, index) => <tr key={`${stringValue(stage.stage)}-${index}`}><td className="font-mono text-ink">{stringValue(stage.stage)}</td><td className="font-mono text-muted">{countValue(stage.step_index)}</td><td className="font-mono text-muted">{countValue(stage.attempt_ordinal)}</td><td className="whitespace-nowrap text-muted">{formatDate(stage.entered_at)}</td><td className="font-mono text-muted">{countValue(stage.evidence_ref_count)}</td></tr>) : <tr><td colSpan={5} className="font-mono text-muted">{SAFE_UNAVAILABLE}</td></tr>}</tbody></table></div></div>
          <div><h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Provider observations</h3><div className="mt-2 overflow-x-auto rounded-md border border-line"><table className="ui-table min-w-full text-left text-xs"><thead><tr><th scope="col">Stage</th><th scope="col">Provider / model</th><th scope="col">Status</th><th scope="col">Latency</th><th scope="col">Prompt tokens</th><th scope="col">Completion tokens</th></tr></thead><tbody>{Array.isArray(trace.provider_calls) && trace.provider_calls.length > 0 ? trace.provider_calls.map((call, index) => <tr key={`${stringValue(call.stage)}-${index}`}><td className="font-mono text-ink">{stringValue(call.stage)}</td><td className="text-muted"><span className="font-mono">{stringValue(call.provider)}</span><span className="mx-1 text-subtle">/</span><span className="font-mono">{stringValue(call.model)}</span></td><td><StatusBadge value={call.status} /></td><td className="font-mono text-muted">{typeof call.latency_ms === 'number' ? `${call.latency_ms} ms` : SAFE_UNAVAILABLE}</td><td className="font-mono text-muted">{countValue(call.prompt_tokens)}</td><td className="font-mono text-muted">{countValue(call.completion_tokens)}</td></tr>) : <tr><td colSpan={6} className="font-mono text-muted">{SAFE_UNAVAILABLE}</td></tr>}</tbody></table></div></div>
          <p className="text-xs text-muted">Observed totals: {countValue(trace.observed_counts?.stage_events)} stage events / {countValue(trace.observed_counts?.provider_calls)} provider calls. Cached tokens are intentionally omitted from the display.</p>
        </div> : null}
      </Panel>
    </div>
  );
}

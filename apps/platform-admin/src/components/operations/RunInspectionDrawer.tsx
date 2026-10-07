/**
 * Drawer panel providing deep inspection of R16 step authority verdicts, latencies, and evidence.
 */

import { AdvancedDetails, StatusBadge } from '@agentos/ui-foundation/react';
import { useEffect, useRef } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import type { AgentRunProjection } from './types';

import { getRetryEligibility } from './retry-helpers';
interface RunInspectionDrawerProps {
  readonly run: AgentRunProjection | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onRetry: (run: AgentRunProjection) => void;
}
function statusCode(value: string): string {
  if (value === 'failed') return 'FAILED';
  if (value === 'running' || value === 'executing') return 'ATTENTION';
  if (value === 'completed' || value === 'success') return 'ACTIVE';
  return 'UNKNOWN';
}

export function RunInspectionDrawer({
  run,
  isOpen,
  onClose,
  onRetry,
}: RunInspectionDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled])') ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen || !run) return null;

  const eligibility = getRetryEligibility(run);

  return (
    <div className="platform-drawer-shell">
      <div className="platform-scrim absolute inset-0" aria-hidden="true" />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Run inspection for ${run.run_id}`} className="platform-drawer relative flex w-full max-w-2xl flex-col overflow-y-auto border-l p-5 sm:p-6">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">Run inspection</span>
            <h2 className="break-all font-mono text-base font-bold text-brand">{run.run_id}</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close inspection panel" className="ui-focus-ring rounded-md p-1.5 text-muted hover:bg-surface-low hover:text-ink">&times;</button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 rounded-md border border-line bg-surface-low p-3 font-mono text-xs">
          <div><span className="text-muted">Agent:</span> <span className="text-ink">{run.agent_id ?? t('common.empty')}</span></div>
          <div><span className="text-muted">State:</span> <StatusBadge code={statusCode(run.state)} /> <AdvancedDetails value={run.state} /></div>
          <div><span className="text-muted">Latency:</span> <span className="text-ink">{run.latency_ms ?? t('common.empty')}{typeof run.latency_ms === 'number' ? 'ms' : ''}</span></div>
          <div><span className="text-muted">Cost:</span> <span className="text-ink">{run.cost !== undefined ? `$${run.cost.toFixed(4)}` : t('common.empty')}</span></div>
          <div><span className="text-muted">Retries:</span> <span className="text-ink">{run.retry_count}</span></div>
          <div><span className="text-muted">Error Class:</span> {run.last_error_class ? <AdvancedDetails value={run.last_error_class} /> : t('common.empty')}</div>
        </div>

        {run.error && <div className="platform-alert platform-alert--danger mt-3 font-mono text-xs"><span className="font-bold">Error:</span> {run.error}</div>}

        <div className="mt-4 rounded-md border border-line bg-surface-low p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs"><span className="font-semibold text-ink">Retry availability: </span><span className={eligibility.retryable ? 'font-semibold text-success' : 'text-muted'}>{eligibility.retryable ? 'Eligible' : 'Unavailable'}</span><p className="mt-0.5 text-[11px] text-muted">{eligibility.explanation}</p></div>
            {eligibility.retryable && <button type="button" onClick={() => onRetry(run)} className="ui-button ui-button--danger ui-button--sm">Retry Run</button>}
          </div>
        </div>

        <div className="mt-6 flex-1">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Step execution telemetry ({run.steps?.length ?? 0} steps)</h3>
          {(!run.steps || run.steps.length === 0) ? <div className="rounded-md border border-dashed border-line p-6 text-center text-xs text-muted">No discrete step telemetry recorded for this run.</div> : <div className="space-y-3">{run.steps.map((step, idx) => <div key={idx} className="rounded-md border border-line bg-surface-low p-3 font-mono text-xs"><div className="mb-2 flex items-center justify-between gap-2 border-b border-line pb-2"><span className="font-bold text-brand">Step {step.step_number ?? idx + 1}: {step.skill}</span><div className="flex items-center gap-2"><AdvancedDetails value={step.authority} /><StatusBadge code={statusCode(step.execution_status)} /><AdvancedDetails value={step.execution_status} /></div></div><div className="grid grid-cols-2 gap-1 text-[11px] text-muted"><div>Tool: <span className="text-ink">{step.tool}</span></div><div>Latency: <span className="text-ink">{step.latency_ms}ms</span></div>{step.cost !== undefined && <div>Cost: <span className="text-ink">${step.cost.toFixed(4)}</span></div>}{step.approval && <div>Approval: <span className="text-ink">{step.approval}</span></div>}</div>{step.error && <div className="platform-alert platform-alert--danger mt-2 text-[11px]">{step.error}</div>}{step.evidence && <div className="mt-2"><span className="text-[10px] uppercase text-muted">Evidence record:</span><pre className="mt-0.5 max-h-24 overflow-auto rounded-md border border-line bg-surface p-2 text-[10px] text-ink-body">{step.evidence}</pre></div>}</div>)}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * @file apps/command-center/src/components/operations/RunInspectionDrawer.tsx
 * Drawer panel providing deep inspection of R16 step authority verdicts, latencies, and evidence.
 */

import React, { useEffect } from 'react';
import type { AgentRunProjection } from './types';
import { getRetryEligibility } from './retry-helpers';

interface RunInspectionDrawerProps {
  readonly run: AgentRunProjection | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onRetry: (run: AgentRunProjection) => void;
}

export function RunInspectionDrawer({
  run,
  isOpen,
  onClose,
  onRetry,
}: RunInspectionDrawerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !run) return null;

  const eligibility = getRetryEligibility(run);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Run inspection for ${run.run_id}`}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-slate-800 bg-slate-950 p-6 shadow-2xl overflow-y-auto"
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Run Inspection</span>
          <h2 className="text-base font-mono font-bold text-sky-400 break-all">{run.run_id}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspection panel"
          className="rounded p-1.5 text-slate-400 hover:bg-slate-900 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
        >
          &times;
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-slate-800 bg-slate-900/60 p-3 text-xs font-mono">
        <div><span className="text-slate-500">Agent:</span> <span className="text-slate-200">{run.agent_id}</span></div>
        <div><span className="text-slate-500">State:</span> <span className="text-slate-200">{run.state}</span></div>
        <div><span className="text-slate-500">Latency:</span> <span className="text-slate-200">{run.latency_ms ?? '-'}ms</span></div>
        <div><span className="text-slate-500">Cost:</span> <span className="text-slate-200">{run.cost !== undefined ? `$${run.cost.toFixed(4)}` : '-'}</span></div>
        <div><span className="text-slate-500">Retries:</span> <span className="text-slate-200">{run.retry_count}</span></div>
        <div><span className="text-slate-500">Error Class:</span> <span className="text-rose-400">{run.last_error_class ?? 'None'}</span></div>
      </div>

      {run.error && (
        <div className="mt-3 rounded border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-300 font-mono">
          <span className="font-bold">Error:</span> {run.error}
        </div>
      )}

      <div className="mt-4 rounded border border-slate-800 bg-slate-900/40 p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs">
            <span className="font-semibold text-slate-200">Retry Availability: </span>
            <span className={eligibility.retryable ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>
              {eligibility.retryable ? 'Eligible' : 'Unavailable'}
            </span>
            <p className="mt-0.5 text-[11px] text-slate-400">{eligibility.explanation}</p>
          </div>
          {eligibility.retryable && (
            <button
              type="button"
              onClick={() => onRetry(run)}
              className="ml-3 rounded bg-rose-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              Retry Run
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 flex-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
          Step Execution Telemetry ({run.steps?.length ?? 0} Steps)
        </h3>
        {(!run.steps || run.steps.length === 0) ? (
          <div className="rounded border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
            No discrete step telemetry recorded for this run.
          </div>
        ) : (
          <div className="space-y-3">
            {run.steps.map((step, idx) => (
              <div key={idx} className="rounded border border-slate-800 bg-slate-900/70 p-3 text-xs font-mono">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-2">
                  <span className="font-bold text-sky-300">Step {step.step_number ?? idx + 1}: {step.skill}</span>
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] border ${
                      step.authority === 'AUTH-4' ? 'bg-amber-950 text-amber-300 border-amber-700' :
                      step.authority === 'AUTH-5' ? 'bg-rose-950 text-rose-300 border-rose-700' :
                      'bg-slate-800 text-slate-300 border-slate-700'
                    }`}>
                      {step.authority}
                    </span>
                    <span className="text-[10px] text-slate-400">{step.execution_status}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                  <div>Tool: <span className="text-slate-200">{step.tool}</span></div>
                  <div>Latency: <span className="text-slate-200">{step.latency_ms}ms</span></div>
                  {step.cost !== undefined && <div>Cost: <span className="text-slate-200">${step.cost.toFixed(4)}</span></div>}
                  {step.approval && <div>Approval: <span className="text-slate-200">{step.approval}</span></div>}
                </div>
                {step.error && (
                  <div className="mt-2 text-rose-400 text-[11px] bg-rose-950/30 p-1.5 rounded border border-rose-900/50">
                    {step.error}
                  </div>
                )}
                {step.evidence && (
                  <div className="mt-2">
                    <span className="text-[10px] uppercase text-slate-500">Evidence Record:</span>
                    <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-slate-950 p-2 text-[10px] text-slate-300 border border-slate-800">
                      {step.evidence}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

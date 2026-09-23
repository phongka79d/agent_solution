/**
 * @file apps/command-center/src/components/operations/RetryRunModal.tsx
 * Operator modal for confirming R13 side-effect-free run retry execution.
 */

import React, { useState } from 'react';
import { apiClient, ApiError } from '../../lib/api-client';
import type { AgentRunProjection, RunRetryRequest, TaskAcceptedResponse } from './types';

interface RetryRunModalProps {
  readonly run: AgentRunProjection | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (receipt: TaskAcceptedResponse) => void;
  readonly defaultOperatorId?: string;
}

export function RetryRunModal({
  run,
  isOpen,
  onClose,
  onSuccess,
  defaultOperatorId = 'OP-CONSOLE',
}: RetryRunModalProps) {
  const [operatorId, setOperatorId] = useState(defaultOperatorId);
  const [reason, setReason] = useState('Operator-authorized retry of verified side-effect-free failure');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !run) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const trimmedOperatorId = operatorId.trim();
      const trimmedReason = reason.trim();
      const requestPayload: RunRetryRequest = {
        ...(trimmedOperatorId ? { operator_id: trimmedOperatorId } : {}),
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      };
      const receipt = await apiClient.retryRun(run.run_id, requestPayload);

      // Claim success ONLY after authoritative wire response received
      onSuccess(receipt);
      onClose();
    } catch (err: unknown) {
      let msg = 'Failed to execute run retry';
      if (err instanceof ApiError) {
        msg = `[${err.errorCode}] ${err.message}`;
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="retry-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-xl">
        <h2 id="retry-modal-title" className="text-sm font-semibold text-slate-100 font-mono">
          Confirm Safe Run Retry
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Target run: <span className="font-mono text-sky-400">{run.run_id}</span>
        </p>

        <div className="mt-3 rounded border border-amber-900/60 bg-amber-950/40 p-2.5 text-[11px] text-amber-300">
          Verified side-effect-free class: <span className="font-mono font-bold">{run.last_error_class}</span>.
          Re-queuing will re-dispatch execution with an incremented task version.
        </div>

        {errorMessage && (
          <div className="mt-3 rounded border border-rose-900/60 bg-rose-950/40 p-2.5 text-[11px] text-rose-300">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div>
            <label htmlFor="retry-operator-id" className="block text-xs font-medium text-slate-300 mb-1">
              Operator Identifier
            </label>
            <input
              id="retry-operator-id"
              type="text"
              required
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
            />
          </div>

          <div>
            <label htmlFor="retry-reason" className="block text-xs font-medium text-slate-300 mb-1">
              Reason / Justification
            </label>
            <textarea
              id="retry-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>

          <div className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !operatorId.trim()}
              className="rounded bg-rose-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              {isSubmitting ? 'Submitting R13...' : 'Execute Retry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

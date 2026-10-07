/**
 * Operator modal for confirming R13 side-effect-free run retry execution.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import { adminOperationsClient } from '../../lib/admin-operations-client';
import type { AgentRunProjection, RunRetryRequest, TaskAcceptedResponse } from './types';

interface RetryRunModalProps {
  readonly run: AgentRunProjection | null;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (receipt: TaskAcceptedResponse) => void;
}

export function RetryRunModal({
  run,
  isOpen,
  onClose,
  onSuccess,
}: RetryRunModalProps) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isSubmittingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [reason, setReason] = useState('Operator-authorized retry of verified side-effect-free failure');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  isSubmittingRef.current = isSubmitting;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reasonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmittingRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen || !run) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const trimmedReason = reason.trim();
      const requestPayload: RunRetryRequest = trimmedReason ? { reason: trimmedReason } : {};
      const receipt = await adminOperationsClient.retryRun(run.run_id, requestPayload);
      if (
        typeof receipt?.task_id !== 'string'
        || typeof receipt?.task_version !== 'number'
        || typeof receipt?.status !== 'string'
        || typeof receipt?.correlation_id !== 'string'
      ) {
        throw new Error('Retry response was not an accepted task receipt.');
      }
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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="retry-modal-title"
      aria-describedby="retry-modal-description"
      className="platform-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={(event) => {
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
      }}
    >
      <div className="platform-card platform-card--raised w-full max-w-md p-6">
        <h2 id="retry-modal-title" className="font-mono text-sm font-semibold text-ink">
          Confirm Safe Run Retry
        </h2>
        <p id="retry-modal-description" className="mt-1 text-xs text-muted">
          Target run: <span className="font-mono text-brand">{run.run_id}</span>
        </p>

        <div className="platform-alert platform-alert--warning mt-3 text-[11px]">
          Verified side-effect-free class: <span className="font-mono font-bold">{run.last_error_class}</span>.
          Re-queuing will re-dispatch execution with an incremented task version.
        </div>

        {errorMessage && (
          <div className="platform-alert platform-alert--danger mt-3 text-[11px]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">

          <div>
            <label htmlFor="retry-reason" className="block text-xs font-medium text-ink mb-1">
              Reason / Justification
            </label>
            <textarea
              id="retry-reason"
              ref={reasonRef}
              rows={3}
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="ui-input min-h-24 resize-y text-xs"
            />
          </div>

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="ui-button ui-button--ghost ui-button--sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !reason.trim()}
              className="ui-button ui-button--danger"
            >
              {isSubmitting ? 'Submitting R13...' : 'Execute Retry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

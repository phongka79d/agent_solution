/**
 * Operator retry confirmation (T8.3).
 *
 * Retry is offered only when the server marks the run `retry_eligible`; indeterminate failures are
 * routed to the reconciliation modal instead. The reason is optional for a retry but recorded.
 */

'use client';

import { useState } from 'react';
import { Modal } from '@agentos/ui-foundation/react';
import { ErrorBanner } from '@agentos/ui-foundation/react';
import { retryRun } from './api';
import { failureLabel } from './format';
import type { PlatformRunListItem } from './types';

interface RetryRunModalProps {
  readonly run: PlatformRunListItem | null;
  readonly onClose: () => void;
  readonly onSuccess: (message: string) => void;
}

export function RetryRunModal({ run, onClose, onSuccess }: RetryRunModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (run === null) return null;

  async function submit(): Promise<void> {
    if (run === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await retryRun(run.tenant_id, run.run_id, reason.trim());
      onSuccess(`Đã gửi yêu cầu thử lại cho lượt chạy ${accepted.run_id}.`);
      setReason('');
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Thử lại lượt chạy"
      description={`${run.display_name} · ${run.run_id}`}
      actions={
        <>
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose} disabled={submitting}>Hủy</button>
          <button type="button" className="ui-button ui-button--danger" onClick={() => { void submit(); }} disabled={submitting}>
            {submitting ? 'Đang gửi…' : 'Xác nhận thử lại'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-body">
        <p>
          Lượt chạy sẽ được đưa lại vào hàng đợi. Máy chủ đã xác nhận lỗi này an toàn để chạy lại
          ({failureLabel(run.failure_class)}); số lần thử {run.attempts}/{run.max_retries}.
        </p>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink">
          Lý do (không bắt buộc)
          <textarea className="ui-input ui-focus-ring" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {error !== null ? <ErrorBanner error={error} /> : null}
      </div>
    </Modal>
  );
}

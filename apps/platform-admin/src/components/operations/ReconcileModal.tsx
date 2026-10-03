/**
 * Reconciliation modal for indeterminate failures (T8.3).
 *
 * A failed run whose outcome is unknown is never blindly retried: the operator records what the
 * provider actually did. A reason is mandatory; a receipt is optional and must be valid JSON.
 * Resolution names are shared verbatim with the server contract.
 */

'use client';

import { useState } from 'react';
import { ErrorBanner, Modal } from '@agentos/ui-foundation/react';
import { reconcileRun } from './api';
import { failureLabel, reconciliationReasonLabel, RESOLUTION_LABELS } from './format';
import type { PlatformReconciliationItem, ReconciliationResolution } from './types';

interface ReconcileModalProps {
  readonly item: Pick<PlatformReconciliationItem, 'tenant_id' | 'display_name' | 'run_id' | 'failure_class' | 'reason'> | null;
  readonly onClose: () => void;
  readonly onSuccess: (message: string) => void;
}

const RESOLUTIONS: readonly ReconciliationResolution[] = [
  'PROVIDER_CONFIRMED_SUCCEEDED',
  'PROVIDER_CONFIRMED_ABSENT',
  'ESCALATE_MANUALLY',
];

export function ReconcileModal({ item, onClose, onSuccess }: ReconcileModalProps) {
  const [resolution, setResolution] = useState<ReconciliationResolution>('PROVIDER_CONFIRMED_SUCCEEDED');
  const [reason, setReason] = useState('');
  const [receiptText, setReceiptText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  if (item === null) return null;
  const target = item;

  async function submit(): Promise<void> {
    setValidationError(null);
    if (reason.trim().length === 0) {
      setValidationError('Vui lòng nhập lý do đối soát.');
      return;
    }
    let receipt: Record<string, unknown> | undefined;
    if (receiptText.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(receiptText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setValidationError('Biên nhận phải là một đối tượng JSON.');
          return;
        }
        receipt = parsed as Record<string, unknown>;
      } catch {
        setValidationError('Biên nhận không phải JSON hợp lệ.');
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await reconcileRun(target.tenant_id, target.run_id, {
        resolution,
        reason: reason.trim(),
        ...(receipt === undefined ? {} : { receipt }),
      });
      onSuccess(`Đã ghi nhận đối soát cho lượt chạy ${accepted.run_id}.`);
      setReason('');
      setReceiptText('');
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
      title="Đối soát lượt chạy"
      description={`${target.display_name} · ${target.run_id}`}
      actions={
        <>
          <button type="button" className="ui-button ui-button--secondary" onClick={onClose} disabled={submitting}>Hủy</button>
          <button type="button" className="ui-button ui-button--primary" onClick={() => { void submit(); }} disabled={submitting}>
            {submitting ? 'Đang gửi…' : 'Xác nhận đối soát'}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-ink-body">
        <p>
          Lỗi này có kết quả chưa xác định ({failureLabel(target.failure_class)} · {reconciliationReasonLabel(target.reason)}).
          Không thử lại trực tiếp; hãy ghi lại điều nhà cung cấp đã xác nhận.
        </p>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-ink">Kết quả đối soát</legend>
          {RESOLUTIONS.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="reconcile-resolution" value={value} checked={resolution === value} onChange={() => setResolution(value)} />
              {RESOLUTION_LABELS[value]}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
          Lý do (bắt buộc)
          <textarea
            className="ui-input ui-focus-ring"
            rows={3}
            required
            aria-required="true"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ví dụ: đã đối chiếu mã đơn trên cổng nhà cung cấp."
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
          Biên nhận nhà cung cấp (không bắt buộc, JSON)
          <textarea
            className="ui-input ui-focus-ring font-mono"
            rows={3}
            value={receiptText}
            onChange={(event) => setReceiptText(event.target.value)}
            placeholder='{"reference":"..."}'
          />
        </label>
        {validationError !== null ? <p role="alert" className="text-sm text-danger">{validationError}</p> : null}
        {error !== null ? <ErrorBanner error={error} /> : null}
      </div>
    </Modal>
  );
}

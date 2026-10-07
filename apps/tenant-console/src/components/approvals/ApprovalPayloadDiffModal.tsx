/**
 * Modal displaying action payload, reviewed payload SHA-256 digest, editable parameters for MODIFY,
 * and the 5 standardized governance decision buttons with in-flight duplicate prevention and 409 detection.
 */
'use client';

import { useState, useEffect, useRef } from 'react';
import { AdvancedDetails } from '@agentos/ui-foundation/react';
import type {
  ApprovalItem,
  ApprovalDecision,
  ApprovalDecisionResponse,
  ApiErrorResponse,
} from './types';
import { STANDARD_REJECTION_CODES } from './types';
interface ApprovalPayloadDiffModalProps {
  readonly item: ApprovalItem | null;
  readonly requireDistinctApprover?: boolean | undefined;
  readonly onClose: () => void;
  readonly onSubmitDecision: (
    id: string,
    decision: ApprovalDecision,
    reason: string,
    expectedPayloadSha256: string,
    modifiedPayload?: Record<string, unknown> | undefined
  ) => Promise<ApprovalDecisionResponse>;
  readonly onViewCustomer?: ((customerId: string) => void) | undefined;
}

export function ApprovalPayloadDiffModal({
  item,
  requireDistinctApprover = false,
  onClose,
  onSubmitDecision,
  onViewCustomer,
}: ApprovalPayloadDiffModalProps) {
  const [isModifying, setIsModifying] = useState(false);
  const [modifiedJsonText, setModifiedJsonText] = useState('');
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);

  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectCode, setRejectCode] = useState<string>(STANDARD_REJECTION_CODES[0]);
  const [customRejectReason, setCustomRejectReason] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<{
    readonly message: string;
    readonly isConflict?: boolean | undefined;
    readonly correlationId?: string | undefined;
    readonly errorCode?: string | undefined;
  } | null>(null);
  const [lastAttempt, setLastAttempt] = useState<{
    readonly decision: ApprovalDecision;
    readonly reason: string;
    readonly modifiedPayload?: Record<string, unknown> | undefined;
  } | null>(null);

  const [decisionReceipt, setDecisionReceipt] = useState<ApprovalDecisionResponse | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isSubmittingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  isSubmittingRef.current = isSubmitting;
  onCloseRef.current = onClose;

  const currentItemId = item?.id;
  useEffect(() => {
    if (item) {
      setIsModifying(false);
      setModifiedJsonText(JSON.stringify(item.payload, null, 2));
      setJsonParseError(null);
      setShowRejectForm(false);
      setCustomRejectReason('');
      setSubmissionError(null);
      setDecisionReceipt(null);
      setLastAttempt(null);
    }
  }, [currentItemId]);

  useEffect(() => {
    if (!item) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmittingRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? []);
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
  }, [currentItemId]);

  if (!item) return null;
  const digestMissing = item.payloadSha256.trim().length === 0;

  const handleStartModify = () => {
    setModifiedJsonText(JSON.stringify(item.payload, null, 2));
    setJsonParseError(null);
    setIsModifying(true);
    setShowRejectForm(false);
  };

  const handleCancelModify = () => {
    setIsModifying(false);
    setJsonParseError(null);
  };

  const handleExecute = async (
    decision: ApprovalDecision,
    reason: string,
    modifiedPayload?: Record<string, unknown>
  ) => {
    if (isSubmitting || !item.payloadSha256.trim()) return;

    setLastAttempt({
      decision,
      reason,
      ...(modifiedPayload === undefined ? {} : { modifiedPayload }),
    });
    setIsSubmitting(true);
    setSubmissionError(null);

    try {
      const receipt = await onSubmitDecision(
        item.id,
        decision,
        reason,
        item.payloadSha256,
        modifiedPayload
      );
      setDecisionReceipt(receipt);
      setLastAttempt(null);
    } catch (err: unknown) {
      const apiErr = err as ApiErrorResponse & {
        status?: number;
        isConflict?: boolean;
        errorCode?: string;
        correlationId?: string;
      };
      const errorCode = apiErr.error_code ?? apiErr.errorCode;
      const is409 =
        apiErr.status === 409 ||
        apiErr.isConflict === true ||
        (typeof errorCode === 'string' &&
          (errorCode.includes('CONFLICT') ||
            errorCode.includes('STALE') ||
            errorCode.includes('ALREADY') ||
            errorCode.includes('NOT_CLAIMABLE')));
      setSubmissionError({
        message: apiErr.message || 'Decision submission failed.',
        isConflict: is409,
        ...(apiErr.correlation_id || apiErr.correlationId
          ? { correlationId: apiErr.correlation_id ?? apiErr.correlationId }
          : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSaveModify = () => {
    try {
      const parsed = JSON.parse(modifiedJsonText) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonParseError('Modified payload must be a JSON object.');
        return;
      }
      setJsonParseError(null);
      handleExecute('MODIFY', 'OPERATOR_MODIFIED_PAYLOAD', parsed);
    } catch (err) {
      setJsonParseError(`Invalid JSON syntax: ${(err as Error).message}`);
    }
  };

  const handleConfirmReject = () => {
    const finalReason = customRejectReason.trim()
      ? `${rejectCode}: ${customRejectReason.trim()}`
      : rejectCode;
    handleExecute('REJECT', finalReason);
  };

  const extractedCustomerId =
    item.customerId ||
    (typeof item.payload?.customer_id === 'string'
      ? item.payload.customer_id
      : typeof item.payload?.customerId === 'string'
      ? item.payload.customerId
      : undefined);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--elevation-scrim)] p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      aria-describedby="approval-modal-description"
    >
      <div className="tenant-approval-modal">
        {/* Header */}
        <div className="tenant-approval-modal__header">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="tenant-approval-row__id">#{item.id}</span>
              <h2 id="approval-modal-title" className="text-headline-md font-semibold text-ink">
                {item.title || 'AUTH-4 Governance Checkpoint'}
              </h2>
              <span className={`tenant-approval-status ${
                item.status === 'QUEUED'
                  ? 'tenant-approval-status--ai'
                  : item.isPaused || item.status === 'PAUSED'
                  ? 'tenant-approval-status--info'
                  : 'tenant-approval-status--warning'
              }`}>
                {item.status === 'QUEUED'
                  ? 'QUEUED'
                  : item.isPaused || item.status === 'PAUSED'
                  ? 'PAUSED'
                  : 'AWAITING_HUMAN'}
              </span>
            </div>
            <p id="approval-modal-description" className="text-sm text-muted">
              Đề xuất bởi <strong className="text-ink">{item.requestingAgentName ?? item.agentId}</strong>
              {item.domain ? <> · {item.domain}</> : null}
            </p>
            {requireDistinctApprover ? (
              <p role="note" className="mt-2 text-sm font-medium text-warning">
                Người phê duyệt phải khác người soạn
              </p>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="ui-button ui-button--ghost ui-button--sm"
          >
            Đóng
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="tenant-approval-detail-card">
              <span className="tenant-approval-detail-card__label">Risk Governance Reason</span>
              <p className="tenant-approval-detail-card__value">{item.reason}</p>
            </div>
            <div className="tenant-approval-detail-card">
              <span className="tenant-approval-detail-card__label">Reviewed Payload SHA-256 Digest</span>
              <p className="tenant-approval-detail-card__value tenant-approval-detail-card__value--success break-all">{item.payloadSha256 || 'Digest unavailable'}</p>
              <span className="mt-1 block text-xs text-muted">Enforced server-side precondition (R05 / 409 conflict guard)</span>
            </div>
          </div>
          {digestMissing ? (
            <p role="alert" className="tenant-notice tenant-notice--warning">
              Chưa thể quyết định: cần tải bản chi tiết để biết digest payload đã được xem xét.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="tenant-approval-detail-card">
              <h3 className="tenant-approval-detail-card__label">Vì sao</h3>
              <p className="mt-1 text-sm text-ink">{item.reason}</p>
            </div>
            <div className="tenant-approval-detail-card">
              <h3 className="tenant-approval-detail-card__label">Bối cảnh</h3>
              <pre className="tenant-approval-detail-card__technical">
                {item.context === undefined ? 'Chưa có dữ liệu' : JSON.stringify(item.context, null, 2)}
              </pre>
            </div>
          </div>

          <div className="tenant-approval-detail-card">
            <h3 className="tenant-approval-detail-card__label">Bằng chứng</h3>
            {item.evidence && item.evidence.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-ink">
                {item.evidence.map((evidence, index) => <li key={`${item.id}-evidence-${index}`} className="break-words">{typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}</li>)}
              </ul>
            ) : <p className="mt-1 text-sm text-muted">Chưa có dữ liệu</p>}
          </div>

          <AdvancedDetails summary="Chi tiết nâng cao">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted">Authority</dt><dd className="break-all font-mono text-ink">{item.authority ?? '—'}</dd></div>
              <div><dt className="text-muted">run_id</dt><dd className="break-all font-mono text-ink">{item.runId || '—'}</dd></div>
              <div><dt className="text-muted">effect_key</dt><dd className="break-all font-mono text-ink">{item.effectKey ?? '—'}</dd></div>
              <div><dt className="text-muted">digest</dt><dd className="break-all font-mono text-ink">{item.payloadSha256 || '—'}</dd></div>
            </dl>
          </AdvancedDetails>

          {/* Cross navigation to Customer 360 if customerId exists */}
          {extractedCustomerId && onViewCustomer && (
            <div className="tenant-approval-detail-card flex items-center justify-between gap-3">
              <div>
                <span className="text-muted">Associated Customer:</span>{' '}
                <strong className="font-mono text-ink">{extractedCustomerId}</strong>
              </div>
              <button type="button" onClick={() => onViewCustomer(extractedCustomerId)} className="ui-button ui-button--secondary ui-button--sm">
                Inspect Customer 360 (SCR-004) →
              </button>
            </div>
          )}

          <div className="tenant-approval-detail-card">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="tenant-approval-detail-card__label">Action Payload:</span>
              {isModifying ? <span className="font-mono text-xs text-warning">Editing payload for MODIFY revision</span> : null}
            </div>

            {isModifying ? (
              <div className="space-y-2">
                <textarea
                  value={modifiedJsonText}
                  onChange={(e) => setModifiedJsonText(e.target.value)}
                  disabled={isSubmitting}
                  className="ui-input h-56 w-full resize-none font-mono text-xs"
                  placeholder="Enter modified JSON payload..."
                />
                {jsonParseError ? <p className="font-mono text-xs text-danger">{jsonParseError}</p> : null}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={handleCancelModify} disabled={isSubmitting} className="ui-button ui-button--secondary ui-button--sm">
                    Hủy sửa
                  </button>
                  <button type="button" onClick={handleSaveModify} disabled={isSubmitting} className="ui-button ui-button--primary ui-button--sm">
                    {isSubmitting ? 'Đang gửi bản sửa đổi…' : 'Gửi bản sửa đổi'}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="tenant-approval-detail-card__technical max-h-56 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(item.payload, null, 2)}</pre>
            )}
          </div>

          {/* Rejection Form Drawer */}
          {showRejectForm && (
            <div className="tenant-notice tenant-notice--danger space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-danger">
                  Submit REJECT Decision (AUTH-4 Terminal Stop)
                </span>
                <button type="button" onClick={() => setShowRejectForm(false)} className="ui-button ui-button--ghost ui-button--sm">
                  Hủy
                </button>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-ink">
                  Standardized Rejection Code (Mandatory):
                </label>
                <select
                  value={rejectCode}
                  onChange={(e) => setRejectCode(e.target.value)}
                  disabled={isSubmitting}
                  className="ui-select w-full"
                >
                  {STANDARD_REJECTION_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-ink">
                  Detailed Rationale / Notes (Optional context):
                </label>
                <input
                  type="text"
                  value={customRejectReason}
                  onChange={(e) => setCustomRejectReason(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="e.g. Budget ceiling 100k TWD exceeded by 86k TWD"
                  className="ui-input w-full"
                />
              </div>

              <div className="flex justify-end pt-1">
                <button type="button" onClick={handleConfirmReject} disabled={isSubmitting || digestMissing} className="ui-button ui-button--danger ui-button--sm">
                  {isSubmitting ? 'Đang gửi từ chối…' : 'Xác nhận từ chối'}
                </button>
              </div>
            </div>
          )}

          {/* Conflict or Error Notification */}
          {submissionError ? (
            <div className={`tenant-notice ${submissionError.isConflict ? 'tenant-notice--warning' : 'tenant-notice--danger'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-sm">
                  {submissionError.isConflict ? 'version_conflict: 409 Conflict Detected' : 'Decision Submission Failed'}
                </span>
                {submissionError.errorCode ? <span className="tenant-approval-row__id">{submissionError.errorCode}</span> : null}
              </div>
              <p className="mt-2 break-words font-mono text-sm">{submissionError.message}</p>
              {submissionError.correlationId ? <p className="mt-1 font-mono text-xs text-muted">Correlation ID: {submissionError.correlationId}</p> : null}
              {submissionError.errorCode === 'APPROVER_MUST_DIFFER' ? (
                <p role="alert" className="mt-2 font-semibold">APPROVER_MUST_DIFFER: Người phê duyệt phải khác người soạn.</p>
              ) : null}
              {lastAttempt ? (
                <button
                  type="button"
                  onClick={() => void handleExecute(lastAttempt.decision, lastAttempt.reason, lastAttempt.modifiedPayload)}
                  disabled={isSubmitting || digestMissing}
                  className="ui-button ui-button--secondary ui-button--sm mt-3"
                >
                  Thử lại
                </button>
              ) : null}
            </div>
          ) : null}

          {decisionReceipt ? (
            <div data-testid="approval-decision-receipt" className="tenant-notice tenant-notice--info space-y-1">
              <div className="flex flex-wrap items-center gap-2 font-semibold text-sm">
                <span>Decision Queued: Status {decisionReceipt.status}</span>
                <span className="tenant-summary-badge tenant-summary-badge--info">HTTP 202 Accepted</span>
              </div>
              <p className="font-mono text-sm">Approval ID: {decisionReceipt.approval_id} | Task ID: {decisionReceipt.task_id}</p>
              <p className="font-mono text-xs">Queued At: {decisionReceipt.queued_at} | Correlation ID: {decisionReceipt.correlation_id}</p>
              <p className="mt-1 text-xs text-muted">Durable worker handoff queued. The approval remains pending until claimed and executed by the worker.</p>
            </div>
          ) : null}
        </div>

        {/* 5 Standardized Governance Decisions Bar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleExecute('PAUSE', 'OPERATOR_PAUSED_FOR_INVESTIGATION')}
              disabled={isSubmitting || digestMissing || !!decisionReceipt || item.status === 'QUEUED'}
              className="ui-button ui-button--secondary ui-button--sm"
            >
              Tạm dừng
            </button>
            <button
              type="button"
              onClick={() => handleExecute('CANCEL', 'OPERATOR_CANCELLED_RUN')}
              disabled={isSubmitting || digestMissing || !!decisionReceipt || item.status === 'QUEUED'}
              className="ui-button ui-button--secondary ui-button--sm"
            >
              Hủy
            </button>
          </div>

          <div className="flex items-center gap-2">
            {!isModifying ? (
              <button type="button" onClick={handleStartModify} disabled={isSubmitting || digestMissing || !!decisionReceipt || item.status === 'QUEUED'} className="ui-button ui-button--secondary ui-button--sm">
                Sửa
              </button>
            ) : null}
            {!showRejectForm ? (
              <button
                type="button"
                onClick={() => {
                  setShowRejectForm(true);
                  setIsModifying(false);
                }}
                disabled={isSubmitting || digestMissing || !!decisionReceipt || item.status === 'QUEUED'}
                className="ui-button ui-button--danger ui-button--sm"
              >
                Từ chối…
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => handleExecute('APPROVE', 'OPERATOR_APPROVED')}
              disabled={isSubmitting || digestMissing || isModifying || showRejectForm || !!decisionReceipt || item.status === 'QUEUED'}
              className="ui-button ui-button--primary ui-button--sm"
            >
              {isSubmitting ? 'Đang gửi…' : 'Phê duyệt'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

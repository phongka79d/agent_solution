/**
 * @file apps/command-center/src/components/approvals/ApprovalPayloadDiffModal.tsx
 * Modal displaying action payload, reviewed payload SHA-256 digest, editable parameters for MODIFY,
 * and the 5 standardized governance decision buttons with in-flight duplicate prevention and 409 detection.
 */
'use client';

import React, { useState, useEffect } from 'react';
import type {
  ApprovalItem,
  ApprovalDecision,
  ApprovalDecisionResponse,
  ApiErrorResponse,
} from './types';
import { STANDARD_REJECTION_CODES } from './types';

interface ApprovalPayloadDiffModalProps {
  readonly item: ApprovalItem | null;
  readonly operatorId: string;
  readonly onClose: () => void;
  readonly onSubmitDecision: (
    id: string,
    decision: ApprovalDecision,
    reason: string,
    expectedPayloadSha256: string,
    modifiedPayload?: Record<string, unknown>
  ) => Promise<ApprovalDecisionResponse>;
  readonly onViewCustomer?: (customerId: string) => void;
}

export function ApprovalPayloadDiffModal({
  item,
  operatorId,
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
    readonly isConflict?: boolean;
    readonly correlationId?: string;
    readonly errorCode?: string;
  } | null>(null);

  const [decisionReceipt, setDecisionReceipt] = useState<ApprovalDecisionResponse | null>(null);

  useEffect(() => {
    if (item) {
      setIsModifying(false);
      setModifiedJsonText(JSON.stringify(item.payload, null, 2));
      setJsonParseError(null);
      setShowRejectForm(false);
      setCustomRejectReason('');
      setSubmissionError(null);
      setDecisionReceipt(null);
    }
  }, [item]);

  if (!item) return null;

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
    if (isSubmitting) return; // Prevent duplicate submissions in flight

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
    } catch (err: unknown) {
      const apiErr = err as ApiErrorResponse & { status?: number; isConflict?: boolean };
      const is409 = apiErr.status === 409 || apiErr.isConflict === true;
      setSubmissionError({
        message: apiErr.message || 'Decision submission failed.',
        isConflict: is409,
        correlationId: apiErr.correlation_id,
        errorCode: apiErr.error_code,
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
    (typeof item.payload.customer_id === 'string'
      ? item.payload.customer_id
      : typeof item.payload.customerId === 'string'
      ? item.payload.customerId
      : undefined);

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex justify-between items-start pb-4 border-b border-slate-800 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-mono px-2 py-0.5 bg-slate-950 text-slate-300 rounded border border-slate-800">
                #{item.id}
              </span>
              <h2 id="approval-modal-title" className="font-bold text-lg text-slate-100">
                {item.title || 'AUTH-4 Governance Checkpoint'}
              </h2>
              <span
                className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                  item.isPaused || item.status === 'PAUSED'
                    ? 'bg-sky-950 text-sky-300 border-sky-700'
                    : 'bg-amber-950 text-amber-300 border-amber-700'
                }`}
              >
                {item.isPaused || item.status === 'PAUSED' ? 'PAUSED' : 'AWAITING_HUMAN'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Agent: <strong className="text-slate-200">{item.agentId}</strong> | Operator Session:{' '}
              <strong className="text-slate-200">{operatorId}</strong>
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-slate-200 text-sm px-2 py-1 rounded bg-slate-800 hover:bg-slate-750 transition-colors disabled:opacity-50"
          >
            Close
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
          {/* Metadata Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                Risk Governance Reason
              </span>
              <p className="text-slate-200 font-mono text-[11px] break-words">{item.reason}</p>
            </div>

            <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                Reviewed Payload SHA-256 Digest
              </span>
              <p className="text-emerald-400 font-mono text-[11px] break-all select-all">
                {item.payloadSha256 || 'Digest unavailable'}
              </p>
              <span className="text-[10px] text-slate-400 block mt-1">
                Enforced server-side precondition (R05 / 409 conflict guard)
              </span>
            </div>
          </div>

          {/* Cross navigation to Customer 360 if customerId exists */}
          {extractedCustomerId && onViewCustomer && (
            <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg flex items-center justify-between">
              <div>
                <span className="text-slate-400">Associated Customer:</span>{' '}
                <strong className="text-slate-200 font-mono">{extractedCustomerId}</strong>
              </div>
              <button
                type="button"
                onClick={() => onViewCustomer(extractedCustomerId)}
                className="px-3 py-1 bg-sky-950 text-sky-300 border border-sky-800 hover:bg-sky-900 rounded font-semibold text-[11px] transition-colors"
              >
                Inspect Customer 360 (SCR-004) →
              </button>
            </div>
          )}

          {/* Payload Inspection / Editing */}
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Action Payload:
              </span>
              {isModifying && (
                <span className="text-[11px] text-amber-400 font-mono">
                  Editing payload for MODIFY revision
                </span>
              )}
            </div>

            {isModifying ? (
              <div className="space-y-2">
                <textarea
                  value={modifiedJsonText}
                  onChange={(e) => setModifiedJsonText(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full h-56 bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs font-mono text-emerald-300 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  placeholder="Enter modified JSON payload..."
                />
                {jsonParseError && (
                  <p className="text-xs text-rose-400 font-mono">{jsonParseError}</p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCancelModify}
                    disabled={isSubmitting}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs"
                  >
                    Cancel Edit
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveModify}
                    disabled={isSubmitting}
                    className="px-4 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded font-semibold text-xs flex items-center gap-1.5"
                  >
                    {isSubmitting ? 'Submitting Revision…' : 'Submit MODIFY Revision'}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="text-[11px] font-mono text-slate-300 bg-slate-900/90 p-3 rounded-lg border border-slate-850 overflow-x-auto whitespace-pre-wrap max-h-56">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
            )}
          </div>

          {/* Rejection Form Drawer */}
          {showRejectForm && (
            <div className="p-4 bg-rose-950/40 border border-rose-900/80 rounded-xl space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-rose-300">
                  Submit REJECT Decision (AUTH-4 Terminal Stop)
                </span>
                <button
                  type="button"
                  onClick={() => setShowRejectForm(false)}
                  className="text-slate-400 hover:text-slate-200 text-xs"
                >
                  Cancel
                </button>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                  Standardized Rejection Code (Mandatory):
                </label>
                <select
                  value={rejectCode}
                  onChange={(e) => setRejectCode(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-200 outline-none"
                >
                  {STANDARD_REJECTION_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                  Detailed Rationale / Notes (Optional context):
                </label>
                <input
                  type="text"
                  value={customRejectReason}
                  onChange={(e) => setCustomRejectReason(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="e.g. Budget ceiling 100k TWD exceeded by 86k TWD"
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-200 outline-none"
                />
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={handleConfirmReject}
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-semibold text-xs transition-colors"
                >
                  {isSubmitting ? 'Submitting REJECT…' : 'Confirm REJECT'}
                </button>
              </div>
            </div>
          )}

          {/* Conflict or Error Notification */}
          {submissionError && (
            <div
              className={`p-3.5 rounded-xl border ${
                submissionError.isConflict
                  ? 'bg-amber-950/40 border-amber-700/80 text-amber-200'
                  : 'bg-rose-950/40 border-rose-800 text-rose-200'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-bold text-xs">
                  {submissionError.isConflict
                    ? 'version_conflict: 409 Conflict Detected'
                    : 'Decision Submission Failed'}
                </span>
                {submissionError.errorCode && (
                  <span className="font-mono text-[10px] px-1.5 py-0.2 bg-black/40 rounded border border-current">
                    {submissionError.errorCode}
                  </span>
                )}
              </div>
              <p className="text-[11px] font-mono break-words">{submissionError.message}</p>
              {submissionError.correlationId && (
                <p className="text-[10px] text-slate-400 font-mono mt-1">
                  Correlation ID: {submissionError.correlationId}
                </p>
              )}
            </div>
          )}

          {/* Decision Success Receipt */}
          {decisionReceipt && (
            <div className="p-3.5 bg-emerald-950/40 border border-emerald-800 rounded-xl text-emerald-200 space-y-1">
              <div className="font-bold text-xs flex items-center gap-2">
                <span>Server Receipt Received: Status {decisionReceipt.status}</span>
              </div>
              <p className="text-[11px] font-mono">
                Approval ID: {decisionReceipt.approval_id} | Task ID: {decisionReceipt.task_id}
              </p>
              <p className="text-[10px] font-mono text-emerald-400">
                Decided At: {decisionReceipt.decided_at} | Correlation ID:{' '}
                {decisionReceipt.correlation_id}
              </p>
            </div>
          )}
        </div>

        {/* 5 Standardized Governance Decisions Bar */}
        <div className="pt-4 border-t border-slate-800 flex justify-between items-center mt-4 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {/* 4. PAUSE */}
            <button
              type="button"
              onClick={() =>
                handleExecute('PAUSE', 'OPERATOR_PAUSED_FOR_INVESTIGATION')
              }
              disabled={isSubmitting || !!decisionReceipt}
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 hover:border-sky-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Pause
            </button>

            {/* 5. CANCEL */}
            <button
              type="button"
              onClick={() => handleExecute('CANCEL', 'OPERATOR_CANCELLED_RUN')}
              disabled={isSubmitting || !!decisionReceipt}
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:border-slate-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel Run
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* 3. MODIFY */}
            {!isModifying && (
              <button
                type="button"
                onClick={handleStartModify}
                disabled={isSubmitting || !!decisionReceipt}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-amber-400 border border-slate-700 hover:border-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Modify Payload
              </button>
            )}

            {/* 2. REJECT */}
            {!showRejectForm && (
              <button
                type="button"
                onClick={() => {
                  setShowRejectForm(true);
                  setIsModifying(false);
                }}
                disabled={isSubmitting || !!decisionReceipt}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-rose-400 border border-slate-700 hover:border-rose-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reject…
              </button>
            )}

            {/* 1. APPROVE */}
            <button
              type="button"
              onClick={() => handleExecute('APPROVE', 'OPERATOR_APPROVED')}
              disabled={isSubmitting || isModifying || showRejectForm || !!decisionReceipt}
              className="px-5 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <>
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  Submitting…
                </>
              ) : (
                'Approve'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

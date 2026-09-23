/**
 * @file apps/command-center/src/components/conversation/EvaluationUnavailableModal.tsx
 * Modal explaining that Dialogue Evaluation persistence is currently unavailable.
 * Strictly adheres to constraint: "Add no evaluation persistence route because no such /api/v1 contract is available; show unavailable for evaluation."
 */
'use client';

import React from 'react';

export interface EvaluationUnavailableModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly conversationId: string;
}

export function EvaluationUnavailableModal({
  isOpen,
  onClose,
  conversationId,
}: EvaluationUnavailableModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="eval-modal-title"
    >
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4 text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex justify-between items-start">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-amber-950 text-amber-300 border border-amber-800">
                dependency_unavailable
              </span>
              <span className="text-xs font-mono text-slate-400">SCR-005 §6.3</span>
            </div>
            <h2 id="eval-modal-title" className="text-base font-semibold text-slate-100">
              Dialogue Quality Evaluation
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-lg p-1 rounded hover:bg-slate-800 transition-colors"
            aria-label="Close modal"
          >
            &times;
          </button>
        </div>

        {/* State Explanation Banner */}
        <div className="p-3 bg-amber-950/40 border border-amber-800/60 rounded-lg text-xs text-amber-200 space-y-1">
          <p className="font-semibold">No Contracted /api/v1 Evaluation Route Available</p>
          <p className="text-amber-300/80 leading-relaxed text-[11px]">
            Although SCR-005 §6.3 describes a human dialogue quality evaluation flow (1–5 Stars and
            Category Flags: ACCURACY, BRAND_VOICE, LATENCY, REASONING_COMPLIANCE), no corresponding
            evaluation persistence endpoint is specified in the authoritative OpenAPI 3.1 gateway
            registry (implement/06-api-and-connectors-spec.md §1).
          </p>
        </div>

        {/* Disabled Evaluation Specification Form Preview */}
        <div className="space-y-3 p-3 bg-slate-950/70 border border-slate-800/80 rounded-lg text-xs opacity-60 pointer-events-none select-none">
          <div>
            <label className="block text-[11px] font-mono text-slate-400 mb-1">
              Conversation Session:
            </label>
            <input
              type="text"
              readOnly
              value={conversationId || 'N/A'}
              className="w-full bg-slate-900 border border-slate-800 rounded p-1.5 text-xs text-slate-300 font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-mono text-slate-400 mb-1">
              Quality Rating (1-5 Stars):
            </label>
            <div className="flex gap-2 text-slate-500">
              {['★', '★', '★', '★', '★'].map((star, idx) => (
                <span key={idx} className="text-lg">
                  {star}
                </span>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-mono text-slate-400 mb-1">
              Category Flags:
            </label>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              {['ACCURACY', 'BRAND_VOICE', 'LATENCY', 'REASONING_COMPLIANCE'].map((flag) => (
                <label key={flag} className="flex items-center gap-1.5">
                  <input type="checkbox" disabled className="rounded border-slate-700" />
                  <span>{flag}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex justify-between items-center pt-2">
          <span className="text-[10px] font-mono text-slate-500">
            Fail-closed state: zero uncontracted network mutations.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-semibold border border-slate-700 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

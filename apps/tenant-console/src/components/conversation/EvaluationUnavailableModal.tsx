/**
 * Modal explaining that Dialogue Evaluation persistence is unavailable.
 * No uncontracted /api/v1 route is added; the UI remains dependency_unavailable.
 */
'use client';


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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="eval-modal-title"
    >
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-line bg-surface p-6 text-ink shadow-l2 animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex justify-between items-start">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="rounded px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider bg-warning-bg text-warning border border-warning-border">
                dependency_unavailable
              </span>
              <span className="text-xs font-mono text-muted">SCR-005 §6.3</span>
            </div>
            <h2 id="eval-modal-title" className="text-base font-semibold text-ink">
              Dialogue Quality Evaluation
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-lg text-muted transition-colors hover:bg-surface-low hover:text-ink"
            aria-label="Close modal"
          >
            &times;
          </button>
        </div>

        {/* State Explanation Banner */}
        <div className="space-y-1 rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning">
          <p className="font-semibold">No Contracted /api/v1 Evaluation Route Available</p>
          <p className="text-[11px] leading-relaxed text-warning/80">
            Although SCR-005 §6.3 describes a human dialogue quality evaluation flow (1–5 Stars and
            Category Flags: ACCURACY, BRAND_VOICE, LATENCY, REASONING_COMPLIANCE), no corresponding
            evaluation persistence endpoint is specified in the authoritative OpenAPI 3.1 gateway
            registry (implement/06-api-and-connectors-spec.md §1).
          </p>
        </div>

        {/* Disabled Evaluation Specification Form Preview */}
        <div className="pointer-events-none select-none space-y-3 rounded-lg border border-line bg-surface-low p-3 text-xs opacity-60">
          <div>
            <label className="mb-1 block text-[11px] font-mono text-muted">
              Conversation Session:
            </label>
            <input
              type="text"
              readOnly
              value={conversationId || 'N/A'}
              className="ui-input w-full rounded p-1.5 text-xs font-mono"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-mono text-muted">
              Quality Rating (1-5 Stars):
            </label>
            <div className="flex gap-2 text-muted">
              {['★', '★', '★', '★', '★'].map((star, idx) => (
                <span key={idx} className="text-lg">
                  {star}
                </span>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-mono text-muted">
              Category Flags:
            </label>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-muted">
              {['ACCURACY', 'BRAND_VOICE', 'LATENCY', 'REASONING_COMPLIANCE'].map((flag) => (
                <label key={flag} className="flex items-center gap-1.5">
                  <input type="checkbox" disabled className="rounded border-line" />
                  <span>{flag}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex justify-between items-center pt-2">
          <span className="text-[10px] font-mono text-muted">
            Fail-closed state: zero uncontracted network mutations.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ui-button ui-button--secondary rounded px-4 py-1.5 text-xs"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

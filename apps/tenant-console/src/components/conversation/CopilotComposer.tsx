/**
 * Operator chat composer with AI Copilot draft suggestion card (AUTH-2).
 * Drafts remain internal and require operator review before sending.
 * Supports module routing and fresh idempotency keys per send.
 */
'use client';

import { useState } from 'react';
import type { CopilotDraft } from './types';

export interface CopilotComposerProps {
  readonly copilotDraft: CopilotDraft | null;
  readonly isTakenOver: boolean;
  readonly isSending: boolean;
  readonly onSendMessage: (
    content: string,
    module: 'marketing' | 'sales' | 'support' | 'auto'
  ) => Promise<void>;
  readonly onDiscardDraft: () => void;
  readonly disabled?: boolean;
}

export function CopilotComposer({
  copilotDraft,
  isTakenOver,
  isSending,
  onSendMessage,
  onDiscardDraft,
  disabled = false,
}: CopilotComposerProps) {
  const [inputText, setInputText] = useState('');
  const [selectedModule, setSelectedModule] = useState<
    'marketing' | 'sales' | 'support' | 'auto'
  >('support');

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isSending || disabled) return;

    try {
      await onSendMessage(trimmed, selectedModule);
      setInputText('');
    } catch {
      // Error handling is managed by parent caller
    }
  };

  const handleApplyDraft = () => {
    if (copilotDraft) {
      setInputText(copilotDraft.text);
      if (copilotDraft.suggested_module) {
        setSelectedModule(copilotDraft.suggested_module);
      }
      onDiscardDraft();
    }
  };

  return (
    <div className="tenant-copilot-composer">
      {/* Copilot Suggested Response Card (AUTH-2 Internal Draft Mode) */}
      {copilotDraft && (
        <div className="tenant-copilot-draft">
          <div className="flex flex-wrap justify-between items-center gap-2 mb-1.5">
            <div className="flex items-center gap-2">
              <span className="tenant-summary-badge tenant-summary-badge--info">
                AUTH-2 Internal Draft
              </span>
              <span className="text-sm font-semibold text-info">
                Copilot Suggestion (Invisible to Customer)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApplyDraft}
                className="ui-button ui-button--secondary ui-button--sm"
              >
                Insert into Composer
              </button>
              <button
                type="button"
                onClick={onDiscardDraft}
                className="ui-button ui-button--ghost ui-button--sm"
              >
                Discard
              </button>
            </div>
          </div>
          <p className="tenant-copilot-quote">
            "{copilotDraft.text}"
          </p>
          <span className="block text-xs text-muted">
            Internal draft requires human operator review. It will not be sent until you click Send.
          </span>
        </div>
      )}

      {/* Outbound Control State Bar & Module Selector */}
      <div className="flex flex-wrap justify-between items-center gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Module:</span>
          <div className="tenant-module-selector">
            {(['support', 'sales', 'marketing', 'auto'] as const).map((mod) => (
              <button
                key={mod}
                type="button"
                onClick={() => setSelectedModule(mod)}
                className={`px-2 py-1 text-[11px] font-mono rounded capitalize transition-colors ${
                  selectedModule === mod
                    ? 'tenant-module-selector__active'
                    : 'text-muted hover:text-ink'
                }`}
              >
                {mod}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[11px] font-mono">
          {isTakenOver ? (
            <span className="text-warning font-semibold">
              Mode: HUMAN_ACTIVE (Autonomous Outbound Hard-Locked)
            </span>
          ) : (
            <span className="text-muted">
              Mode: AI_CONTROLLED (Outbound bot responses active)
            </span>
          )}
        </div>
      </div>

      {/* Operator Keystroke Input Bar */}
      <div className="flex gap-2 items-end">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={disabled || isSending}
          placeholder={
            isTakenOver
              ? 'Type message to customer as human operator (Enter to send, Shift+Enter for new line)...'
              : 'Acquire takeover to suppress autonomous AI replies, or type to send operator message...'
          }
          className="ui-input flex-1 h-20 resize-none rounded-lg p-2.5 text-xs outline-none transition-colors placeholder:text-muted disabled:opacity-50"
          maxLength={4000}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={disabled || isSending || !inputText.trim()}
          className="ui-button ui-button--primary h-10 shrink-0 px-5 text-xs shadow-sm disabled:opacity-50"
        >
          {isSending ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary-ink animate-pulse" />
              Submitting...
            </span>
          ) : (
            'Send'
          )}
        </button>
      </div>

      <div className="flex justify-between items-center px-1 text-[10px] text-muted">
        <span>Idempotency-protected execution via POST /api/v1/conversations/{'{id}'}/messages</span>
        <span>{inputText.length} / 4000 characters</span>
      </div>
    </div>
  );
}

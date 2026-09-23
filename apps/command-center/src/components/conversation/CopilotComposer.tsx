/**
 * @file apps/command-center/src/components/conversation/CopilotComposer.tsx
 * Operator chat composer with AI Copilot draft suggestion card (AUTH-2).
 * Strictly enforces that Copilot drafts are internal AUTH-2 suggestions and never auto-send.
 * Supports module routing (support, sales, marketing, auto) and fresh idempotency keys per send.
 */
'use client';

import React, { useState } from 'react';
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
    <div className="p-3 sm:p-4 bg-slate-900 border-t border-slate-800 space-y-3">
      {/* Copilot Suggested Response Card (AUTH-2 Internal Draft Mode) */}
      {copilotDraft && (
        <div className="p-3 bg-slate-950 border border-sky-900/70 rounded-lg shadow-sm">
          <div className="flex flex-wrap justify-between items-center gap-2 mb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-950 text-sky-300 border border-sky-800">
                AUTH-2 Internal Draft
              </span>
              <span className="text-xs font-semibold text-sky-400">
                Copilot Suggestion (Invisible to Customer)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApplyDraft}
                className="text-xs text-sky-300 hover:text-sky-200 font-semibold px-2 py-0.5 rounded bg-sky-900/40 hover:bg-sky-900/60 border border-sky-800 transition-colors"
                title="Copies draft into operator composer for manual review"
              >
                Insert into Composer
              </button>
              <button
                type="button"
                onClick={onDiscardDraft}
                className="text-xs text-slate-400 hover:text-slate-300 px-2 py-0.5 transition-colors"
              >
                Discard
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-200 italic leading-relaxed pl-1 border-l-2 border-sky-800/80 my-1">
            "{copilotDraft.text}"
          </p>
          <span className="text-[10px] text-slate-500 block">
            Internal draft requires human operator review. It will not be sent until you click Send.
          </span>
        </div>
      )}

      {/* Outbound Control State Bar & Module Selector */}
      <div className="flex flex-wrap justify-between items-center gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-[11px] font-medium">Module:</span>
          <div className="inline-flex rounded-md shadow-sm border border-slate-800 bg-slate-950 p-0.5">
            {(['support', 'sales', 'marketing', 'auto'] as const).map((mod) => (
              <button
                key={mod}
                type="button"
                onClick={() => setSelectedModule(mod)}
                className={`px-2 py-1 text-[11px] font-mono rounded capitalize transition-colors ${
                  selectedModule === mod
                    ? 'bg-sky-700 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mod}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[11px] font-mono">
          {isTakenOver ? (
            <span className="text-amber-400 font-semibold">
              Mode: HUMAN_ACTIVE (Autonomous Outbound Hard-Locked)
            </span>
          ) : (
            <span className="text-slate-400">
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
          className="flex-1 bg-slate-950 border border-slate-800 focus:border-sky-600 rounded-lg p-2.5 text-xs text-slate-200 outline-none resize-none h-20 transition-colors placeholder:text-slate-500 disabled:opacity-50"
          maxLength={4000}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={disabled || isSending || !inputText.trim()}
          className="px-5 h-10 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors flex items-center justify-center shrink-0"
        >
          {isSending ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              Submitting...
            </span>
          ) : (
            'Send'
          )}
        </button>
      </div>

      <div className="flex justify-between items-center text-[10px] text-slate-500 px-1">
        <span>Idempotency-protected execution via POST /api/v1/conversations/{'{id}'}/messages</span>
        <span>{inputText.length} / 4000 characters</span>
      </div>
    </div>
  );
}

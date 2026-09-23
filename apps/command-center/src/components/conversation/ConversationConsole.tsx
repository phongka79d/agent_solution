/**
 * @file apps/command-center/src/components/conversation/ConversationConsole.tsx
 * Root component for SCR-005: Conversation Console.
 * Strictly adheres to implement/06-api-and-connectors-spec.md and implement/07-human-command-center-ui.md §6.
 */
'use client';

import React, { useState, useEffect } from 'react';
import { apiClient, ApiError } from '../../lib/api-client';
import type { ChatMessage, ConversationConsoleProps } from './types';
import { useConversationTakeover } from '../../hooks/useConversationTakeover';
import { useConversationWebSocket } from '../../hooks/useConversationWebSocket';
import { TakeoverControls } from './TakeoverControls';
import { MessageStream } from './MessageStream';
import { CopilotComposer } from './CopilotComposer';
import { EvaluationUnavailableModal } from './EvaluationUnavailableModal';

export function ConversationConsole({
  initialConversationId = '',
  initialTenantId = '',
  initialOperatorId = '',
}: ConversationConsoleProps) {
  // Read conversation identity from props/URL without inventing mock data
  const [conversationId, setConversationId] = useState<string>(initialConversationId);
  const [tenantId, setTenantId] = useState<string>(initialTenantId);
  const [operatorId, setOperatorId] = useState<string>(initialOperatorId);

  // Input states for the header configuration toolbar
  const [convInput, setConvInput] = useState<string>(initialConversationId);
  const [tenantInput, setTenantInput] = useState<string>(initialTenantId);
  const [operatorInput, setOperatorInput] = useState<string>(initialOperatorId);

  const [isEvaluationOpen, setIsEvaluationOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Sync prop changes
  useEffect(() => {
    if (initialConversationId !== conversationId) {
      setConversationId(initialConversationId);
      setConvInput(initialConversationId);
    }
  }, [initialConversationId, conversationId]);

  useEffect(() => {
    if (initialTenantId !== tenantId) {
      setTenantId(initialTenantId);
      setTenantInput(initialTenantId);
    }
  }, [initialTenantId, tenantId]);

  useEffect(() => {
    if (initialOperatorId !== operatorId) {
      setOperatorId(initialOperatorId);
      setOperatorInput(initialOperatorId);
    }
  }, [initialOperatorId, operatorId]);

  // Hook 1: Takeover Mutex Lease (SCR-005)
  const {
    isTakenOver,
    leaseState,
    leaseExpiresAt,
    lastHeartbeatAt,
    errorMessage: takeoverError,
    acquireTakeover,
    resumeConversation,
    setErrorMessage: setTakeoverError,
  } = useConversationTakeover({
    conversationId,
    tenantId,
    operatorId,
  });

  // Hook 2: WebSocket stream (/api/v1/ws/stream)
  const {
    status: streamStatus,
    messages,
    copilotDraft,
    streamError,
    setCopilotDraft,
    addLocalMessage,
    updateMessage,
    reconnect: reconnectStream,
  } = useConversationWebSocket({
    conversationId,
    tenantId,
    operatorId,
    enabled: Boolean(conversationId && tenantId),
  });

  // Apply inputs from toolbar
  const handleApplyConfig = (e: React.FormEvent) => {
    e.preventDefault();
    setConversationId(convInput.trim());
    setTenantId(tenantInput.trim());
    setOperatorId(operatorInput.trim());
  };

  /**
   * Dispatches an operator reply to the conversation: POST /api/v1/conversations/{id}/messages
   * Generates a fresh idempotency_key per submission (BR-005/BR-006).
   */
  const handleSendMessage = async (
    text: string,
    module: 'marketing' | 'sales' | 'support' | 'auto'
  ): Promise<void> => {
    if (!conversationId) {
      setSendError('Cannot send message: no active conversation session.');
      return;
    }

    setIsSending(true);
    setSendError(null);

    const idempotencyKey = crypto.randomUUID();
    const tempMessageId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = new Date().toISOString();

    // Optimistically record message with status 'pending' (never fake 'delivered' before receipt)
    const pendingMessage: ChatMessage = {
      id: tempMessageId,
      conversation_id: conversationId,
      sender: 'operator',
      content: text,
      timestamp,
      module,
      status: 'pending',
      idempotency_key: idempotencyKey,
    };
    addLocalMessage(pendingMessage);

    try {
      const receipt = await apiClient.postConversationMessage(
        conversationId,
        {
          module,
          message: text,
          idempotency_key: idempotencyKey,
          sender: 'operator',
        },
        { tenantId, operatorId }
      );

      // On 202 TaskAcceptedResponse, update message status to 'accepted' with task_id
      updateMessage(tempMessageId, {
        status: receipt.status || 'accepted',
        task_id: receipt.task_id,
        correlation_id: receipt.correlation_id,
      });
    } catch (err) {
      console.error('Failed to dispatch operator message:', err);
      const errMsg = err instanceof ApiError ? err.message : 'Message dispatch failed.';
      setSendError(errMsg);
      updateMessage(tempMessageId, {
        status: 'failed',
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Configuration & Identification Toolbar */}
      <div className="bg-slate-900/80 border-b border-slate-800 p-2.5 px-4 flex flex-wrap justify-between items-center gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sky-400 text-sm">SCR-005</span>
          <span className="text-slate-400 font-semibold">Conversation Console</span>
          {conversationId ? (
            <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-slate-800 text-slate-200 border border-slate-700">
              #{conversationId}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded font-mono text-[11px] bg-amber-950 text-amber-300 border border-amber-800">
              No session bound
            </span>
          )}
        </div>

        {/* Inputs form for Session, Tenant, Operator */}
        <form onSubmit={handleApplyConfig} className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <label htmlFor="conv-id-input" className="text-[11px] font-mono text-slate-400">
              Session:
            </label>
            <input
              id="conv-id-input"
              type="text"
              value={convInput}
              onChange={(e) => setConvInput(e.target.value)}
              placeholder="e.g. conv-123"
              className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 outline-none focus:border-sky-600 w-28"
            />
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="tenant-id-input" className="text-[11px] font-mono text-slate-400">
              Tenant:
            </label>
            <input
              id="tenant-id-input"
              type="text"
              value={tenantInput}
              onChange={(e) => setTenantInput(e.target.value)}
              placeholder="e.g. tenant-tw"
              className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 outline-none focus:border-sky-600 w-24"
            />
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="operator-id-input" className="text-[11px] font-mono text-slate-400">
              Operator:
            </label>
            <input
              id="operator-id-input"
              type="text"
              value={operatorInput}
              onChange={(e) => setOperatorInput(e.target.value)}
              placeholder="e.g. OP-01"
              className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 outline-none focus:border-sky-600 w-20"
            />
          </div>

          <button
            type="submit"
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium border border-slate-700 transition-colors"
          >
            Bind
          </button>
        </form>
      </div>

      {/* Takeover Mutex Control Bar */}
      <TakeoverControls
        isTakenOver={isTakenOver}
        leaseState={leaseState}
        leaseExpiresAt={leaseExpiresAt}
        lastHeartbeatAt={lastHeartbeatAt}
        errorMessage={takeoverError}
        onTakeover={async () => { await acquireTakeover({ reason: 'OPERATOR_MANUAL_TAKEOVER', takeoverMode: 'FULL_CONTROL' }); }}
        onResume={async () => { await resumeConversation({ handoffSummary: 'OPERATOR_RETURN_TO_AGENT' }); }}
        onOpenEvaluation={() => setIsEvaluationOpen(true)}
        onClearError={() => setTakeoverError(null)}
        disabled={!conversationId || !operatorId}
      />

      {/* Send Error Notice */}
      {sendError && (
        <div className="bg-rose-950/70 border-b border-rose-800/80 p-2 px-4 text-xs text-rose-200 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-[10px] uppercase px-1.5 py-0.5 rounded bg-black/40 border border-rose-700/60">
              Dispatch Error
            </span>
            <span>{sendError}</span>
          </div>
          <button
            type="button"
            onClick={() => setSendError(null)}
            className="text-slate-400 hover:text-slate-200 text-xs underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Message Stream */}
      <MessageStream
        conversationId={conversationId}
        streamStatus={streamStatus}
        streamError={streamError}
        messages={messages}
        isTakenOver={isTakenOver}
        onReconnect={reconnectStream}
      />

      {/* Copilot Assistant & Operator Message Composer */}
      <CopilotComposer
        copilotDraft={isTakenOver ? copilotDraft : null}
        isTakenOver={isTakenOver}
        isSending={isSending}
        onSendMessage={handleSendMessage}
        onDiscardDraft={() => setCopilotDraft(null)}
        disabled={!conversationId}
      />

      {/* Dialogue Evaluation Unavailable Modal */}
      <EvaluationUnavailableModal
        isOpen={isEvaluationOpen}
        onClose={() => setIsEvaluationOpen(false)}
        conversationId={conversationId}
      />
    </div>
  );
}

/**
 * Chronological message history stream for SCR-005 Conversation Console.
 * Reflects live WebSocket frames from /api/v1/ws/stream with explicit status states.
 */
'use client';

import { useRef, useEffect } from 'react';
import type { ChatMessage, WebSocketStreamStatus } from './types';

export interface MessageStreamProps {
  readonly conversationId: string;
  readonly streamStatus: WebSocketStreamStatus;
  readonly streamError: string | null;
  readonly messages: readonly ChatMessage[];
  readonly isTakenOver: boolean;
  readonly onReconnect?: () => void;
}

export function MessageStream({
  conversationId,
  streamStatus,
  streamError,
  messages,
  isTakenOver,
  onReconnect,
}: MessageStreamProps) {
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Case 1: No conversation specified
  if (!conversationId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-canvas p-8 text-center text-muted">
        <div className="mb-3 rounded-full border border-line bg-surface p-3">
          <span className="font-mono text-sm font-bold text-muted">SCR-005</span>
        </div>
        <h3 className="mb-1 text-sm font-semibold text-ink">No Conversation Selected</h3>
        <p className="max-w-md text-xs text-muted">
          Provide a conversation identifier via URL parameter (?id=... or ?conversation_id=...) or
          enter one in the toolbar above to initiate live monitoring.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-canvas">
      {/* Stream Status Header Banner */}
      <div className="z-10 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/90 px-4 py-2 text-xs backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-muted">Stream Status:</span>
          {streamStatus === 'connected' ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-success-border bg-success-bg px-2 py-0.5 text-[10px] font-mono font-bold text-success">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              LIVE (/api/v1/ws/stream)
            </span>
          ) : streamStatus === 'connecting' ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-info-border bg-info-bg px-2 py-0.5 text-[10px] font-mono font-bold text-info">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-info" />
              CONNECTING
            </span>
          ) : streamStatus === 'disconnected' ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-warning-border bg-warning-bg px-2 py-0.5 text-[10px] font-mono font-bold text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              DISCONNECTED (STALE)
            </span>
          ) : streamStatus === 'error' ? (
            <span className="inline-flex items-center gap-1.5 rounded border border-danger-border bg-danger-bg px-2 py-0.5 text-[10px] font-mono font-bold text-danger">
              <span className="h-1.5 w-1.5 rounded-full bg-danger" />
              FAIL_CLOSED (ERROR)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded border border-neutral-border bg-neutral-bg px-2 py-0.5 text-[10px] font-mono font-bold text-neutral">
              UNAVAILABLE
            </span>
          )}

          {isTakenOver && (
            <span className="rounded border border-warning-border bg-warning-bg px-2 py-0.5 text-[10px] font-mono font-bold text-warning">
              OUTBOUND AI SUPPRESSED
            </span>
          )}
        </div>

        {streamStatus !== 'connected' && onReconnect && (
          <button
            type="button"
            onClick={onReconnect}
            className="text-[11px] font-semibold text-info underline hover:text-interactive-secondary"
          >
            Reconnect Stream
          </button>
        )}
      </div>

      {/* Stream Warning / Error Notice if disconnected or error */}
      {streamStatus !== 'connected' && streamStatus !== 'connecting' && (
        <div className="flex items-center justify-between border-b border-warning-border bg-warning-bg p-2.5 px-4 text-xs text-warning">
          <div className="flex items-center gap-2">
            <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase">
              Dependency Notice
            </span>
            <span>
              {streamError ||
                'WebSocket stream disconnected. Live incoming dialogues and keystroke sync are currently unavailable.'}
            </span>
          </div>
        </div>
      )}

      {/* Message List */}
      <div className="flex-1 p-4 sm:p-6 overflow-y-auto space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8">
            <div className="mb-2 rounded-full border border-line bg-surface p-3">
              <span className="font-mono text-xs text-muted">0 messages</span>
            </div>
            <p className="text-xs font-medium text-muted">
              {streamStatus === 'connected'
                ? 'No messages received on the live stream for this conversation yet.'
                : 'No messages to display. Connect to live stream to view messages.'}
            </p>
            <span className="mt-1 text-[10px] text-muted">
              Live updates stream directly from WebSocket /api/v1/ws/stream
            </span>
          </div>
        ) : (
          messages.map((msg) => {
            const isCustomer = msg.sender === 'customer';
            const isOperator = msg.sender === 'operator';

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  isCustomer ? 'items-start' : 'items-end'
                } group transition-all`}
              >
                {/* Message Header */}
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted">
                  <span
                    className={`font-bold px-1.5 py-0.2 rounded text-[10px] uppercase border ${
                      isCustomer
                        ? 'bg-surface text-ink-body border-line'
                        : isOperator
                        ? 'bg-warning-bg text-warning border-warning-border'
                        : 'bg-ai-bg text-ai-text border-ai-border'
                    }`}
                  >
                    {isCustomer ? 'CUSTOMER' : isOperator ? 'HUMAN OPERATOR' : 'AUTONOMOUS AI'}
                  </span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  {msg.module && (
                    <span className="capitalize text-muted">[{msg.module}]</span>
                  )}
                  {msg.status && (
                    <span
                      className={`text-[9px] px-1 rounded uppercase ${
                        msg.status === 'pending'
                          ? 'bg-warning-bg text-warning border border-warning-border'
                          : msg.status === 'accepted'
                          ? 'bg-success-bg text-success border border-success-border'
                          : 'bg-neutral-bg text-muted'
                      }`}
                    >
                      {msg.status}
                    </span>
                  )}
                </div>

                {/* Message Bubble */}
                <div
                  className={`p-3 rounded-xl max-w-lg text-xs leading-relaxed break-words shadow-sm ${
                    isCustomer
                      ? 'bg-surface border border-line text-ink-body'
                      : isOperator
                      ? 'bg-warning-bg border border-warning-border text-warning'
                      : 'bg-ai-bg border border-ai-border text-ai-text'
                  }`}
                >
                  {msg.content}
                </div>

                {/* Task ID / Correlation ID audit receipt */}
                {(msg.task_id || msg.correlation_id) && (
                  <div className="mt-0.5 text-[9px] font-mono text-muted opacity-0 transition-opacity group-hover:opacity-100">
                    {msg.task_id && <span>task: {msg.task_id}</span>}
                    {msg.task_id && msg.correlation_id && <span> · </span>}
                    {msg.correlation_id && <span>corr: {msg.correlation_id}</span>}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={scrollEndRef} />
      </div>
    </div>
  );
}

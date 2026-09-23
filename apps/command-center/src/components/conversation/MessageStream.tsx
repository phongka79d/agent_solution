/**
 * @file apps/command-center/src/components/conversation/MessageStream.tsx
 * Chronological message history stream for SCR-005 Conversation Console.
 * Strictly reflects live WebSocket frames from /api/v1/ws/stream.
 * Renders explicit loading, empty, stale, and unavailable states without mock data.
 */
'use client';

import React, { useRef, useEffect } from 'react';
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
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-950 text-slate-400">
        <div className="p-3 rounded-full bg-slate-900 border border-slate-800 mb-3">
          <span className="font-mono text-sm font-bold text-slate-500">SCR-005</span>
        </div>
        <h3 className="text-sm font-semibold text-slate-200 mb-1">No Conversation Selected</h3>
        <p className="text-xs text-slate-400 max-w-md">
          Provide a conversation identifier via URL parameter (?id=... or ?conversation_id=...) or
          enter one in the toolbar above to initiate live monitoring.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-950 overflow-hidden relative">
      {/* Stream Status Header Banner */}
      <div className="px-4 py-2 bg-slate-900/90 border-b border-slate-800 text-xs flex flex-wrap justify-between items-center gap-2 z-10 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400">Stream Status:</span>
          {streamStatus === 'connected' ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE (/api/v1/ws/stream)
            </span>
          ) : streamStatus === 'connecting' ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-950 text-sky-300 border border-sky-800">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
              CONNECTING
            </span>
          ) : streamStatus === 'disconnected' ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              DISCONNECTED (STALE)
            </span>
          ) : streamStatus === 'error' ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-950 text-rose-300 border border-rose-800">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              FAIL_CLOSED (ERROR)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
              UNAVAILABLE
            </span>
          )}

          {isTakenOver && (
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800">
              OUTBOUND AI SUPPRESSED
            </span>
          )}
        </div>

        {streamStatus !== 'connected' && onReconnect && (
          <button
            type="button"
            onClick={onReconnect}
            className="text-[11px] font-semibold text-sky-400 hover:text-sky-300 underline"
          >
            Reconnect Stream
          </button>
        )}
      </div>

      {/* Stream Warning / Error Notice if disconnected or error */}
      {streamStatus !== 'connected' && streamStatus !== 'connecting' && (
        <div className="bg-amber-950/40 border-b border-amber-900/50 p-2.5 px-4 text-xs text-amber-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-[10px] uppercase px-1.5 py-0.5 rounded bg-black/40 border border-amber-700/60">
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
            <div className="p-3 rounded-full bg-slate-900 border border-slate-800 mb-2">
              <span className="font-mono text-xs text-slate-400">0 messages</span>
            </div>
            <p className="text-xs text-slate-400 font-medium">
              {streamStatus === 'connected'
                ? 'No messages received on the live stream for this conversation yet.'
                : 'No messages to display. Connect to live stream to view messages.'}
            </p>
            <span className="text-[10px] text-slate-500 mt-1">
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
                <div className="flex items-center gap-2 mb-1 text-[11px] text-slate-400 font-mono">
                  <span
                    className={`font-bold px-1.5 py-0.2 rounded text-[10px] uppercase border ${
                      isCustomer
                        ? 'bg-slate-900 text-slate-300 border-slate-700'
                        : isOperator
                        ? 'bg-amber-950 text-amber-300 border-amber-800'
                        : 'bg-sky-950 text-sky-300 border-sky-800'
                    }`}
                  >
                    {isCustomer ? 'CUSTOMER' : isOperator ? 'HUMAN OPERATOR' : 'AUTONOMOUS AI'}
                  </span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  {msg.module && (
                    <span className="text-slate-500 capitalize">[{msg.module}]</span>
                  )}
                  {msg.status && (
                    <span
                      className={`text-[9px] px-1 rounded uppercase ${
                        msg.status === 'pending'
                          ? 'bg-amber-950/80 text-amber-400 border border-amber-800/80'
                          : msg.status === 'accepted'
                          ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/80'
                          : 'bg-slate-800 text-slate-400'
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
                      ? 'bg-slate-900 border border-slate-800 text-slate-200'
                      : isOperator
                      ? 'bg-amber-950/60 border border-amber-800/80 text-amber-100'
                      : 'bg-sky-950/60 border border-sky-800/80 text-sky-100'
                  }`}
                >
                  {msg.content}
                </div>

                {/* Task ID / Correlation ID audit receipt */}
                {(msg.task_id || msg.correlation_id) && (
                  <div className="text-[9px] font-mono text-slate-500 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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

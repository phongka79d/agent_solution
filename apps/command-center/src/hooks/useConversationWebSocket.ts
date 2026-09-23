/**
 * @file apps/command-center/src/hooks/useConversationWebSocket.ts
 * Realtime WebSocket stream hook for SCR-005 Conversation Console.
 * Connects to /api/v1/ws/stream per implement/06-api-and-connectors-spec.md §1 R10 and §10.
 * Strictly reflects live stream events without fabricated messages or fake data.
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiOrigin } from '../lib/api-client';
import type {
  ChatMessage,
  CopilotDraft,
  WebSocketStreamStatus,
} from '../components/conversation/types';

export interface UseConversationWebSocketParams {
  readonly conversationId: string;
  readonly tenantId?: string;
  readonly operatorId?: string;
  readonly token?: string;
  readonly enabled?: boolean;
  readonly onTakeoverEvent?: (
    event: 'takeover.acquired' | 'takeover.heartbeat' | 'takeover.released',
    data: unknown
  ) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 16_000;

function isValidTimestamp(val: unknown): boolean {
  if (typeof val === 'number') {
    return !isNaN(val) && val > 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return false;
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed) > 0;
    }
    return !isNaN(Date.parse(trimmed));
  }
  return false;
}


export function useConversationWebSocket({
  conversationId,
  tenantId,
  operatorId,
  token,
  enabled = true,
  onTakeoverEvent,
}: UseConversationWebSocketParams) {
  const [status, setStatus] = useState<WebSocketStreamStatus>('idle');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [copilotDraft, setCopilotDraft] = useState<CopilotDraft | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isUnmountedRef = useRef(false);

  const onTakeoverEventRef = useRef(onTakeoverEvent);
  onTakeoverEventRef.current = onTakeoverEvent;

  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;

  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    clearReconnectTimer();

    const activeConvId = conversationIdRef.current;
    const activeTenantId = tenantIdRef.current;
    const activeOperatorId = operatorIdRef.current;

    // Explicit unavailable state when conversation identifier is missing
    if (!activeConvId || !enabled) {
      setStatus('unavailable');
      setStreamError(!activeConvId ? 'No active conversation specified.' : null);
      return;
    }

    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      setStatus('unavailable');
      setStreamError('WebSocket is not supported in this runtime environment.');
      return;
    }

    // Close any prior socket instance
    if (socketRef.current !== null) {
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.onmessage = null;
      socketRef.current.close();
      socketRef.current = null;
    }

    setStatus('connecting');
    setStreamError(null);

    try {
      const base = apiOrigin();
      let wsProtocol = 'ws:';
      let cleanHost = 'localhost:4000';

      try {
        const parsed = new URL(base);
        wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        cleanHost = parsed.host;
      } catch {
        wsProtocol = base.startsWith('https:') ? 'wss:' : 'ws:';
        cleanHost = base.replace(/^https?:\/\//, '').replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
      }

      const searchParams = new URLSearchParams();
      searchParams.set('conversation_id', activeConvId);
      if (activeTenantId) {
        searchParams.set('tenant_id', activeTenantId);
      }
      if (activeOperatorId) {
        searchParams.set('operator_id', activeOperatorId);
      }
      if (token) {
        searchParams.set('token', token);
      }

      const wsUrl = `${wsProtocol}://${cleanHost}/api/v1/ws/stream?${searchParams.toString()}`;
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        if (isUnmountedRef.current) return;
        setStatus('connected');
        setStreamError(null);
        reconnectAttemptsRef.current = 0;
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        if (isUnmountedRef.current) return;
        setLastEventAt(new Date().toISOString());

        try {
          const payload = JSON.parse(event.data) as {
            event?: string;
            data?: Record<string, unknown>;
          };

          const eventName = payload.event;
          const data = (payload.data && typeof payload.data === 'object'
            ? payload.data
            : {}) as Record<string, unknown>;

          if (eventName === 'conversation.message') {
            const rawMsgConvId = data.conversation_id || data.conversationId;
            // Ignore messages for other conversations if scoped
            if (rawMsgConvId && String(rawMsgConvId) !== conversationIdRef.current) {
              return;
            }

            // Distinguish internal AUTH-2 copilot drafts from customer-visible messages
            const isDraft =
              Boolean(data.is_draft) ||
              data.classification === 'AUTH-2' ||
              data.authority === 'AUTH-2' ||
              data.type === 'draft';

            if (isDraft) {
              const draftText = String(data.content || data.message || data.text || '').trim();
              const rawDraftTimestamp = data.timestamp ?? data.generated_at;
              const draftTimestamp = isValidTimestamp(rawDraftTimestamp) ? String(rawDraftTimestamp).trim() : null;

              if (!draftText || !draftTimestamp) {
                setStreamError(
                  'Discarded malformed copilot draft frame: missing or malformed server draft text or timestamp.'
                );
                setStatus('error');
                return;
              }

              const rawDraftId = data.id ?? data.draft_id;
              const draftId =
                (typeof rawDraftId === 'string' && rawDraftId.trim().length > 0) ||
                (typeof rawDraftId === 'number' && !isNaN(rawDraftId))
                  ? String(rawDraftId).trim()
                  : undefined;

              setCopilotDraft({
                draft_id: draftId,
                text: draftText,
                classification: 'AUTH-2',
                generated_at: draftTimestamp,
                suggested_module: (data.module as 'marketing' | 'sales' | 'support' | 'auto') || 'support',
              });
              return;
            }

            // Standard chat message: require stable server id, timestamp, and non-empty content
            const rawMsgId = data.id ?? data.message_id;
            const msgId =
              (typeof rawMsgId === 'string' && rawMsgId.trim().length > 0) ||
              (typeof rawMsgId === 'number' && !isNaN(rawMsgId))
                ? String(rawMsgId).trim()
                : null;
            const rawTimestamp = data.timestamp ?? data.occurred_at ?? data.created_at;
            const timestamp = isValidTimestamp(rawTimestamp) ? String(rawTimestamp).trim() : null;
            const rawContent = data.content ?? data.message ?? data.text;
            const content =
              (typeof rawContent === 'string' && rawContent.trim().length > 0) ||
              (typeof rawContent === 'number' && !isNaN(rawContent))
                ? String(rawContent)
                : null;

            if (!msgId || !timestamp || !content) {
              setStreamError(
                'Discarded malformed conversation.message frame: missing or malformed server message identifier, timestamp, or content.'
              );
              setStatus('error');
              return;
            }

            const rawSender = String(data.sender || '').toLowerCase();
            const sender: 'customer' | 'ai' | 'operator' =
              rawSender === 'customer'
                ? 'customer'
                : rawSender === 'operator' || rawSender === 'human'
                ? 'operator'
                : 'ai';

            const module = (data.module as 'marketing' | 'sales' | 'support' | 'auto') || undefined;
            const task_id = data.task_id ? String(data.task_id) : undefined;
            const correlation_id = data.correlation_id ? String(data.correlation_id) : undefined;

            setMessages((prev) => {
              // Deduplicate if already present
              const existingIndex = prev.findIndex((m) => m.id === msgId);
              const updatedMsg: ChatMessage = {
                id: msgId,
                conversation_id: rawMsgConvId ? String(rawMsgConvId) : conversationIdRef.current,
                sender,
                content,
                timestamp,
                module,
                status: 'accepted',
                task_id,
                correlation_id,
              };

              if (existingIndex >= 0) {
                const next = [...prev];
                next[existingIndex] = updatedMsg;
                return next;
              }
              return [...prev, updatedMsg];
            });
          } else if (eventName === 'copilot.draft') {
            const draftText = String(data.text || data.message || data.content || '').trim();
            const rawDraftTimestamp = data.timestamp ?? data.generated_at;
            const draftTimestamp = isValidTimestamp(rawDraftTimestamp) ? String(rawDraftTimestamp).trim() : null;

            if (!draftText || !draftTimestamp) {
              setStreamError(
                'Discarded malformed copilot.draft frame: missing or malformed server draft text or timestamp.'
              );
              setStatus('error');
              return;
            }

            const rawDraftId = data.id ?? data.draft_id;
            const draftId =
              (typeof rawDraftId === 'string' && rawDraftId.trim().length > 0) ||
              (typeof rawDraftId === 'number' && !isNaN(rawDraftId))
                ? String(rawDraftId).trim()
                : undefined;

            setCopilotDraft({
              draft_id: draftId,
              text: draftText,
              classification: 'AUTH-2',
              generated_at: draftTimestamp,
              suggested_module: (data.module as 'marketing' | 'sales' | 'support' | 'auto') || 'support',
            });
          } else if (
            eventName === 'takeover.acquired' ||
            eventName === 'takeover.heartbeat' ||
            eventName === 'takeover.released'
          ) {
            onTakeoverEventRef.current?.(eventName, data);
          } else if (eventName === 'stream.error') {
            const reason = String(data.reason || 'Stream error event received.');
            setStreamError(reason);
            setStatus('error');
          }
        } catch (err) {
          console.error('Failed to parse WebSocket frame:', err);
          setStatus('error');
          setStreamError('Failed to parse WebSocket frame.');
        }
      };

      socket.onerror = () => {
        if (isUnmountedRef.current) return;
        setStatus('error');
        setStreamError('WebSocket encountered a network or protocol error.');
      };

      socket.onclose = (closeEvent: CloseEvent) => {
        if (isUnmountedRef.current) return;
        setStatus('disconnected');

        // Close codes: 4401 Unauthenticated, 4403 Cross-tenant, 4408 Policy violation
        if (closeEvent.code === 4401) {
          setStreamError('WebSocket authentication failed (4401).');
          return;
        }
        if (closeEvent.code === 4403) {
          setStreamError('Cross-tenant access refused (4403).');
          return;
        }
        if (closeEvent.code === 4408) {
          setStreamError('WebSocket policy violation (4408).');
          return;
        }

        // Bounded exponential backoff reconnect
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current),
            MAX_RECONNECT_DELAY_MS
          );
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            if (!isUnmountedRef.current) {
              connect();
            }
          }, delay);
        } else {
          setStreamError('Maximum reconnect attempts reached. Stream is unavailable.');
        }
      };
    } catch (err) {
      setStatus('error');
      setStreamError(err instanceof Error ? err.message : 'Failed to initialize WebSocket.');
    }
  }, [clearReconnectTimer, enabled, token]);

  // Connect or reset when conversation, tenant, or enabled changes
  useEffect(() => {
    isUnmountedRef.current = false;
    setMessages([]);
    setCopilotDraft(null);
    reconnectAttemptsRef.current = 0;

    connect();

    return () => {
      isUnmountedRef.current = true;
      clearReconnectTimer();
      if (socketRef.current !== null) {
        socketRef.current.onclose = null;
        socketRef.current.onerror = null;
        socketRef.current.onmessage = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [conversationId, tenantId, operatorId, enabled, connect, clearReconnectTimer]);

  const addLocalMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  }, []);

  return {
    status,
    messages,
    copilotDraft,
    streamError,
    lastEventAt,
    setCopilotDraft,
    addLocalMessage,
    updateMessage,
    reconnect: connect,
  };
}

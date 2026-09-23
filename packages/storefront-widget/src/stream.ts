const DATA_FIELD = 'data:';

export interface StreamReceipt {
  readonly task_id?: string | undefined;
  readonly conversation_id?: string | undefined;
  readonly status?: string | undefined;
  readonly correlation_id?: string | undefined;
  readonly task_version?: number | undefined;
}

export interface ParsedStreamChunk {
  readonly receipt: StreamReceipt | null;
  readonly text: string;
  readonly isDone: boolean;
  readonly statusMarker: string | null;
}

export interface StorefrontStreamRequestBody {
  readonly message: string;
  readonly idempotency_key: string;
  readonly session_id?: string;
}

export interface StorefrontEventRequestBody {
  readonly event_id: string;
  readonly event_type: string;
  readonly source: 'storefront_widget';
  readonly occurred_at: string;
  readonly session_id?: string;
  readonly payload: Record<string, unknown>;
}

export interface OutboundBridgeMessage<T = unknown> {
  readonly type: string;
  readonly payload: T;
}

/**
 * Extracts the payload of every `data:` field in one SSE chunk. Other fields
 * (`event:`, `id:`, `retry:`), comments, and blank separators are dropped.
 */
export function parseSseChunk(chunk: string): readonly string[] {
  const payloads: string[] = [];

  for (const line of chunk.split(/\r?\n/)) {
    if (!line.startsWith(DATA_FIELD)) {
      continue;
    }

    // SSE removes one optional space after the field colon.
    payloads.push(line.slice(DATA_FIELD.length).replace(/^ /, ''));
  }

  return payloads;
}

/**
 * Parses a JSON receipt string emitted as the first chunk of a storefront stream turn.
 * Returns null if the text is not a valid receipt JSON object.
 */
export function parseReceipt(text: string): StreamReceipt | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      ('task_id' in parsed || 'conversation_id' in parsed)
    ) {
      return {
        task_id: typeof parsed['task_id'] === 'string' ? parsed['task_id'] : undefined,
        conversation_id:
          typeof parsed['conversation_id'] === 'string' ? parsed['conversation_id'] : undefined,
        status: typeof parsed['status'] === 'string' ? parsed['status'] : undefined,
        correlation_id:
          typeof parsed['correlation_id'] === 'string' ? parsed['correlation_id'] : undefined,
        task_version:
          typeof parsed['task_version'] === 'number' ? parsed['task_version'] : undefined,
      };
    }
  } catch {
    // Ignore non-JSON
  }

  return null;
}

/**
 * Parses a stream chunk which may be either SSE-formatted or plain chunked text.
 * Extracts receipts, accumulated answer deltas, status/pending markers, and completion signals.
 */
export function parseStreamChunk(chunk: string): ParsedStreamChunk {
  // 1. SSE formatted chunk
  if (chunk.includes(DATA_FIELD)) {
    const payloads = parseSseChunk(chunk);
    let accumulatedText = '';
    let isDone = false;
    let receipt: StreamReceipt | null = null;
    let statusMarker: string | null = null;

    for (const payload of payloads) {
      if (payload === '[DONE]') {
        isDone = true;
        continue;
      }

      const r = parseReceipt(payload);
      if (r !== null) {
        receipt = r;
        continue;
      }

      const statusMatch = payload.match(/^\[(?:status|pending):\s*(.+)\]$/);
      if (statusMatch) {
        statusMarker = statusMatch[1]?.trim() ?? null;
        continue;
      }

      if (payload.startsWith('{') && payload.endsWith('}')) {
        try {
          const obj = JSON.parse(payload) as Record<string, unknown>;
          if (typeof obj === 'object' && obj !== null) {
            if (typeof obj['token'] === 'string') {
              accumulatedText += obj['token'];
              continue;
            }
            if (typeof obj['text'] === 'string') {
              accumulatedText += obj['text'];
              continue;
            }
            if (typeof obj['answer'] === 'string') {
              accumulatedText += obj['answer'];
              continue;
            }
          }
        } catch {
          // treat as plain text payload below
        }
      }

      accumulatedText += payload;
    }

    return { receipt, text: accumulatedText, isDone, statusMarker };
  }

  // 2. Chunked plain text stream
  const lines = chunk.split(/\r?\n/);
  let text = '';
  let receipt: StreamReceipt | null = null;
  let statusMarker: string | null = null;
  let isDone = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const r = parseReceipt(trimmed);
    if (r !== null) {
      receipt = r;
      continue;
    }

    const statusMatch = trimmed.match(/^\[(?:status|pending):\s*(.+)\]$/);
    if (statusMatch) {
      statusMarker = statusMatch[1]?.trim() ?? null;
      continue;
    }

    if (trimmed === '[DONE]') {
      isDone = true;
      continue;
    }

    text += (text ? '\n' : '') + trimmed;
  }

  return { receipt, text, isDone, statusMarker };
}

/**
 * Builds the request body for POST /api/v1/storefront/stream (R11).
 * Adheres to PostMessageRequest shape with optional session_id binding.
 */
export function buildStorefrontStreamRequestBody(
  message: string,
  idempotencyKey: string,
  sessionId?: string | null,
): StorefrontStreamRequestBody {
  return {
    message,
    idempotency_key: idempotencyKey,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/**
 * Builds the request body for POST /api/v1/storefront/events (R12).
 * Adheres to PlatformEventEnvelope shape with optional session_id binding.
 */
export function buildStorefrontEventRequestBody(
  eventName: string,
  eventData?: Record<string, unknown>,
  sessionId?: string | null,
): StorefrontEventRequestBody {
  const event_id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `evt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  return {
    event_id,
    event_type: eventName,
    source: 'storefront_widget',
    occurred_at: new Date().toISOString(),
    ...(sessionId ? { session_id: sessionId } : {}),
    payload: eventData ?? {},
  };
}

/**
 * Strict host-origin postMessage origin validation (07 §7.3, UI-TEST-007).
 * Accepts ONLY exact string match with configured host-origin.
 * Discards wildcard '*', prefixes, suffixes, port mismatches, and scheme mismatches.
 */
export function isOriginAllowed(origin: string, configuredHostOrigin: string): boolean {
  if (!origin || !configuredHostOrigin) {
    return false;
  }

  if (configuredHostOrigin === '*' || origin === '*') {
    return false;
  }

  return origin === configuredHostOrigin;
}

/**
 * Constructs an outbound bridge message for window.parent.postMessage.
 */
export function buildOutboundBridgeMessage<T>(type: string, payload: T): OutboundBridgeMessage<T> {
  return {
    type,
    payload,
  };
}

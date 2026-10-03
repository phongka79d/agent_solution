import { randomUUID } from 'node:crypto';
import {
  authorizeChatRequest,
  apiUrl,
  bearerHeaders,
  chatError,
  responseError,
} from '../../../../../lib/testing/chat-bff';
import { updateChatSession } from '../../../../../lib/testing/chat-sessions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return chatError('VALIDATION_FAILED', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return chatError('VALIDATION_FAILED', 400);
  const record = body as Record<string, unknown>;
  const chatSessionId = record.chat_session_id;
  const message = record.message;
  if (
    typeof chatSessionId !== 'string' || chatSessionId.length === 0 || chatSessionId.length > 128
    || typeof message !== 'string' || message.trim().length === 0 || message.length > 4000
    || Object.keys(record).some((key) => key !== 'chat_session_id' && key !== 'message')
  ) return chatError('VALIDATION_FAILED', 400);

  const authorization = await authorizeChatRequest(request, chatSessionId, true);
  if (authorization instanceof Response) return authorization;
  const chatSession = authorization.chatSession;
  if (!chatSession) return chatError('NOT_FOUND', 404);

  const idempotencyKey = randomUUID();
  const headers = bearerHeaders(chatSession.widgetToken, {
    accept: 'text/plain',
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    origin: chatSession.widgetOrigin,
  });
  let upstream: Response;
  try {
    upstream = await fetch(apiUrl('/storefront/stream'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: chatSession.sessionId,
        message,
        idempotency_key: idempotencyKey,
      }),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return chatError('API_UNAVAILABLE', 502);
  }
  if (!upstream.ok) return responseError(upstream, 'CHAT_TURN_FAILED');

  let stream: string;
  try {
    stream = await upstream.text();
  } catch {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  let receipt: unknown;
  try {
    const receiptLine = stream.trimStart().split(/\r?\n/, 1)[0] ?? '';
    receipt = JSON.parse(receiptLine);
  } catch {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  const receiptRecord = receipt as Record<string, unknown>;
  if (typeof receiptRecord.task_id !== 'string' || receiptRecord.task_id.length === 0
    || typeof receiptRecord.conversation_id !== 'string' || receiptRecord.conversation_id.length === 0) {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }

  updateChatSession(chatSessionId, { ...chatSession, conversationId: receiptRecord.conversation_id });
  return Response.json({ task_id: receiptRecord.task_id, conversation_id: receiptRecord.conversation_id }, {
    headers: { 'cache-control': 'no-store' },
  });
}

import {
  authorizeChatRequest,
  apiUrl,
  bearerHeaders,
  chatError,
  configuredConsoleOrigin,
  responseError,
} from '../../../../../lib/testing/chat-bff';
import { createChatSession } from '../../../../../lib/testing/chat-sessions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeChatRequest(request, undefined, true);
  if (authorization instanceof Response) return authorization;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return chatError('VALIDATION_FAILED', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return chatError('VALIDATION_FAILED', 400);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'persona' && key !== 'customer_id')) return chatError('VALIDATION_FAILED', 400);
  if (record.persona !== undefined && record.persona !== 'anonymous' && record.persona !== 'C05' && record.persona !== 'C06') {
    return chatError('VALIDATION_FAILED', 400);
  }
  const customerId = record.customer_id;
  if (
    customerId !== undefined
    && (typeof customerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId))
  ) return chatError('VALIDATION_FAILED', 400);
  if (customerId !== undefined && record.persona !== undefined) return chatError('VALIDATION_FAILED', 400);

  const origin = configuredConsoleOrigin();
  const headers = bearerHeaders(authorization.consoleSession.apiToken, {
    accept: 'application/json',
    'content-type': 'application/json',
    origin,
  });

  let upstream: Response;
  try {
    upstream = await fetch(
      customerId === undefined
        ? apiUrl('/demo/widget-session')
        : apiUrl(`/testing/customers/${encodeURIComponent(customerId)}/widget-session`),
      {
        method: 'POST',
        headers,
        body: customerId === undefined
          ? JSON.stringify(record.persona === undefined ? {} : { persona: record.persona })
          : JSON.stringify({ origin }),
        redirect: 'manual',
        cache: 'no-store',
      },
    );
  } catch {
    return chatError('API_UNAVAILABLE', 502);
  }
  if (!upstream.ok) return responseError(upstream, 'WIDGET_SESSION_FAILED');

  let issued: unknown;
  try {
    issued = await upstream.json();
  } catch {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  if (typeof issued !== 'object' || issued === null || Array.isArray(issued)) return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  const widget = issued as Record<string, unknown>;
  const exp = typeof widget.expires_at === 'string' ? Date.parse(widget.expires_at) : Number.NaN;
  if (
    typeof widget.access_token !== 'string' || widget.access_token.length === 0
    || typeof widget.session_id !== 'string' || widget.session_id.length === 0
    || !Number.isFinite(exp) || exp <= Date.now()
  ) return chatError('UPSTREAM_RESPONSE_INVALID', 502);

  const chatSessionId = createChatSession({
    widgetToken: widget.access_token,
    sessionId: widget.session_id,
    widgetOrigin: origin,
    exp,
    ownerSessionId: authorization.consoleSession.id,
  });
  return Response.json({ chat_session_id: chatSessionId, expires_at: new Date(exp).toISOString() }, {
    status: 201,
    headers: { 'cache-control': 'no-store' },
  });
}

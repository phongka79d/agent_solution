import {
  authorizeChatRequest,
  apiUrl,
  bearerHeaders,
  chatError,
  responseError,
} from '../../../../../lib/testing/chat-bff';

export const dynamic = 'force-dynamic';

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => redactSecret(item, secret));
  const record = objectRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, redactSecret(item, secret)]));
  }
  return value;
}

function projectSources(value: unknown, secret: string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((source) => {
    const record = objectRecord(source);
    if (!record) return undefined;
    return {
      ...(typeof record.source_record_id === 'string' ? { source_record_id: redactSecret(record.source_record_id, secret) } : {}),
      ...(typeof record.source_version === 'string' ? { source_version: redactSecret(record.source_version, secret) } : {}),
      ...(typeof record.source_file === 'string' ? { source_file: redactSecret(record.source_file, secret) } : {}),
    };
  }).filter((source): source is Record<string, unknown> => source !== undefined);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const chatSessionId = url.searchParams.get('chat_session_id');
  const taskId = url.searchParams.get('task_id');
  if (!chatSessionId || chatSessionId.length > 128 || !taskId || taskId.length > 256) {
    return chatError('VALIDATION_FAILED', 400);
  }

  const authorization = await authorizeChatRequest(request, chatSessionId);
  if (authorization instanceof Response) return authorization;
  const chatSession = authorization.chatSession;
  if (!chatSession) return chatError('NOT_FOUND', 404);

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(`/tasks/${encodeURIComponent(taskId)}`), {
      method: 'GET',
      headers: bearerHeaders(chatSession.widgetToken, { accept: 'application/json', origin: chatSession.widgetOrigin }),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return chatError('API_UNAVAILABLE', 502);
  }
  if (!upstream.ok) return responseError(upstream, 'TASK_LOOKUP_FAILED');

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }
  const task = objectRecord(payload);
  if (typeof task?.task_id !== 'string' || task.task_id !== taskId || typeof task.status !== 'string') {
    return chatError('UPSTREAM_RESPONSE_INVALID', 502);
  }

  let error: { code: string; class: string | null } | null = null;
  if (task.error !== null) {
    const taskError = objectRecord(task.error);
    if (typeof taskError?.code !== 'string' || !(taskError.class === null || typeof taskError.class === 'string')) {
      return chatError('UPSTREAM_RESPONSE_INVALID', 502);
    }
    error = {
      code: taskError.code.split(chatSession.widgetToken).join('[redacted]'),
      class: typeof taskError.class === 'string'
        ? taskError.class.split(chatSession.widgetToken).join('[redacted]')
        : null,
    };
  }

  return Response.json({
    task_id: task.task_id,
    status: task.status,
    ...(typeof task.answer === 'string' ? { answer: redactSecret(task.answer, chatSession.widgetToken) } : {}),
    ...(task.sources === undefined ? {} : { sources: projectSources(task.sources, chatSession.widgetToken) }),
    error,
  }, { headers: { 'cache-control': 'no-store' } });
}

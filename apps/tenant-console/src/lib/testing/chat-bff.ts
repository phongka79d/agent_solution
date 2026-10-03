import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  destroySession,
  getSessionFromRequest,
  hasCookieKey,
  isAuthEnabled,
  jsonResponse,
  mutationGuard,
  type StoredSession,
} from '../auth/session';
import {
  apiV1Url,
  demoAuthProvider,
  ExpiredProviderSessionError,
  ProviderHttpError,
} from '../auth/demo-provider';
import { getChatSession, type StoredChatSession } from './chat-sessions';

export interface AuthorizedChatRequest {
  readonly consoleSession: StoredSession;
  readonly chatSession?: StoredChatSession;
}

export type ChatAuthorization = AuthorizedChatRequest | Response;

export function chatError(errorCode: string, status: number, correlationId: string = randomUUID()): Response {
  return jsonResponse({ error_code: errorCode, correlation_id: correlationId }, status);
}

function errorFields(payload: unknown): { errorCode?: string; correlationId?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const nested = typeof record.error === 'object' && record.error !== null && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record;
  const errorCode = typeof record.error_code === 'string'
    ? record.error_code
    : typeof nested.error_code === 'string'
      ? nested.error_code
      : typeof nested.code === 'string'
        ? nested.code
        : undefined;
  const correlationId = typeof record.correlation_id === 'string' ? record.correlation_id : undefined;
  return { ...(errorCode === undefined ? {} : { errorCode }), ...(correlationId === undefined ? {} : { correlationId }) };
}

export async function upstreamError(response: Response, fallback: string): Promise<Response> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const { errorCode, correlationId } = errorFields(payload);
  return chatError(errorCode ?? fallback, response.status, correlationId);
}

export async function authorizeChatRequest(
  request: Request,
  chatSessionId?: string,
  mutation = false,
): Promise<ChatAuthorization> {
  if (!isAuthEnabled()) return chatError('AUTH_UNAVAILABLE', 404);
  if (!hasCookieKey()) return chatError('AUTH_MISCONFIGURED', 503);

  const consoleSession = await getSessionFromRequest(request);
  if (!consoleSession) return chatError('AUTHENTICATION_FAILED', 401);

  let chatSession: StoredChatSession | undefined;
  if (chatSessionId !== undefined) {
    chatSession = getChatSession(chatSessionId);
    if (!chatSession || chatSession.ownerSessionId !== consoleSession.id) return chatError('NOT_FOUND', 404);
  }

  if (mutation) {
    const guard = mutationGuard(request, consoleSession);
    if (guard) return chatError(guard.status === 403 ? 'CSRF_ORIGIN_REJECTED' : 'REQUEST_REJECTED', guard.status);
  }

  try {
    const verified = await demoAuthProvider.getSession(request);
    if (!verified) return chatError('AUTHENTICATION_FAILED', 401);
    if (!verified.permissions.includes('conversation:takeover')) return chatError('FORBIDDEN', 403);
  } catch (error) {
    if (error instanceof ExpiredProviderSessionError) {
      await destroySession(request);
      return chatError('AUTHENTICATION_FAILED', 401);
    }
    if (error instanceof ProviderHttpError) {
      if (error.status === 403) return chatError('FORBIDDEN', 403);
      return chatError('SESSION_LOOKUP_FAILED', 502);
    }
    return chatError('SESSION_LOOKUP_FAILED', 502);
  }

  return { consoleSession, ...(chatSession === undefined ? {} : { chatSession }) };
}

export function apiUrl(path: string): string {
  return apiV1Url(path);
}
export function configuredConsoleOrigin(): string {
  const configured = process.env.NEXTAUTH_URL?.trim();
  if (!configured) throw new Error('NEXTAUTH_URL is not configured');
  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NEXTAUTH_URL must use HTTP or HTTPS');
  }
  return url.origin;
}

export function bearerHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('authorization', `Bearer ${token}`);
  return headers;
}

export function responseError(response: Response, fallback: string): Promise<Response> {
  return upstreamError(response, fallback);
}

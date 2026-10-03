import { AuthProviderError, ExpiredSessionError } from '../../../../lib/auth/provider';
import { authGateResponse, createConfiguredAuthProvider } from '../../../../lib/auth/selection';
import {
  csrfCookieHeader,
  ensureCsrfCookie,
  expiredSessionCookieHeaders,
  getCookie,
  jsonResponse,
  PLATFORM_SESSION_COOKIE,
  readStoredSession,
  withSetCookies,
  type AuthEnvironment,
} from '../../../../lib/auth/session';

export const dynamic = 'force-dynamic';
function expiredResponse(request: Request): Response {
  return withSetCookies(jsonResponse({ reason: 'expired' }, 401), expiredSessionCookieHeaders(request));
}

function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof ExpiredSessionError) return expiredResponse(request);
  if (error instanceof AuthProviderError) {
    const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : undefined;
    return jsonResponse({ error: error.code }, error.status, headers);
  }
  return jsonResponse({ error: 'DEMO_UNAVAILABLE' }, 502);
}

export async function GET(request: Request): Promise<Response> {
  const env = process.env as AuthEnvironment;
  const gate = authGateResponse(env);
  if (gate) return gate;
  const provider = createConfiguredAuthProvider({ env });
  try {
    const session = await provider.getSession(request);
    if (!session) {
      const csrf = getCookie(request, 'agentos_platform_csrf');
      const hasSessionCookie = getCookie(request, PLATFORM_SESSION_COOKIE) !== null;
      const response = jsonResponse({ reason: hasSessionCookie ? 'expired' : 'unauthenticated' }, 401);
      if (hasSessionCookie) return expiredResponse(request);
      return csrf ? response : withSetCookies(response, [csrfCookieHeader(request, ensureCsrfCookie(request))]);
    }
    const stored = await readStoredSession(request, env);
    if (!stored) return expiredResponse(request);
    const currentCsrf = getCookie(request, 'agentos_platform_csrf');
    return currentCsrf === stored.session.csrfToken ? jsonResponse(session) : withSetCookies(jsonResponse(session), [csrfCookieHeader(request, stored.session.csrfToken)]);
  } catch (error) {
    return errorResponse(error, request);
  }
}

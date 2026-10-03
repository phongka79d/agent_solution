import type { AuthSession } from '@agentos/ui-foundation/auth';
import {
  appendClearedCookies,
  backendErrorPayload,
  configurationResponse,
  ensureCsrfCookie,
  getSessionFromRequest,
  hasCookieKey,
  hasExpiredSessionCookie,
  isAuthEnabled,
  jsonResponse,
  destroySession,
  unauthorizedResponse,
} from '../../../../lib/auth/session';
import {
  authProvider,
  ExpiredProviderSessionError,
  ProviderHttpError,
} from '../../../../lib/auth';
export const dynamic = 'force-dynamic';


export async function GET(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  if (!hasCookieKey()) return configurationResponse();

  const current = await getSessionFromRequest(request);
  if (!current) {
    const expired = hasExpiredSessionCookie(request);
    const response = unauthorizedResponse(expired ? 'expired' : 'unauthenticated');
    if (expired) {
      await destroySession(request);
    } else {
      await ensureCsrfCookie(response, request);
    }
    return response;
  }

  let session: AuthSession | null;
  try {
    session = await authProvider.getSession(request);
  } catch (error) {
    if (error instanceof ExpiredProviderSessionError) {
      await destroySession(request);
      const response = unauthorizedResponse('expired');
      appendClearedCookies(response, request);
      return response;
    }
    if (error instanceof ProviderHttpError) {
      if (error.status === 403) return jsonResponse(backendErrorPayload(error.payload, 'FORBIDDEN'), 403);
      return jsonResponse({ error: 'SESSION_LOOKUP_FAILED' }, 502);
    }
    return jsonResponse({ error: 'SESSION_LOOKUP_FAILED' }, 502);
  }

  if (!session) {
    const response = unauthorizedResponse('unauthenticated');
    ensureCsrfCookie(response, request);
    return response;
  }
  const response = jsonResponse(session);
  await ensureCsrfCookie(response, request, current);
  return response;
}

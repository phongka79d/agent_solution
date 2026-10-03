import {
  configurationResponse,
  getSessionFromRequest,
  hasCookieKey,
  isAuthEnabled,
  jsonResponse,
  mutationGuard,
  renewSession,
  setSessionCookies,
  unauthorizedResponse,
} from '../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

/** Sliding session renewal: extends the cookie and stored expiry for an active session. */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  if (!hasCookieKey()) return configurationResponse();

  const current = await getSessionFromRequest(request);
  const guard = mutationGuard(request, current);
  if (guard) return guard;
  if (!current) return unauthorizedResponse();

  const renewed = await renewSession(request);
  if (!renewed) return unauthorizedResponse('expired');

  const response = jsonResponse(renewed.session.authSession);
  setSessionCookies(response, request, renewed);
  return response;
}

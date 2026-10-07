import {
  appendClearedCookies,
  configurationResponse,
  destroySession,
  getSessionFromRequest,
  hasCookieKey,
  isAuthEnabled,
  jsonResponse,
  mutationGuard,
  unauthorizedResponse,
} from '../../../../lib/auth/session';
import { demoAuthProvider } from '../../../../lib/auth/demo-provider';
export const dynamic = 'force-dynamic';


function acceptsJson(request: Request): boolean {
  return request.headers.get('accept')?.toLowerCase().includes('application/json') ?? false;
}

function redirectResponse(): Response {
  return new Response(null, { status: 303, headers: { Location: '/sign-in', 'cache-control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  if (!hasCookieKey()) return configurationResponse();
  const current = await getSessionFromRequest(request);
  const guard = mutationGuard(request, current);
  if (guard) return guard;
  if (!current) {
    const response = unauthorizedResponse();
    appendClearedCookies(response, request);
    return response;
  }

  await demoAuthProvider.signOut(request);
  await destroySession(request);
  const response = acceptsJson(request) ? jsonResponse({ ok: true }) : redirectResponse();
  appendClearedCookies(response, request);
  return response;
}

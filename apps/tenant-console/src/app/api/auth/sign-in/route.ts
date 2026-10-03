import type { CreatedSession } from '../../../../lib/auth/session';
import type { SignInResult } from '../../../../lib/auth/provider';
import {
  configurationResponse,
  createSession,
  hasCookieKey,
  isAuthEnabled,
  jsonResponse,
  mutationGuard,
  setSessionCookies,
} from '../../../../lib/auth/session';
import {
  DEMO_TENANT_ID,
  authProvider,
  ProviderHttpError,
} from '../../../../lib/auth';
export const dynamic = 'force-dynamic';


function acceptsJson(request: Request): boolean {
  return request.headers.get('accept')?.toLowerCase().includes('application/json') ?? false;
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'cache-control': 'no-store' } });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function invalidRequest(request: Request, error: string, status = 400, retryAfter?: string): Response {
  if (!acceptsJson(request)) return redirectResponse('/sign-in');
  const response = jsonResponse({ error }, status);
  if (retryAfter) response.headers.set('retry-after', retryAfter);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthEnabled()) return jsonResponse({ error: 'AUTH_UNAVAILABLE' }, 404);
  if (!hasCookieKey()) return configurationResponse();
  const guard = mutationGuard(request);
  if (guard) return guard;

  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidRequest(request, 'INVALID_REQUEST');
  const record = body as Record<string, unknown>;
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  const password = typeof record.password === 'string' ? record.password : '';
  if (!email || email.length > 320 || !password || password.length > 512) {
    return invalidRequest(request, 'INVALID_CREDENTIALS');
  }

  let result: SignInResult;
  try {
    result = await authProvider.signIn(email, password);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (error.status === 401 || error.status === 403) return invalidRequest(request, 'AUTHENTICATION_FAILED', 401);
      if (error.status === 429) return invalidRequest(request, 'TOO_MANY_ATTEMPTS', 429, error.retryAfter);
      if (error.status === 400) return invalidRequest(request, 'INVALID_REQUEST', 400);
    }
    return invalidRequest(request, 'AUTH_UNAVAILABLE', 502);
  }

  if (result.session.membership.tenant_id !== DEMO_TENANT_ID || result.session.membership.scope !== 'company') {
    return invalidRequest(request, 'INVALID_LOGIN_RESPONSE', 502);
  }

  let created: CreatedSession;
  try {
    created = await createSession({ accessToken: result.accessToken, session: result.session });
  } catch {
    return invalidRequest(request, 'INVALID_LOGIN_RESPONSE', 502);
  }

  const response = acceptsJson(request)
    ? jsonResponse(result.session)
    : redirectResponse('/');
  setSessionCookies(response, request, created);
  return response;
}

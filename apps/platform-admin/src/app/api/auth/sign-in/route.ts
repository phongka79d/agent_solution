import { AuthProviderError } from '../../../../lib/auth/provider';
import { createDemoAuthProvider, demoGateResponse } from '../../../../lib/auth/demo-provider';
import {
  jsonResponse,
  mutationProtection,
  sessionCookieHeadersForResult,
  withSetCookies,
  type AuthEnvironment,
} from '../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await request.text();
    if (request.headers.get('content-type')?.toLowerCase().includes('application/json') || raw.trimStart().startsWith('{')) {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    }
    const params = new URLSearchParams(raw);
    return { email: params.get('email') ?? '', password: params.get('password') ?? '' };
  } catch {
    return null;
  }
}

function wantsJson(request: Request): boolean {
  return request.headers.get('accept')?.toLowerCase().includes('application/json') ?? false;
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthProviderError) {
    const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : undefined;
    return jsonResponse({ error: error.code }, error.status, headers);
  }
  return jsonResponse({ error: 'DEMO_UNAVAILABLE' }, 502);
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env as AuthEnvironment;
  const gate = demoGateResponse(env);
  if (gate) return gate;
  const protection = mutationProtection(request, null);
  if (protection) return protection;
  const body = await readBody(request);
  const email = typeof body?.email === 'string' ? body.email : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const provider = createDemoAuthProvider({ env });
  try {
    const result = await provider.signIn(email, password);
    const response = wantsJson(request)
      ? jsonResponse(result.session)
      : new Response(null, { status: 303, headers: { location: '/' } });
    return withSetCookies(response, sessionCookieHeadersForResult(request, {
      cookieValue: result.cookieValue,
      csrfToken: result.csrfToken,
      expiresAt: result.cookieExpiresAt,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}


import { AuthProviderError } from '../../../../lib/auth/provider';
import { createDemoAuthProvider, demoGateResponse } from '../../../../lib/auth/demo-provider';
import {
  clearSessionCookieHeaders,
  jsonResponse,
  mutationProtection,
  readStoredSession,
  withSetCookies,
  type AuthEnvironment,
} from '../../../../lib/auth/session';

export const dynamic = 'force-dynamic';

function wantsJson(request: Request): boolean {
  return request.headers.get('accept')?.toLowerCase().includes('application/json') ?? false;
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env as AuthEnvironment;
  const gate = demoGateResponse(env);
  if (gate) return gate;
  const found = await readStoredSession(request, env);
  const protection = mutationProtection(request, found?.session ?? null);
  if (protection) return protection;
  const provider = createDemoAuthProvider({ env });
  try {
    await provider.signOut(request);
  } catch (error) {
    if (error instanceof AuthProviderError && error.status === 403) {
      return withSetCookies(jsonResponse({ error: error.code }, error.status), clearSessionCookieHeaders(request));
    }
  }
  const response = wantsJson(request)
    ? jsonResponse({ ok: true })
    : new Response(null, { status: 303, headers: { location: '/sign-in' } });
  return withSetCookies(response, clearSessionCookieHeaders(request));
}

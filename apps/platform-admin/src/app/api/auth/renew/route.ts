import {
  jsonResponse,
  mutationProtection,
  readStoredSession,
  renewStoredSession,
  sessionCookieHeaders,
  withSetCookies,
  type AuthEnvironment,
} from '../../../../lib/auth/session';
import { authGateResponse } from '../../../../lib/auth/selection';

export const dynamic = 'force-dynamic';

/** Sliding session renewal for the platform console. */
export async function POST(request: Request): Promise<Response> {
  const env = process.env as AuthEnvironment;
  const gate = authGateResponse(env);
  if (gate) return gate;

  const current = await readStoredSession(request, env);
  const protection = mutationProtection(request, current?.session ?? null);
  if (protection) return protection;
  if (!current) return jsonResponse({ error: 'UNAUTHENTICATED' }, 401);

  const renewed = await renewStoredSession(request, env);
  if (!renewed) return jsonResponse({ error: 'SESSION_EXPIRED' }, 401);

  return withSetCookies(jsonResponse(renewed.session.authSession), sessionCookieHeaders(request, renewed));
}

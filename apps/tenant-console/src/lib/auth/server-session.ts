import type { AuthSession } from '@agentos/ui-foundation/auth';
import { headers } from 'next/headers';
import {
  destroySession,
  getCookie,
  getSessionFromRequest,
  TENANT_SESSION_COOKIE,
  verifySessionCookie,
  type SessionCookieReference,
} from './session';
import { authProvider, ExpiredProviderSessionError, ProviderHttpError } from './index';

/** Resolve the request-bound BFF session for a Server Component. */
export async function getServerSession(): Promise<AuthSession | null> {
  const incoming = headers();
  const cookieHeader = incoming.get('cookie');
  const request = new Request(
    'http://agentos.local/api/auth/session',
    cookieHeader ? { headers: { cookie: cookieHeader } } : {},
  );
  const rawCookie = getCookie(request, TENANT_SESSION_COOKIE);
  if (!rawCookie) return null;

  let reference: SessionCookieReference | undefined;
  try {
    reference = verifySessionCookie(rawCookie);
  } catch {
    return null;
  }
  if (!reference) return null;
  if (!(await getSessionFromRequest(request))) return null;

  try {
    return await authProvider.getSession(request);
  } catch (error) {
    if (error instanceof ExpiredProviderSessionError) {
      destroySession(request);
      return null;
    }
    if (error instanceof ProviderHttpError && error.status === 401) {
      destroySession(request);
      return null;
    }
    throw error;
  }
}

import type { AuthSession } from '@agentos/ui-foundation/auth';
import { headers } from 'next/headers';
import { createConfiguredAuthProvider } from './selection';
import {
  getCookie,
  PLATFORM_SESSION_COOKIE,
  readStoredSession,
  verifySessionCookie,
  type AuthEnvironment,
} from './session';

/** Resolve the request-bound BFF session for a Server Component. */
export async function getServerSession(): Promise<AuthSession | null> {
  try {
    const incoming = headers();
    const request = new Request('http://agentos.local/api/auth/session', { headers: incoming });
    const rawCookie = getCookie(request, PLATFORM_SESSION_COOKIE);
    if (!rawCookie) return null;
    const reference = verifySessionCookie(rawCookie, process.env as AuthEnvironment);
    if (!reference || !(await readStoredSession(request, process.env as AuthEnvironment))) return null;
    return await createConfiguredAuthProvider({ env: process.env as AuthEnvironment }).getSession(request);
  } catch {
    return null;
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  getSessionStore,
  resetSessionsForTests,
  revokeSessionsForUser,
  signSessionCookie,
  verifySessionCookie,
} from './session';

const KEY = 'tenant-cookie-key-that-is-at-least-32-bytes-long';
const authSession = {
  identity: { user_id: 'user-1', email: 'user@example.test', display_name: 'User' },
  membership: { tenant_id: '99999999-9999-4999-8999-999999999999', tenant_name: null, role: 'company' + '_admin', scope: 'company' as const },
  permissions: ['run:read' as const],
  expires_at: '2030-01-02T00:00:00.000Z',
};

beforeEach(() => {
  process.env.TENANT_COOKIE_HMAC_KEY = KEY;
  resetSessionsForTests();
  vi.useRealTimers();
});

describe('tenant v1 session cookie', () => {
  it('signs and verifies the versioned expiring cookie', () => {
    const cookie = signSessionCookie('session-1', 2_000_000_000, KEY);
    expect(cookie.startsWith('v1.session-1.2000000000.')).toBe(true);
    expect(verifySessionCookie(cookie, KEY, 1_999_999_999)).toEqual({ sessionId: 'session-1', expiresAtEpochSec: 2_000_000_000 });
  });

  it('rejects tampering, expiry, and a different key', () => {
    const cookie = signSessionCookie('session-1', 2_000_000_000, KEY);
    expect(verifySessionCookie(`${cookie}x`, KEY, 1_999_999_999)).toBeUndefined();
    expect(verifySessionCookie(cookie, KEY, 2_000_000_000)).toBeUndefined();
    expect(verifySessionCookie(cookie, `${KEY}-different`, 1_999_999_999)).toBeUndefined();
  });

  it('refuses keys shorter than 32 bytes', () => {
    expect(() => signSessionCookie('session-1', 2_000_000_000, 'too-short')).toThrow(/32 bytes/);
  });
});

describe('tenant session store', () => {
  it('sweeps expired sessions whenever a session is created', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const first = await createSession({ accessToken: 'token-1', session: authSession });
    vi.advanceTimersByTime(31 * 60 * 1000);
    const second = await createSession({ accessToken: 'token-2', session: { ...authSession, identity: { ...authSession.identity, user_id: 'user-2' } } });
    expect(await getSessionStore().get(first.session.id)).toBeUndefined();
    expect(await getSessionStore().get(second.session.id)).toBeDefined();
  });
  it('revokes the first session when the same identity signs in again at the store level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    expect(await revokeSessionsForUser(authSession.identity.user_id)).toEqual([]);
    const first = await createSession({ accessToken: 'token-1', session: authSession });

    expect(await revokeSessionsForUser(authSession.identity.user_id)).toEqual([first.session]);
    const second = await createSession({ accessToken: 'token-2', session: authSession });

    expect(first.session.id).not.toBe(second.session.id);
    expect(await getSessionStore().get(first.session.id)).toBeUndefined();
    expect(await getSessionStore().get(second.session.id)).toEqual(second.session);
  });
});

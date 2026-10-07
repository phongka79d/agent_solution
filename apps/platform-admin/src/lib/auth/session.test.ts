import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoAuthProvider } from './demo-provider';
import {
  clearSessionsForTests,
  readStoredSession,
  type AuthEnvironment,
} from './session';

const ENV: AuthEnvironment = {
  API_BASE_URL: 'http://platform.test',
  PLATFORM_COOKIE_HMAC_KEY: 'platform-cookie-signing-key-that-is-at-least-32-bytes',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function upstreamFetch(): typeof fetch {
  return (async () => jsonResponse({
    access_token: 'platform-token',
    expires_at: new Date(Date.now() + 1_800_000).toISOString(),
    identity: { user_id: 'platform-user', email: 'admin@example.test', display_name: 'Platform Admin' },
    membership: { tenant_id: 'tenant-1', tenant_name: null, role: 'platform_admin', scope: 'platform' },
    permissions: ['platform:admin'],
  })) as typeof fetch;
}

beforeEach(() => {
  clearSessionsForTests();
});

describe('platform session store lifecycle', () => {
  it('revokes the first session when the same identity signs in again', async () => {
    const provider = createDemoAuthProvider({ env: ENV, fetchImpl: upstreamFetch() });
    const first = await provider.signIn('admin@example.test', 'password');
    const second = await provider.signIn('admin@example.test', 'password');

    expect(first.cookieValue).not.toBe(second.cookieValue);
    expect(await readStoredSession(new Request('http://platform.test/api/auth/session', {
      headers: { cookie: `agentos_platform_session=${first.cookieValue}` },
    }), ENV)).toBeNull();
    expect(await readStoredSession(new Request('http://platform.test/api/auth/session', {
      headers: { cookie: `agentos_platform_session=${second.cookieValue}` },
    }), ENV)).not.toBeNull();
  });
});

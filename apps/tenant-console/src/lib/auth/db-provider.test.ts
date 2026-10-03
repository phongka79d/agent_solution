import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDbAuthProvider, dbAuthProvider } from './db-provider';
import { selectAuthProvider } from './index';
import { demoAuthProvider } from './demo-provider';

/**
 * The durable account provider must speak to `/auth/*`, not the local/CI `/demo/*` surface, and must
 * not pin the demo tenant. The fetch double captures the endpoint, which is the observable difference
 * between the two providers behind the one `AuthProvider` seam.
 */
describe('durable auth provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs in against the durable endpoint', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api.test');
    const calls: string[] = [];
    const provider = createDbAuthProvider(async (input) => {
      calls.push(typeof input === 'string' ? input : String(input));
      return new Response(JSON.stringify({ error_code: 'AUTHENTICATION_FAILED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(provider.signIn('admin@example.test', 'a password')).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('http://api.test/api/v1/auth/login');
  });

  it('keeps the non-production default and rejects unknown providers', () => {
    expect(selectAuthProvider({ AUTH_PROVIDER: 'db' })).toBe(dbAuthProvider);
    expect(selectAuthProvider({ AUTH_PROVIDER: ' demo ' })).toBe(demoAuthProvider);
    expect(selectAuthProvider({})).toBe(demoAuthProvider);
    expect(selectAuthProvider({ APP_ENV: 'local', NODE_ENV: 'production' })).toBe(demoAuthProvider);
    expect(selectAuthProvider({ APP_ENV: 'ci', NODE_ENV: 'production' })).toBe(demoAuthProvider);
    expect(() => selectAuthProvider({ AUTH_PROVIDER: 'both' })).toThrow();
  });

  it('refuses explicit and default demo auth in production', () => {
    expect(() => selectAuthProvider({ APP_ENV: 'production' })).toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    expect(() => selectAuthProvider({ APP_ENV: 'production', AUTH_PROVIDER: 'demo' }))
      .toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
  });

  it('accepts durable auth in production', () => {
    expect(selectAuthProvider({ APP_ENV: 'production', NODE_ENV: 'production', AUTH_PROVIDER: 'db' }))
      .toBe(dbAuthProvider);
  });

  it('defers production refusal until the first auth request instead of module import', async () => {
    vi.resetModules();
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('AUTH_PROVIDER', 'demo');
    try {
      // Exercise import-time configuration explicitly; a static import would run before these env values.
      const { authProvider } = await import('./index');
      const request = new Request('http://console.test/api/auth/session');
      await expect(authProvider.getSession(request)).rejects.toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
      await expect(authProvider.signIn('admin@example.test', 'a password')).rejects.toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
      await expect(authProvider.signOut(request)).rejects.toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    } finally {
      vi.resetModules();
    }
  });
});

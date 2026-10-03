import type { AuthEnvironment } from './session';
import type { DemoAuthProviderOptions } from './demo-provider';
import { jsonResponse } from './session';
import { DemoAuthProvider, demoModeEnabled } from './demo-provider';

/**
 * The durable account provider (T9.2). It is the same proxy/session machinery as the demo provider —
 * only the API account routes differ — but it carries no demo gate: with `AUTH_PROVIDER=db` the
 * platform console authenticates against `/auth/*`, where credentials are verified by the database
 * and the platform permission bundle comes from the signed-in membership.
 */

/** The account routes of the durable API, as opposed to the local/CI `/demo/*` surface. */
export const DB_AUTH_PATHS = {
  loginPath: '/auth/login',
  sessionPath: '/auth/session',
  logoutPath: '/auth/logout',
} as const;

export class DatabaseAuthProvider extends DemoAuthProvider {
  constructor(options: DemoAuthProviderOptions = {}) {
    super({ ...options, ...DB_AUTH_PATHS });
  }
}

export function createDbAuthProvider(options: DemoAuthProviderOptions = {}): DatabaseAuthProvider {
  return new DatabaseAuthProvider(options);
}

/** APP_ENV controls the deployment profile; NODE_ENV=production also describes local Next builds. */
export function authProviderSelection(env: AuthEnvironment = process.env): 'db' | 'demo' {
  const selected = (env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  if (selected !== 'db' && selected !== 'demo') {
    throw new Error('AUTH_PROVIDER: accepted values are `db` and `demo`');
  }
  if (env.APP_ENV === 'production' && selected !== 'db') {
    throw new Error('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB: production requires AUTH_PROVIDER=db');
  }
  return selected;
}

/**
 * The BFF gate for the auth routes. The demo surface answers 404 outside local/CI DEMO mode; the
 * durable surface is a production route and is served whenever it is selected.
 */
export function authGateResponse(env: AuthEnvironment = process.env): Response | null {
  const selected = authProviderSelection(env);
  return selected === 'db' || demoModeEnabled(env) ? null : jsonResponse({ error: 'NOT_FOUND' }, 404);
}

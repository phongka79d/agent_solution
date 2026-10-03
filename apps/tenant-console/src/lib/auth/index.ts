import type { AuthProvider } from './provider';
import { dbAuthProvider } from './db-provider';
import { demoAuthProvider } from './demo-provider';

export { DEMO_TENANT_ID, ExpiredProviderSessionError, ProviderHttpError, apiV1Url, isValidLoginEmail } from './demo-provider';
export { createDbAuthProvider, dbAuthProvider } from './db-provider';
export { createDemoAuthProvider, demoAuthProvider } from './demo-provider';
export type { AuthProvider, SignInResult } from './provider';

/**
 * The console's account store, chosen by `AUTH_PROVIDER` (T9.2).
 *
 * `demo` keeps the local/CI in-memory store; APP_ENV=production requires durable database identity.
 * NODE_ENV describes Next's build/runtime mode, not the deployment profile. The configured provider
 * is selected lazily on the first auth request, then retained for every request in that process.
 */
export function selectAuthProvider(env: Readonly<Record<string, string | undefined>>): AuthProvider {
  const selected = (env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  if (selected !== 'db' && selected !== 'demo') {
    throw new Error('AUTH_PROVIDER: accepted values are `db` and `demo`');
  }
  if (env.APP_ENV === 'production' && selected !== 'db') {
    throw new Error('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB: production requires AUTH_PROVIDER=db');
  }
  return selected === 'db' ? dbAuthProvider : demoAuthProvider;
}

let configuredProvider: AuthProvider | undefined;

export const authProvider: AuthProvider = {
  async signIn(email, password) {
    configuredProvider ??= selectAuthProvider(process.env);
    return configuredProvider.signIn(email, password);
  },
  async getSession(request) {
    configuredProvider ??= selectAuthProvider(process.env);
    return configuredProvider.getSession(request);
  },
  async signOut(request) {
    configuredProvider ??= selectAuthProvider(process.env);
    await configuredProvider.signOut(request);
  },
};

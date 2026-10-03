import type { AuthEnvironment } from './session';
import { authGateResponse, authProviderSelection, createDbAuthProvider } from './db-provider';
import {
  DemoAuthProvider,
  createDemoAuthProvider,
  proxyPlatformApi as proxyPlatformApiWith,
  type DemoAuthProviderOptions,
} from './demo-provider';

export { authGateResponse, authProviderSelection } from './db-provider';

type FetchLike = typeof fetch;

/**
 * The platform console's account store, chosen by `AUTH_PROVIDER` (T9.2).
 *
 * `demo` keeps the local/CI in-memory store; `db` uses durable database identity. The choice is made
 * here, once, so every auth route and the BFF proxy read the same store for a given environment.
 */
export function createConfiguredAuthProvider(options: DemoAuthProviderOptions = {}): DemoAuthProvider {
  const env = options.env ?? process.env;
  return authProviderSelection(env) === 'db' ? createDbAuthProvider(options) : createDemoAuthProvider(options);
}

/** `proxyPlatformApi` bound to the selected account store and its gate. */
export async function proxyPlatformApi(
  request: Request,
  rawPath: string,
  env: AuthEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return proxyPlatformApiWith(
    request,
    rawPath,
    env,
    fetchImpl,
    createConfiguredAuthProvider({ env, fetchImpl }),
    authGateResponse(env),
  );
}

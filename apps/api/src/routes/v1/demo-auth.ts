import type { FastifyInstance } from 'fastify';

import { GatewayFailureError, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import {
  type DemoAudience,
  type DemoCredentialStore,
  type DemoSession,
} from '../../runtime/demo-auth.js';

export interface DemoAuthRouteDependencies {
  readonly demoAuth: DemoCredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bearerToken(request: { readonly headers: Record<string, string | string[] | undefined> }): string | null {
  const value = request.headers.authorization;
  const authorization = Array.isArray(value) ? null : value;
  if (authorization === undefined || authorization === null) return null;
  const separator = authorization.indexOf(' ');
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== 'bearer') return null;
  const token = authorization.slice(separator + 1).trim();
  return token.length > 0 ? token : null;
}

function requireDemoSession(
  request: { readonly headers: Record<string, string | string[] | undefined> },
  deps: DemoAuthRouteDependencies,
) {
  const token = bearerToken(request);
  const session = token === null ? null : deps.demoAuth.resolveDemoSession(token);
  if (session === null) {
    fail('AUTHENTICATION_FAILED', 'the demo session is missing, expired, revoked, or invalid');
  }
  return { token: token as string, session };
}

function parseLoginBody(body: unknown): { readonly email: string; readonly password: string; readonly audience: DemoAudience } {
  if (!isPlainRecord(body)) {
    fail('VALIDATION_FAILED', 'the request body must contain an email, password, and audience');
  }
  const email = body.email;
  const password = body.password;
  const audience = body.audience;
  if (typeof email !== 'string' || email.trim().length === 0) {
    fail('VALIDATION_FAILED', 'email is required');
  }
  if (typeof password !== 'string' || password.length === 0) {
    fail('VALIDATION_FAILED', 'password is required');
  }
  if (audience !== 'company' && audience !== 'platform') {
    fail('VALIDATION_FAILED', 'audience must be company or platform');
  }
  return { email, password, audience };
}

function sessionWithoutToken(session: DemoSession) {
  return {
    expires_at: session.expires_at,
    identity: session.identity,
    membership: session.membership,
    permissions: session.permissions,
  };
}

/** Registers local/CI-only account login, session inspection, and revocation. */
export function registerDemoAuthRoutes(
  app: FastifyInstance,
  deps: DemoAuthRouteDependencies,
): void {
  app.post('/demo/login', async (request, reply) => {
    try {
      const { email, password, audience } = parseLoginBody(request.body);
      const session = deps.demoAuth.login(email, password, audience, request.ip);
      if (session === null) {
        const retryAfter = deps.demoAuth.retryAfter(email, request.ip);
        if (retryAfter !== null) {
          fail('TOO_MANY_ATTEMPTS', 'too many authentication attempts', { retry_after: retryAfter });
        }
        fail('AUTHENTICATION_FAILED', 'the demo credentials were not accepted');
      }
      return reply.code(200).send(session);
    } catch (error) {
      if (error instanceof GatewayFailureError && error.failure.error_code === 'TOO_MANY_ATTEMPTS') {
        const retryAfter = error.failure.details?.retry_after;
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
          reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
        }
      }
      return replyFailure(reply, error, 'demo-login');
    }
  });

  app.get('/demo/session', { preHandler: authenticate({ credentials: deps.demoAuth, runtime: deps.runtime }) }, async (request, reply) => {
    try {
      const { session } = requireDemoSession(request, deps);
      requireOperator(request);
      return reply.code(200).send(sessionWithoutToken(session));
    } catch (error) {
      return replyFailure(reply, error, 'demo-session');
    }
  });

  app.post('/demo/logout', { preHandler: authenticate({ credentials: deps.demoAuth, runtime: deps.runtime }) }, async (request, reply) => {
    try {
      const { token } = requireDemoSession(request, deps);
      requireOperator(request);
      deps.demoAuth.revoke(token);
      return reply.code(200).send({ revoked: true });
    } catch (error) {
      return replyFailure(reply, error, 'demo-logout');
    }
  });
}

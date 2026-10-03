import type { FastifyInstance } from 'fastify';

import { GatewayFailureError, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { MINIMUM_AUTH_PASSWORD_LENGTH, type AuthAudience, type DatabaseAuthStore } from '../../runtime/db-auth.js';

export interface AuthRouteDependencies {
  readonly auth: DatabaseAuthStore;
  readonly runtime: GatewayRuntime;
}

const MAXIMUM_EMAIL_LENGTH = 320;
const MAXIMUM_PASSWORD_LENGTH = 512;

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

interface ParsedLogin {
  readonly email: string;
  readonly password: string;
  readonly audience: AuthAudience;
  readonly tenant_id: string | undefined;
}

/**
 * Reads the sign-in attempt as a shape, never as an identity: anything malformed is refused as an
 * ordinary authentication failure with the same message a wrong password receives.
 */
function parseLoginBody(body: unknown): ParsedLogin {
  if (!isPlainRecord(body)) {
    fail('VALIDATION_FAILED', 'a sign-in attempt requires an email and a password');
  }
  const email = body.email;
  const password = body.password;
  const audience = body.audience ?? 'company';
  const tenant_id = body.tenant_id;
  if (
    typeof email !== 'string' || email.trim().length === 0 || email.length > MAXIMUM_EMAIL_LENGTH ||
    typeof password !== 'string' || password.length === 0 || password.length > MAXIMUM_PASSWORD_LENGTH ||
    (audience !== 'company' && audience !== 'platform') ||
    (tenant_id !== undefined && (typeof tenant_id !== 'string' || tenant_id.trim().length === 0))
  ) {
    fail('VALIDATION_FAILED', 'a sign-in attempt requires an email and a password');
  }
  return {
    email: email.trim(),
    password,
    audience,
    tenant_id: tenant_id === undefined ? undefined : tenant_id.trim(),
  };
}

function parsePasswordBody(body: unknown): { readonly current_password: string; readonly new_password: string } {
  if (!isPlainRecord(body)) {
    fail('VALIDATION_FAILED', 'a password change requires the current and the new password');
  }
  const current_password = body.current_password;
  const new_password = body.new_password;
  if (
    typeof current_password !== 'string' || current_password.length === 0 ||
    typeof new_password !== 'string' ||
    new_password.length < MINIMUM_AUTH_PASSWORD_LENGTH || new_password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    fail('VALIDATION_FAILED', 'a password change requires the current and the new password');
  }
  return { current_password, new_password };
}

/**
 * Durable account authentication for both consoles (T9.2, workflow §3).
 *
 * Sign-in is the one route group that cannot be authenticated first, so it is registered with the
 * gateway's own credentials for its other three routes and exposes only opaque refusals: an unknown
 * email, a wrong password and a non-member all read as the same `AUTHENTICATION_FAILED`, and the
 * per-IP+email limit answers `TOO_MANY_ATTEMPTS` with a `retry-after` before any lookup happens.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDependencies): void {
  const guarded = { preHandler: authenticate({ credentials: deps.auth, runtime: deps.runtime }) };

  app.post('/auth/login', async (request, reply) => {
    try {
      const parsed = parseLoginBody(request.body);
      const result = await deps.auth.login({
        email: parsed.email,
        password: parsed.password,
        audience: parsed.audience,
        ...(parsed.tenant_id === undefined ? {} : { tenant_id: parsed.tenant_id }),
        client_ip: request.ip,
      });
      if (result.ok) return reply.code(200).send(result.session);
      if (result.reason === 'TOO_MANY_ATTEMPTS') {
        if (result.retry_after !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(result.retry_after))));
        fail('TOO_MANY_ATTEMPTS', 'too many authentication attempts', {
          ...(result.retry_after === undefined ? {} : { retry_after: result.retry_after }),
        });
      }
      fail('AUTHENTICATION_FAILED', 'the credentials were not accepted');
    } catch (error) {
      if (error instanceof GatewayFailureError && error.failure.error_code === 'TOO_MANY_ATTEMPTS') {
        const retryAfter = error.failure.details?.retry_after;
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
          reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
        }
      }
      return replyFailure(reply, error, 'auth-login');
    }
  });

  app.get('/auth/session', guarded, async (request, reply) => {
    try {
      requireOperator(request);
      const token = bearerToken(request);
      const session = token === null ? null : await deps.auth.inspect(token);
      if (session === null) fail('AUTHENTICATION_FAILED', 'the session is no longer valid');
      return reply.code(200).send(session);
    } catch (error) {
      return replyFailure(reply, error, 'auth-session');
    }
  });

  app.post('/auth/logout', guarded, async (request, reply) => {
    try {
      requireOperator(request);
      const token = bearerToken(request);
      const revoked = token === null ? false : await deps.auth.logout(token);
      return reply.code(200).send({ revoked });
    } catch (error) {
      return replyFailure(reply, error, 'auth-logout');
    }
  });

  app.post('/auth/password', guarded, async (request, reply) => {
    try {
      requireOperator(request);
      const token = bearerToken(request);
      const { current_password, new_password } = parsePasswordBody(request.body);
      const changed = token === null ? false : await deps.auth.changePassword(token, current_password, new_password);
      // A refused change reads exactly like a refused sign-in: nothing about the account leaks.
      if (!changed) fail('AUTHENTICATION_FAILED', 'the current password was not accepted');
      return reply.code(200).send({ changed: true });
    } catch (error) {
      return replyFailure(reply, error, 'auth-password');
    }
  });
}

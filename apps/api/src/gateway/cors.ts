/**
 * @file Browser-origin policy for the demo storefront (`06` §8.0, implement/09 §2).
 *
 * The widget is embedded on an approved tenant-console origin and carries only its own scoped
 * widget credential, so the gateway must answer that one cross-origin caller. The policy is
 * deliberately narrow: an exact origin allowlist from configuration, no wildcard, no credentials
 * (the widget presents a bearer token instead of cookies), and no CORS headers at all for an
 * origin that is not listed — an unlisted caller gets the plain refusal, not a browser exemption.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

/** Headers a browser caller may send: the widget's bearer plus correlation/idempotency metadata. */
const ALLOWED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'x-correlation-id',
  'x-idempotency-key',
  'x-csrf-token',
  'x-request-id',
] as const;

/** Response headers the browser surface is allowed to read. */
const ALLOWED_RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'retry-after',
  'x-correlation-id',
] as const;

const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';

/** The same scoped headers are used by Fastify replies and raw hijacked responses. */
export function corsHeadersForOrigin(
  origin: string | undefined,
  allowed: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (origin === undefined || !isAllowedOrigin(origin, allowed)) return undefined;
  return {
    'access-control-allow-origin': origin,
    vary: 'origin',
    'access-control-allow-headers': ALLOWED_REQUEST_HEADERS.join(','),
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-expose-headers': ALLOWED_RESPONSE_HEADERS.join(','),
    'access-control-max-age': '600',
  };
}

function applyCorsHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
    // Hijacked handlers write directly to raw, bypassing Fastify's normal response finaliser.
    reply.raw.setHeader(name, value);
  }
}

/** Parses the configured allowlist; a blank configuration allows no origin. */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== '*');
}

/** True when the presented origin is exactly one of the configured browser origins. */
export function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  if (!/^https?:\/\/[^/?#]+$/.test(origin)) return false;
  return allowed.includes(origin);
}

/**
 * Installs the browser-origin hook.
 *
 * @param app The Fastify instance the gateway is assembled on.
 * @param rawAllowlist The comma-separated `CORS_ALLOWED_ORIGINS` value.
 */
export function installCors(app: FastifyInstance, rawAllowlist: string | undefined): void {
  const allowed = parseAllowedOrigins(rawAllowlist);
  if (allowed.length === 0) return;

  app.addHook('onRequest', async (request, reply) => {
    const headers = corsHeadersForOrigin(request.headers.origin, allowed);
    if (headers === undefined) return;

    applyCorsHeaders(reply, headers);

    // A preflight never reaches a route: it asks only whether the real request may be sent.
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined) {
      await reply.code(204).send();
    }
  });
}

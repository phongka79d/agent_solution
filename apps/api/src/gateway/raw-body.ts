/**
 * @file Raw-body preservation for signature verification (implement/06 §4.1, §9.3).
 *
 * A webhook signature is computed over the exact bytes the provider sent. Fastify's default JSON
 * parser discards them, and a re-serialized payload — different key order, different whitespace,
 * different number formatting — never produces the same digest. This module installs a
 * content-type parser that keeps the raw string on the request and still hands the handler a
 * parsed body, so `POST /api/v1/events` verifies the bytes that actually arrived.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { fail } from './http.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Verbatim request body as received. Absent when no parser ran (for example a bodyless GET),
     * which a verification path must treat as a refusal rather than as an empty signature input.
     */
    rawBody?: string;
  }
}

/** The JSON content types the platform accepts. */
const JSON_CONTENT_TYPES: readonly string[] = ['application/json', 'application/*+json'];

/** Largest body this gateway will buffer for verification; oversized requests fail closed. */
export const MAX_RAW_BODY_BYTES = 1_048_576;

/** Reads the preserved raw body, refusing when the parser did not capture one. */
export function requireRawBody(request: FastifyRequest): string {
  const raw = request.rawBody;
  if (typeof raw !== 'string') {
    fail(
      'SIGNATURE_INVALID',
      'the raw request body is unavailable, so no signature can be verified over the delivered bytes',
    );
  }
  return raw;
}

/**
 * Installs the preserving parser. It is registered by the composition root, never by a route, so
 * every group that needs raw bytes shares one parser and one refusals shape.
 *
 * @param app The Fastify instance to extend.
 */
export function installRawBodyPreservation(app: FastifyInstance): void {
  for (const contentType of JSON_CONTENT_TYPES) {
    app.addContentTypeParser<string>(contentType, { parseAs: 'string' }, (request, body, done) => {
      const raw = String(body);

      if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_BODY_BYTES) {
        done(new Error('RAW_BODY_TOO_LARGE'));
        return;
      }

      request.rawBody = raw;

      // An empty body is a well-formed, empty JSON document only for routes that expect none; a
      // route that needs content rejects it itself with its own vocabulary.
      if (raw.trim().length === 0) {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        done(new Error('INVALID_JSON'));
      }
    });
  }

  // Any other content type keeps its bytes too, so a signature over a non-JSON delivery can still
  // be verified. The handler receives the raw string and decides.
  app.addContentTypeParser<string>('*', { parseAs: 'string' }, (request, body, done) => {
    const raw = String(body);

    if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_BODY_BYTES) {
      done(new Error('RAW_BODY_TOO_LARGE'));
      return;
    }

    request.rawBody = raw;
    done(null, raw);
  });
}

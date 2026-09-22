import { describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MAX_RAW_BODY_BYTES } from './gateway/raw-body.js';
import { createCredentialStore } from './gateway/principal.js';
import { createGatewayComposition } from './runtime/composition.js';
import { buildServer, DEPENDENCIES } from './server.js';

/** One tenant's operator, so a route can be reached past authentication. */
const OPERATOR_TOKEN = 'operator-token-value';
const TENANT = 'tenant-a';

/**
 * Builds the deployed surface over an empty credential store, or over one known operator.
 *
 * @param with_operator Whether to trust {@link OPERATOR_TOKEN} for {@link TENANT}.
 * @returns A server that answers `/health`, `/api/v1` and the R10 socket handshake.
 */
function buildTestServer(with_operator: boolean): FastifyInstance {
  return buildServer(
    createGatewayComposition(
      { SESSION_SECRET: 'test-session-secret-000000', PLATFORM_SECRET: 'test-platform-secret-00000' },
      {
        credentials: createCredentialStore({
          operators: with_operator
            ? [{ token: OPERATOR_TOKEN, tenant_id: TENANT, operator_id: 'op-1', permissions: [] }]
            : [],
          sessions: [],
          widgets: [],
        }),
      },
    ),
  );
}

describe('GET /health', () => {
  it('reports the api service as ok without touching a dependency', async () => {
    const app = buildTestServer(false);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'api',
      dependencies: [...DEPENDENCIES],
    });

    await app.close();
  });
});

describe('the /api/v1 surface', () => {
  it('mounts every group under the canonical prefix and authenticates before any handler', async () => {
    const app = buildTestServer(true);

    // An unauthenticated delivery to a canonical path reaches the credential check, not a handler:
    // the refusal is the gateway's own vocabulary and no port is consulted.
    const guarded = await app.inject({ method: 'POST', url: '/api/v1/events', payload: {} });
    expect(guarded.statusCode).toBe(401);
    expect(guarded.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED', retryable: false });

    // The same route is not served outside the prefix, so a caller cannot reach an unprefixed
    // variant of the contract.
    const unprefixed = await app.inject({ method: 'POST', url: '/events', payload: {} });
    expect(unprefixed.statusCode).toBe(404);

    // R04 verifies a signature over the bytes the caller sent, so the server installs the
    // preserving parser: an oversized delivery is refused by that boundary, in the gateway's own
    // vocabulary, and never reaches a handler that would sign over a body it never saw.
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ filler: 'x'.repeat(MAX_RAW_BODY_BYTES + 1) }),
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({
      error_code: 'VALIDATION_FAILED',
      details: { reason: 'RAW_BODY_TOO_LARGE' },
    });

    await app.close();
  });
});

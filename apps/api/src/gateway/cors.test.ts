import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { installCors, isAllowedOrigin, parseAllowedOrigins } from './cors.js';

const ORIGIN = 'http://localhost:3000';
const OTHER = 'http://localhost:3001';

function buildApp(rawAllowlist: string | undefined) {
  const app = Fastify({ logger: false });
  installCors(app, rawAllowlist);
  app.get('/api/v1/tasks/task-1', async () => ({ ok: true }));
  app.post('/api/v1/storefront/stream', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
    });
    reply.raw.end('stream');
  });
  return app;
}

describe('browser origin policy', () => {
  it('parses an exact allowlist and ignores wildcards', () => {
    expect(parseAllowedOrigins(' http://localhost:3000 ,http://localhost:3001,,*')).toEqual([
      ORIGIN,
      OTHER,
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(isAllowedOrigin('http://localhost:3000', [ORIGIN])).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000.evil.test', [ORIGIN])).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000/path', [ORIGIN])).toBe(false);
  });

  it('answers a preflight from an allowed origin with the scoped header set', async () => {
    const app = buildApp(ORIGIN);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/storefront/stream',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-max-age']).toBe('600');

    await app.close();
  });

  it('keeps the scoped origin header on a hijacked raw response', async () => {
    const app = buildApp(ORIGIN);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/stream',
      headers: { origin: ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('stream');
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-origin']).not.toBe('*');

    await app.close();
  });

  it('adds no origin header to a hijacked raw response from an unlisted origin', async () => {
    const app = buildApp(ORIGIN);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/storefront/stream',
      headers: { origin: 'https://attacker.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('adds no browser exemption for an unlisted origin and no wildcard for a listed one', async () => {
    const app = buildApp(ORIGIN);

    const unlisted = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/task-1',
      headers: { origin: 'https://attacker.test' },
    });
    expect(unlisted.statusCode).toBe(200);
    expect(unlisted.headers['access-control-allow-origin']).toBeUndefined();

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/task-1',
      headers: { origin: ORIGIN },
    });
    expect(listed.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(listed.headers['access-control-allow-origin']).not.toBe('*');

    await app.close();
  });

  it('installs no hook at all when the allowlist is empty', async () => {
    const app = buildApp(undefined);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/task-1',
      headers: { origin: ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });
});

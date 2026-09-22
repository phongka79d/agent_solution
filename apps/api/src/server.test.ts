import { describe, expect, it } from 'vitest';

import { buildServer, DEPENDENCIES } from './server.js';

describe('GET /health', () => {
  it('reports the api service as ok without touching a dependency', async () => {
    const app = buildServer();

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

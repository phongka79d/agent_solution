import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, platformJson } from './platform-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('platformJson', () => {
  it('preserves typed API error status and correlation fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error_code: 'UPSTREAM_UNAVAILABLE',
      message: 'The usage service is unavailable.',
      correlation_id: 'platform-correlation-42',
    }), { status: 503 })));

    let caught: unknown;
    try {
      await platformJson('platform/usage');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 503,
      error_code: 'UPSTREAM_UNAVAILABLE',
      correlation_id: 'platform-correlation-42',
    });
  });
});

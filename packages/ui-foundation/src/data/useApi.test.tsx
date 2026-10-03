// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../http-client.js';
import { useApi } from './useApi.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('useApi', () => {
  it('loads JSON and records the ETag for later revalidation', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ value: 7 }, 200, { etag: 'W/"v1"' }));
    const { result } = renderHook(() => useApi<{ value: number }>('/api/v1/things', { fetcher }));

    await waitFor(() => expect(result.current.data).toEqual({ value: 7 }));
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps cached data when the server answers 304', async () => {
    let call = 0;
    let lastInit: RequestInit = {};
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      lastInit = init;
      call += 1;
      return call === 1 ? jsonResponse({ value: 1 }, 200, { etag: 'W/"v1"' }) : new Response(null, { status: 304 });
    });
    const { result } = renderHook(() => useApi<{ value: number }>('/api/v1/things', { fetcher }));

    await waitFor(() => expect(result.current.data).toEqual({ value: 1 }));
    result.current.refresh();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(result.current.data).toEqual({ value: 1 });
    expect(new Headers(lastInit.headers).get('If-None-Match')).toBe('W/"v1"');
  });

  it('retries a retryable failure and then surfaces success', async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw new ApiError(503, {
          error_code: 'PROVIDER_UNAVAILABLE',
          message: 'down',
          retryable: true,
          correlation_id: 'c',
        });
      }
      return jsonResponse({ ok: true });
    });
    const { result } = renderHook(() =>
      useApi<{ ok: boolean }>('/api/v1/things', { fetcher, retry: { attempts: 1, baseDelayMs: 1 } }),
    );

    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry an UNKNOWN effect', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError(500, {
        error_code: 'EFFECT_UNKNOWN',
        message: 'indeterminate',
        retryable: true,
        correlation_id: 'c',
      });
    });
    const { result } = renderHook(() =>
      useApi('/api/v1/things', { fetcher, retry: { attempts: 3, baseDelayMs: 1 } }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.code).toBe('EFFECT_UNKNOWN');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a 401 to the unauthorized handler instead of retrying', async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () => jsonResponse({ error_code: 'SESSION_EXPIRED' }, 401));
    const { result } = renderHook(() =>
      useApi('/api/v1/things', { fetcher, onUnauthorized, retry: { attempts: 2, baseDelayMs: 1 } }),
    );

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(result.current.error?.code).toBe('SESSION_EXPIRED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stays idle when the url is null', () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() => useApi('/api/v1/things', { enabled: false, fetcher }));
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

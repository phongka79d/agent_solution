import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, DEFAULT_TIMEOUT_MS, HttpClient, apiOrigin, buildApiUrl, buildQueryString } from './http-client.js';
import type { ApiErrorEnvelope } from './types/common.js';
afterEach(() => {
  vi.useRealTimers();
});


function createMockJsonResponse<T>(data: T, status = 200, headersInit: Record<string, string> = {}): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...headersInit,
  });

  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    headers,
  });
}

/**
 * Creates a captured fetch spy that records the last invocation and returns the supplied response.
 */
function createFetchSpy(mockResponse: Response) {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedUrl = typeof input === 'string' ? input : input.toString();
    capturedInit = init;
    return mockResponse;
  };

  return {
    mockFetch,
    getLastUrl: () => capturedUrl,
    getLastInit: () => capturedInit,
    getHeaders: () => (capturedInit?.headers ? (capturedInit.headers as Record<string, string>) : {}),
    getBodyJson: <T = unknown>() => (capturedInit?.body ? (JSON.parse(capturedInit.body as string) as T) : undefined),
  };
}

describe('buildApiUrl & URL Construction Contract', () => {
  it('strictly emits /api/v1 exactly once when baseUrl lacks /api/v1', () => {
    const url = buildApiUrl('/approvals', undefined, 'http://localhost:4000');
    expect(url).toBe('http://localhost:4000/api/v1/approvals');
  });

  it('strictly emits /api/v1 exactly once when baseUrl already has /api/v1', () => {
    const url = buildApiUrl('/approvals', undefined, 'http://localhost:4000/api/v1');
    expect(url).toBe('http://localhost:4000/api/v1/approvals');
  });

  it('handles baseUrl with trailing slashes without double slashes', () => {
    const url = buildApiUrl('approvals', undefined, 'http://localhost:4000/api/v1/');
    expect(url).toBe('http://localhost:4000/api/v1/approvals');
  });

  it('strips redundant /api/v1 prefix from endpoint', () => {
    const url1 = buildApiUrl('/api/v1/runs', undefined, 'http://localhost:4000');
    const url2 = buildApiUrl('api/v1/runs', undefined, 'http://localhost:4000/api/v1');
    expect(url1).toBe('http://localhost:4000/api/v1/runs');
    expect(url2).toBe('http://localhost:4000/api/v1/runs');
  });

  it('handles root or empty endpoint safely', () => {
    const url1 = buildApiUrl('', undefined, 'http://localhost:4000');
    const url2 = buildApiUrl('/', undefined, 'http://localhost:4000');
    const url3 = buildApiUrl('/api/v1', undefined, 'http://localhost:4000');
    expect(url1).toBe('http://localhost:4000/api/v1');
    expect(url2).toBe('http://localhost:4000/api/v1');
    expect(url3).toBe('http://localhost:4000/api/v1');
  });
});

describe('buildQueryString & Query Encoding Contract', () => {
  it('omits undefined and null parameters', () => {
    const query = buildQueryString({
      status: 'PENDING',
      cursor: undefined,
      limit: null,
      offset: 0,
    });
    expect(query).toBe('status=PENDING&offset=0');
  });

  it('encodes boolean and number values correctly', () => {
    const query = buildQueryString({
      active: true,
      count: 42,
      zero: 0,
      disabled: false,
    });
    expect(query).toBe('active=true&count=42&zero=0&disabled=false');
  });

  it('repeats keys for array parameters per wire convention', () => {
    const query = buildQueryString({
      status: ['PENDING', 'REJECTED'],
      tag: ['critical', 'urgent'],
    });
    expect(query).toBe('status=PENDING&status=REJECTED&tag=critical&tag=urgent');
  });

  it('properly encodes special characters, spaces, and punctuation in values', () => {
    const query = buildQueryString({
      filter: 'name eq "Alice & Bob"',
      timezone: 'Asia/Taipei',
    });
    expect(query).toBe('filter=name+eq+%22Alice+%26+Bob%22&timezone=Asia%2FTaipei');
  });

  it('returns empty string when record is empty or all values are omitted', () => {
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString({ a: undefined, b: null })).toBe('');
    expect(buildQueryString(undefined)).toBe('');
  });
});

describe('Tenant & Operator Header Injection Contract', () => {
  it('injects client-level tenantId and operatorId as headers', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ ok: true }));
    const client = new HttpClient({
      baseUrl: 'http://localhost:4000',
      tenantId: 'tenant-acme',
      operatorId: 'operator-alice',
      fetch: spy.mockFetch,
    });

    await client.request('/test');

    const headers = spy.getHeaders();
    expect(headers['x-tenant-id']).toBe('tenant-acme');
    expect(headers['x-operator-id']).toBe('operator-alice');
    expect(headers['Accept']).toBe('application/json');
  });

  it('allows request-level options to override client-level tenant and operator', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ ok: true }));
    const client = new HttpClient({
      baseUrl: 'http://localhost:4000',
      tenantId: 'tenant-default',
      operatorId: 'operator-default',
      fetch: spy.mockFetch,
    });

    await client.request('/test', { method: 'GET' }, undefined, {
      tenantId: 'tenant-override',
      operatorId: 'operator-override',
      headers: { 'X-Custom-Trace': 'trace-123' },
    });

    const headers = spy.getHeaders();
    expect(headers['x-tenant-id']).toBe('tenant-override');
    expect(headers['x-operator-id']).toBe('operator-override');
    expect(headers['X-Custom-Trace']).toBe('trace-123');
  });

  it('automatically sets Content-Type: application/json when body is provided', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ ok: true }));
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.request('/test', {
      method: 'POST',
      body: JSON.stringify({ key: 'val' }),
    });

    const headers = spy.getHeaders();
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('Standardized Error Envelope Contract', () => {
  it('unwraps JSON ApiErrorEnvelope on non-2xx status codes', async () => {
    const errorEnvelope: ApiErrorEnvelope = {
      error_code: 'VERSION_CONFLICT',
      message: 'Decision payload hash mismatch; approval was modified concurrently',
      retryable: false,
      correlation_id: 'corr-err-409',
      details: { expected: 'hashA', actual: 'hashB' },
    };

    const spy = createFetchSpy(createMockJsonResponse(errorEnvelope, 409));
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await expect(client.request('/test')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.errorCode).toBe('VERSION_CONFLICT');
      expect(apiErr.message).toBe('Decision payload hash mismatch; approval was modified concurrently');
      expect(apiErr.retryable).toBe(false);
      expect(apiErr.correlationId).toBe('corr-err-409');
      expect(apiErr.details).toEqual({ expected: 'hashA', actual: 'hashB' });
      return true;
    });
  });

  it('falls back to x-correlation-id header when body correlation_id is omitted', async () => {
    const errorEnvelope = {
      error_code: 'PERMISSION_DENIED',
      message: 'Operator lacks human-in-the-loop signoff authority',
      retryable: false,
    };

    const spy = createFetchSpy(
      createMockJsonResponse(errorEnvelope, 403, { 'x-correlation-id': 'header-corr-123' })
    );
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await expect(client.request('/test')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.errorCode).toBe('PERMISSION_DENIED');
      expect(apiErr.correlationId).toBe('header-corr-123');
      return true;
    });
  });

  it('handles non-JSON error bodies (e.g. gateway 502 Bad Gateway html/text) safely', async () => {
    const nonJsonFetch: typeof fetch = async (): Promise<Response> => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers({
          'Content-Type': 'text/html',
          'x-correlation-id': 'gw-timeout-99',
        }),
      });
    };

    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: nonJsonFetch });

    await expect(client.request('/test')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.errorCode).toBe('HTTP_ERROR');
      expect(apiErr.retryable).toBe(true);
      expect(apiErr.correlationId).toBe('gw-timeout-99');
      return true;
    });
  });

  it('handles 204 No Content response returning undefined without throwing', async () => {
    const noContentFetch: typeof fetch = async (): Promise<Response> => {
      return new Response(null, { status: 204, statusText: 'No Content' });
    };

    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: noContentFetch });
    const result = await client.request('/no-content');
    expect(result).toBeUndefined();
  });
});

describe('raw stream transport', () => {
  it('preserves SSE Accept, tenant/operator headers and the 202 response for storefront streams', async () => {
    const spy = createFetchSpy(new Response('event: accepted\n\n', { status: 202 }));
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', tenantId: 'tenant-a', operatorId: 'op-a', fetch: spy.mockFetch });
    const response = await client.requestRaw('/storefront/stream', { method: 'POST', body: JSON.stringify({ message: 'hello' }) }, undefined, { headers: { Accept: 'text/event-stream, application/json' } });
    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/storefront/stream');
    expect(spy.getHeaders()).toMatchObject({ Accept: 'text/event-stream, application/json', 'x-tenant-id': 'tenant-a', 'x-operator-id': 'op-a' });
    expect(response.status).toBe(202);
  });
});

describe('HTTP deadline and production configuration', () => {
  it('aborts a request when its configured timeout elapses', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: fetchImpl, timeoutMs: 5 });
    await expect(client.requestRaw('/slow')).rejects.toThrow('aborted');
  });
  it('uses the default 15 second AbortSignal deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const client = new HttpClient({ baseUrl: 'http://localhost:4000', fetch: fetchImpl });
    const request = client.requestRaw('/slow');
    const assertion = expect(request).rejects.toThrow('aborted');
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });


  it('does not use localhost as an implicit production origin', () => {
    const previousOrigin = process.env.NEXT_PUBLIC_API_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCi = process.env.CI;
    delete process.env.CI;
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => apiOrigin()).toThrow(/API_ORIGIN_NOT_CONFIGURED/);
    } finally {
      if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousOrigin;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });
});

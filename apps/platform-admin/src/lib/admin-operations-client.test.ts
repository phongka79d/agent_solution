import { describe, expect, it } from 'vitest';
import { AdminOperationsClient } from './admin-operations-client';
import type { GetRunsResponse, RunRetryRequest, TaskAcceptedResponse } from './types/admin-and-runs';

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

describe('P5 Tenant Workspace & Controlled Autonomy Contracts', () => {
  it('reads the session-bound current tenant projection', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ tenant_id: 'tenant-acme', status: 'PROVISIONED' }));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.getCurrentTenant();

    expect(spy.getLastUrl()).toBe('/api/v1/admin/tenants/current');
    expect(spy.getLastInit()?.method).toBe('GET');
  });

  it('reads session-bound autonomy state without a tenant form override', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ paused: true, current: [] }));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.getAutonomy();

    expect(spy.getLastUrl()).toBe('/api/v1/admin/autonomy');
    expect(spy.getLastInit()?.method).toBe('GET');
  });

  it('posts the pause operator action without caller authority text', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ accepted: true }));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.pauseAutonomy();

    expect(spy.getLastUrl()).toBe('/api/v1/admin/autonomy/pause');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toBeUndefined();
  });

  it('posts the resume operator action without caller authority text', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ accepted: true }));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.resumeAutonomy();

    expect(spy.getLastUrl()).toBe('/api/v1/admin/autonomy/resume');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toBeUndefined();
  });

  it('posts only skill_id and reason for demotion', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ accepted: true }));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.demoteAutonomy({ skill_id: 'skill.sales.check_stock', reason: 'operator safety review' });

    expect(spy.getLastUrl()).toBe('/api/v1/admin/autonomy/demote');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual({
      skill_id: 'skill.sales.check_stock',
      reason: 'operator safety review',
    });
  });
});

describe('platform-admin BFF browser transport', () => {
  it('uses same-origin paths, credentials, and the readable CSRF cookie without a bearer token', async () => {
    const previousDocument = Reflect.get(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'agentos_platform_csrf=csrf-value' },
    });
    try {
      const spy = createFetchSpy(createMockJsonResponse({ accepted: true }));
      const client = new AdminOperationsClient({ fetch: spy.mockFetch });
      await client.pauseAutonomy();

      const init = spy.getLastInit();
      const headers = new Headers(init?.headers);
      expect(spy.getLastUrl()).toBe('/api/v1/admin/autonomy/pause');
      expect(init?.credentials).toBe('same-origin');
      expect(headers.get('x-csrf-token')).toBe('csrf-value');
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-tenant-id')).toBe(false);
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
      }
    }
  });
});

describe('R16 Runs and R13 Retry Contracts', () => {
  it('calls GET /api/v1/runs with filters and state queries', async () => {
    const mockRuns: GetRunsResponse = {
      items: [{ run_id: 'run-1', state: 'failed', task_version: 1, current_step: 0, retry_count: 0, last_error_class: null, steps: [], correlation_id: 'corr-1' }],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockRuns));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getRuns({
      agent_id: 'agent-cart-recovery',
      state: 'failed',
      limit: 10,
    });

    expect(spy.getLastUrl()).toBe(
      '/api/v1/runs?limit=10&agent_id=agent-cart-recovery&state=failed'
    );
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(result.items[0]?.run_id).toBe('run-1');
  });

  it('calls POST /api/v1/operations/runs/{run_id}/retry for side-effect-free failures', async () => {
    const mockRetryResponse: TaskAcceptedResponse = {
      task_id: 'task-retry-999',
      conversation_id: null,
      status: 'accepted',
      task_version: 2,
      correlation_id: 'corr-retry-1',
    };
    const spy = createFetchSpy(createMockJsonResponse(mockRetryResponse, 202));
    const client = new AdminOperationsClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const retryBody: RunRetryRequest = {
      operator_id: 'op-lead',
      reason: 'Idempotent downstream network timeout verified',
    };

    const result = await client.retryRun('run-fail-789', retryBody);

    expect(spy.getLastUrl()).toBe('/api/v1/operations/runs/run-fail-789/retry');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(retryBody);
    expect(result.status).toBe('accepted');
  });
});

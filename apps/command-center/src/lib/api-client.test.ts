/**
 * @file apps/command-center/src/lib/api-client.test.ts
 * Deterministic contract tests for CommandCenterApiClient and URL helpers.
 * Injects fetch to assert observable HTTP request contracts (methods, paths,
 * query encoding, headers, request bodies, and error envelopes) without a server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  apiOrigin,
  buildApiUrl,
  buildQueryString,
  createApiClient,
  DEFAULT_API_ORIGIN,
  ApiError,
  type ApiErrorEnvelope,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResponse,
  type ApprovalDetailResponse,
  type ConversationResumeRequest,
  type ConversationTakeoverHeartbeatRequest,
  type ConversationTakeoverRequest,
  type CustomerTimelineResponse,
  type GetApprovalsResponse,
  type GetRunsResponse,
  type KpiSnapshotResponse,
  type PostMessageRequest,
  type RunRetryRequest,
  type TaskAcceptedResponse,
} from './api-client';

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  if (originalApiUrl === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  }
});

/**
 * Creates a deterministic mock Response with standard JSON headers.
 */
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

// ============================================================================
// 1. Exact /api/v1 URL Construction
// ============================================================================
describe('buildApiUrl & URL Construction Contract', () => {
  it('falls back to the local API gateway when NEXT_PUBLIC_API_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(apiOrigin()).toBe(DEFAULT_API_ORIGIN);
    expect(apiOrigin()).toBe('http://localhost:4000');
  });

  it('uses the configured origin when NEXT_PUBLIC_API_URL is set', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test';
    expect(apiOrigin()).toBe('https://api.example.test');
  });

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

// ============================================================================
// 2. Query Encoding
// ============================================================================
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

// ============================================================================
// 3. Tenant & Operator Headers
// ============================================================================
describe('Tenant & Operator Header Injection Contract', () => {
  it('injects client-level tenantId and operatorId as headers', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ ok: true }));
    const client = createApiClient({
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
    const client = createApiClient({
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
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.request('/test', {
      method: 'POST',
      body: JSON.stringify({ key: 'val' }),
    });

    const headers = spy.getHeaders();
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ============================================================================
// 4. R14: Approval List, Detail, Decision Contracts
// ============================================================================
describe('R14 Approval Contracts', () => {
  it('calls GET /api/v1/approvals with default status=PENDING', async () => {
    const mockData: GetApprovalsResponse = {
      items: [],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockData));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getApprovals();

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals?status=PENDING');
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(result).toEqual(mockData);
  });

  it('calls GET /api/v1/approvals with explicit query parameters', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ items: [], next_cursor: null }));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    await client.getApprovals({ status: 'PENDING', cursor: 'cur-100', limit: 25 });

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals?status=PENDING&cursor=cur-100&limit=25');
  });

  it('calls GET /api/v1/approvals/{id} with URI encoding', async () => {
    const mockDetail: ApprovalDetailResponse = {
      approval_id: 'app/special:001',
      run_id: 'run-1',
      action_id: 'action-1',
      effect_key: 'effect-1',
      payload: {},
      reason: 'Review this action',
      status: 'PENDING',
      is_paused: false,
      decided_by: null,
      decided_at: null,
      decision_notes: null,
      payload_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      created_at: '2026-09-23T00:00:00Z',
      tenant_id: 'tenant-1',
      expires_at: '2026-09-23T01:00:00Z',
    };
    const spy = createFetchSpy(createMockJsonResponse(mockDetail));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getApproval('app/special:001');

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals/app%2Fspecial%3A001');
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(result.approval_id).toBe('app/special:001');
  });

  it('calls POST /api/v1/approvals/{id}/decision with strict decision body, sha256 and handles HTTP 202 QUEUED response', async () => {
    const mockResponse: ApprovalDecisionResponse = {
      approval_id: 'app-123',
      task_id: 'task-queue-123',
      status: 'QUEUED',
      queued_at: '2026-09-23T12:00:00Z',
      correlation_id: 'corr-123',
    };
    const spy = createFetchSpy(createMockJsonResponse(mockResponse, 202));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const decisionRequest: ApprovalDecisionRequest = {
      decision: 'APPROVE',
      operator_id: 'op-bob',
      expected_payload_sha256: 'sha-expected-123',
      reason: 'Verified safe by human operator',
    };

    const result = await client.submitApprovalDecision('app-123', decisionRequest);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals/app-123/decision');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(decisionRequest);
    expect(result.status).toBe('QUEUED');
    expect(result.queued_at).toBe('2026-09-23T12:00:00Z');
    expect(result.approval_id).toBe('app-123');
    expect(result.task_id).toBe('task-queue-123');
    expect(result.correlation_id).toBe('corr-123');
    expect((result as unknown as Record<string, unknown>).decided_at).toBeUndefined();
  });

  it('submits MODIFY decision with modified_payload and returns HTTP 202 QUEUED without claiming decided_at', async () => {
    const mockResponse: ApprovalDecisionResponse = {
      approval_id: 'app-modify-1',
      task_id: 'task-queue-456',
      status: 'QUEUED',
      queued_at: '2026-09-23T12:05:00Z',
      correlation_id: 'corr-modify-456',
    };
    const spy = createFetchSpy(createMockJsonResponse(mockResponse, 202));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const modifyRequest: ApprovalDecisionRequest = {
      decision: 'MODIFY',
      operator_id: 'op-alice',
      expected_payload_sha256: 'sha-original-999',
      reason: 'OPERATOR_MODIFIED_PAYLOAD',
      modified_payload: { discount_cents: 500 },
    };

    const result = await client.submitApprovalDecision('app-modify-1', modifyRequest);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals/app-modify-1/decision');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(modifyRequest);
    expect(result.status).toBe('QUEUED');
    expect(result.queued_at).toBe('2026-09-23T12:05:00Z');
    expect((result as unknown as Record<string, unknown>).decided_at).toBeUndefined();
  });

  it('preserves HTTP 409 conflict and stale payload error envelope for conflicting or duplicate approvals', async () => {
    const errorEnvelope: ApiErrorEnvelope = {
      error_code: 'APPROVAL_STALE_PAYLOAD',
      message: 'approval app-123 now binds a different reviewed payload.',
      retryable: false,
      correlation_id: 'corr-stale-789',
    };
    const spy = createFetchSpy(createMockJsonResponse(errorEnvelope, 409));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const staleRequest: ApprovalDecisionRequest = {
      decision: 'APPROVE',
      operator_id: 'op-charlie',
      expected_payload_sha256: 'sha-stale-000',
      reason: 'Attempting approve with stale digest',
    };

    await expect(client.submitApprovalDecision('app-123', staleRequest)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      errorCode: 'APPROVAL_STALE_PAYLOAD',
      code: 'APPROVAL_STALE_PAYLOAD',
      message: 'approval app-123 now binds a different reviewed payload.',
      retryable: false,
      correlationId: 'corr-stale-789',
      envelope: expect.objectContaining({
        error_code: 'APPROVAL_STALE_PAYLOAD',
        correlation_id: 'corr-stale-789',
        retryable: false,
      }),
    });
  });
});

// ============================================================================
// 5. R15: Customer 360 & Timeline Contract
// ============================================================================
describe('R15 Customer 360 Timeline Contract', () => {
  it('calls GET /api/v1/customers/{id}/timeline with pagination and timeframe params', async () => {
    const mockTimeline: CustomerTimelineResponse = {
      items: [
        {
          event_id: 'ev-1',
          source_record_id: 'order-1',
          stage: 'purchase',
          canonical_event: 'order.completed',
          classification: 'FACT',
          evidence_reference: 'evidence-1',
          occurred_at: '2026-09-23T10:00:00Z',
        },
      ],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockTimeline));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getCustomerTimeline('cust-456', {
      cursor: 'cur-next',
      limit: 50,
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-23T00:00:00Z',
    });

    expect(spy.getLastUrl()).toBe(
      'http://localhost:4000/api/v1/customers/cust-456/timeline?cursor=cur-next&limit=50&from=2026-09-01T00%3A00%3A00Z&to=2026-09-23T00%3A00%3A00Z'
    );
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(result.items[0]?.classification).toBe('FACT');
  });
});

// ============================================================================
// 6. R16 & R13: Runs and Operator Retry Contracts
// ============================================================================
describe('R16 Runs and R13 Retry Contracts', () => {
  it('calls GET /api/v1/runs with filters and state queries', async () => {
    const mockRuns: GetRunsResponse = {
      items: [{ run_id: 'run-1', state: 'failed', task_version: 1, current_step: 0, retry_count: 0, last_error_class: null, steps: [], correlation_id: 'corr-1' }],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockRuns));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getRuns({
      agent_id: 'agent-cart-recovery',
      state: 'failed',
      limit: 10,
    });

    expect(spy.getLastUrl()).toBe(
      'http://localhost:4000/api/v1/runs?limit=10&agent_id=agent-cart-recovery&state=failed'
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
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const retryBody: RunRetryRequest = {
      operator_id: 'op-lead',
      reason: 'Idempotent downstream network timeout verified',
    };

    const result = await client.retryRun('run-fail-789', retryBody);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/operations/runs/run-fail-789/retry');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(retryBody);
    expect(result.status).toBe('accepted');
  });
});

// ============================================================================
// 7. R17: Telemetry KPI Snapshot & SSE Stream URL Contracts
// ============================================================================
describe('R17 Telemetry KPI & Stream Contracts', () => {
  it('calls GET /api/v1/telemetry/kpi-snapshot with window and timezone queries', async () => {
    const mockKpi: KpiSnapshotResponse = {
      window: '7d',
      timezone: 'Asia/Taipei',
      observed_at: '2026-09-23T12:00:00Z',
      metrics: [
        {
          metric: 'revenue_twd',
          value: 1250000,
          source_status: 'LIVE',
          observed_at: '2026-09-23T12:00:00Z',
          window: '7d',
          timezone: 'Asia/Taipei',
          provisional: false,
        },
      ],
      cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockKpi));
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getKpiSnapshot({ window: '7d', timezone: 'Asia/Taipei' });

    expect(spy.getLastUrl()).toBe(
      'http://localhost:4000/api/v1/telemetry/kpi-snapshot?window=7d&timezone=Asia%2FTaipei'
    );
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(Array.isArray(result.metrics) && result.metrics[0]?.source_status).toBe('LIVE');
  });

  it('constructs R09 Server-Sent Events (SSE) telemetry stream URL correctly', () => {
    const client = createApiClient({ baseUrl: 'http://localhost:4000' });
    const sseUrl = client.getTelemetryStreamUrl({
      metric: 'revenue_attribution',
      channel: 'live_kpi',
    });

    expect(sseUrl).toBe('http://localhost:4000/api/v1/telemetry/stream?metric=revenue_attribution&channel=live_kpi');
  });
});

// ============================================================================
// 8. SCR-005: Conversation Takeover, Heartbeat, Resume, Message Contracts
// ============================================================================
describe('SCR-005 Conversation Console Contracts', () => {
  it('calls POST /api/v1/conversations/{id}/takeover with operator lease request', async () => {
    const spy = createFetchSpy(
      createMockJsonResponse({
        conversation_id: 'conv-101',
        status: 'HUMAN_TAKEOVER',
        operator_id: 'operator-1',
        taken_over_at: '2026-09-23T12:00:00Z',
        lease_expires_at: '2026-09-23T12:01:00Z',
      })
    );
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const req: ConversationTakeoverRequest = {
      operator_id: 'operator-1',
      reason: 'Customer requested human supervisor',
      takeover_mode: 'FULL_CONTROL',
    };

    const result = await client.takeoverConversation('conv-101', req);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/takeover');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(req);
    expect(result.lease_expires_at).toBe('2026-09-23T12:01:00Z');
  });

  it('calls POST /api/v1/conversations/{id}/takeover/heartbeat to renew lease', async () => {
    const spy = createFetchSpy(
      createMockJsonResponse({
        conversation_id: 'conv-101',
        status: 'HUMAN_TAKEOVER',
        operator_id: 'operator-1',
        lease_expires_at: '2026-09-23T12:02:00Z',
      })
    );
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const heartbeatReq: ConversationTakeoverHeartbeatRequest = {
      operator_id: 'operator-1',
      extend_seconds: 60,
    };

    const result = await client.heartbeatTakeover('conv-101', heartbeatReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/takeover/heartbeat');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(heartbeatReq);
    expect(result.lease_expires_at).toBe('2026-09-23T12:02:00Z');
  });

  it('calls POST /api/v1/conversations/{id}/resume to release operator lease', async () => {
    const spy = createFetchSpy(
      createMockJsonResponse({
        conversation_id: 'conv-101',
        status: 'ACTIVE',
        resumed_at: '2026-09-23T12:03:00Z',
      })
    );
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const resumeReq: ConversationResumeRequest = {
      operator_id: 'operator-1',
      handoff_summary: 'Issue resolved; returning to autonomous routing',
    };

    const result = await client.resumeConversation('conv-101', resumeReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/resume');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(resumeReq);
    expect(result.status).toBe('ACTIVE');
  });

  it('calls POST /api/v1/conversations/{id}/messages with idempotency key', async () => {
    const spy = createFetchSpy(
      createMockJsonResponse(
        {
          task_id: 'msg-task-555',
          conversation_id: 'conv-101',
          status: 'accepted',
          task_version: 1,
          correlation_id: 'corr-message-1',
        },
        202
      )
    );
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const messageReq: PostMessageRequest = {
      message: 'Hello, I have updated your shipment tracking number.',
      idempotency_key: 'idem-msg-uuid-99',
    };

    const result = await client.postConversationMessage('conv-101', messageReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/messages');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(messageReq);
    expect(result.status).toBe('accepted');
  });
});

// ============================================================================
// 9. Standardized Error Envelope Handling
// ============================================================================
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
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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

    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: nonJsonFetch });

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

    const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: noContentFetch });
    const result = await client.request('/no-content');
    expect(result).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { ApiErrorEnvelope } from '@agentos/ui-foundation';
import { AuthRequestError, TenantConsoleClient } from './tenant-console-client';
import type {
  ApprovalDecisionRequest, ApprovalDecisionResponse, ApprovalDetailResponse,
  ConversationResumeRequest, ConversationTakeoverHeartbeatRequest, ConversationTakeoverRequest,
  CustomerTimelineResponse, GetApprovalsResponse, PostMessageRequest,
} from './types/tenant-console';

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
describe('Browser authentication contracts', () => {
  const authSession = {
    identity: { user_id: 'user-1', email: 'admin@example.test', display_name: 'Company Admin' },
    membership: { tenant_id: 'tenant-1', tenant_name: 'Tenant', role: 'member', scope: 'company' as const },
    permissions: ['campaign:draft', 'approval:read', 'approval:decide'] as const,
    expires_at: '2030-01-01T00:00:00.000Z',
  };
  it('bootstraps CSRF then signs in with email and password', async () => {

    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init });
      return createMockJsonResponse(authSession);
    };
    const client = new TenantConsoleClient({ fetch: fetchImpl });

    await client.signIn('admin@example.test', 'secret');

    expect(calls.map((call) => call.url)).toEqual(['/api/auth/session', '/api/auth/sign-in']);
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({ email: 'admin@example.test', password: 'secret' });
  });

  it('reads AuthSession from GET /api/auth/session', async () => {
    const spy = createFetchSpy(createMockJsonResponse(authSession));
    const client = new TenantConsoleClient({ fetch: spy.mockFetch });

    await expect(client.getAuthSession()).resolves.toEqual(authSession);
    expect(spy.getLastUrl()).toBe('/api/auth/session');
    expect(spy.getLastInit()?.method).toBe('GET');
  });

  it('signs out through the JSON auth endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(typeof input === 'string' ? input : input.toString());
      return createMockJsonResponse({ ok: true });
    };
    const client = new TenantConsoleClient({ fetch: fetchImpl });

    await client.signOut();

    expect(calls).toEqual(['/api/auth/session', '/api/auth/sign-out']);
  });

  it('preserves authentication status for rate-limit handling', async () => {
    const client = new TenantConsoleClient({
      fetch: async () => createMockJsonResponse({ error: 'TOO_MANY_ATTEMPTS' }, 429),
    });

    await expect(client.signIn('admin@example.test', 'secret')).rejects.toBeInstanceOf(AuthRequestError);
    await expect(client.signIn('admin@example.test', 'secret')).rejects.toMatchObject({ status: 429 });
  });
});

describe('R14 Approval Contracts', () => {
  it('calls GET /api/v1/approvals with default status=PENDING', async () => {
    const mockData: GetApprovalsResponse = {
      items: [],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockData));
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const result = await client.getApprovals();

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/approvals?status=PENDING');
    expect(spy.getLastInit()?.method).toBe('GET');
    expect(result).toEqual(mockData);
  });

  it('calls GET /api/v1/approvals with explicit query parameters', async () => {
    const spy = createFetchSpy(createMockJsonResponse({ items: [], next_cursor: null }));
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
      summary: {
        title_key: 'approvals.summary.campaign_send',
        params: {},
        requesting_agent_key: 'agents.marketing',
        domain: 'marketing',
        campaign_id: null,
        customer_id: null,
        risk: 'low',
        evidence_count: 0,
        modification: null,
        expires_at: '2026-09-23T01:00:00Z',
      },
      tenant_id: 'tenant-1',
      expires_at: '2026-09-23T01:00:00Z',
    };
    const spy = createFetchSpy(createMockJsonResponse(mockDetail));
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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

describe('R15 Customer 360 Timeline Contract', () => {
  it('calls GET /api/v1/customers/{id}/timeline with pagination and timeframe params', async () => {
    const mockTimeline: CustomerTimelineResponse = {
      items: [
        {
          event_id: 'ev-1',
          event_type: 'purchase',
          source_record_id: 'order-1',
          stage: 'purchase',
          canonical_event: 'order.completed',
          classification: 'FACT',
          evidence_reference: 'evidence-1',
          gap_reason: 'SOURCE_RECORD_PARTIALLY_AVAILABLE',
          occurred_at: '2026-09-23T10:00:00Z',
        },
      ],
      next_cursor: null,
    };
    const spy = createFetchSpy(createMockJsonResponse(mockTimeline));
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

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
    expect(result.items[0]?.event_type).toBe('purchase');
    expect(result.items[0]?.gap_reason).toBe('SOURCE_RECORD_PARTIALLY_AVAILABLE');
    expect(result.next_cursor).toBeNull();
  });
});


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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const req: ConversationTakeoverRequest = {
      reason: 'Customer requested human supervisor',
      takeover_mode: 'FULL_CONTROL',
    };

    const result = await client.takeoverConversation('conv-101', req);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/takeover');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual({ reason: req.reason, takeover_mode: req.takeover_mode });
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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const heartbeatReq: ConversationTakeoverHeartbeatRequest = {
      extend_seconds: 60,
    };

    const result = await client.heartbeatTakeover('conv-101', heartbeatReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/takeover/heartbeat');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual({ extend_seconds: heartbeatReq.extend_seconds });
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
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const resumeReq: ConversationResumeRequest = {
      handoff_summary: 'Issue resolved; returning to autonomous routing',
    };

    const result = await client.resumeConversation('conv-101', resumeReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/resume');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual({ handoff_summary: resumeReq.handoff_summary });
    expect(result.status).toBe('ACTIVE');
  });

  it('calls POST /api/v1/conversations/{id}/operator-messages with idempotency key', async () => {
    const spy = createFetchSpy(
      createMockJsonResponse(
        {
          message_id: 'msg-555',
          conversation_id: 'conv-101',
          status: 'persisted',
        },
        201
      )
    );
    const client = new TenantConsoleClient({ baseUrl: 'http://localhost:4000', fetch: spy.mockFetch });

    const messageReq: PostMessageRequest = {
      message: 'Hello, I have updated your shipment tracking number.',
      idempotency_key: 'idem-msg-uuid-99',
    };

    const result = await client.postConversationMessage('conv-101', messageReq);

    expect(spy.getLastUrl()).toBe('http://localhost:4000/api/v1/conversations/conv-101/operator-messages');
    expect(spy.getLastInit()?.method).toBe('POST');
    expect(spy.getBodyJson()).toEqual(messageReq);
    expect(result.status).toBe('persisted');
    expect(result.message_id).toBe('msg-555');
    expect(result.conversation_id).toBe('conv-101');
  });
});

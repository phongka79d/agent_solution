/**
 * @file apps/command-center/src/lib/api-client.ts
 * Typed browser-safe /api/v1 client for the Command Center.
 * Aligned with implement/06-api-and-connectors-spec.md and implement/07-human-command-center-ui.md.
 *
 * Invariants:
 * - Emits /api/v1 exactly once across all URL constructions.
 * - Injects tenant and operator headers without secrets.
 * - Browser-safe: only uses fetch / EventSource semantics; no runtime packages or provider SDK imports.
 * - Injectable fetch for deterministic contract and unit testing.
 * - Strict error envelope handling with typed ApiError.
 */

import type {
  ApiErrorEnvelope,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  ConversationResumeRequest,
  ConversationResumeResponse,
  ConversationTakeoverHeartbeatRequest,
  ConversationTakeoverHeartbeatResponse,
  ConversationTakeoverRequest,
  ConversationTakeoverResponse,
  CustomerTimelineParams,
  CustomerTimelineResponse,
  EventIngestionResponse,
  GetApprovalsParams,
  GetApprovalsResponse,
  GetKpiSnapshotParams,
  GetRunsParams,
  GetRunsResponse,
  KpiSnapshotResponse,
  PlatformEventEnvelope,
  PostMessageRequest,
  RunRetryRequest,
  StorefrontStreamRequest,
  TaskAcceptedResponse,
} from './api-types';

export * from './api-types';

/** Local API gateway origin used when no build-time URL is configured. */
export const DEFAULT_API_ORIGIN = 'http://localhost:4000';

/**
 * Origin of the API gateway. Inlined at build time from `NEXT_PUBLIC_API_URL`;
 * browser code never receives a server-only value or a credential.
 */
export function apiOrigin(): string {
  const configured = typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_API_URL : undefined;
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_API_ORIGIN;
}

/**
 * Builds a valid query string from a parameters record.
 * Omits undefined and null values; repeats arrays.
 */
export function buildQueryString(
  params?: Record<string, string | number | boolean | null | undefined | readonly (string | number | boolean)[]>
): string {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          searchParams.append(key, String(item));
        }
      }
    } else {
      searchParams.append(key, String(value));
    }
  }
  return searchParams.toString();
}

/**
 * URL constructor that strictly guarantees /api/v1 is emitted exactly once.
 * Handles variations in baseUrl (with or without /api/v1, trailing slashes)
 * and endpoint (with or without leading slashes or /api/v1).
 */
export function buildApiUrl(
  endpoint: string,
  query?: Record<string, string | number | boolean | null | undefined | readonly (string | number | boolean)[]>,
  baseUrl?: string
): string {
  const rawOrigin = baseUrl !== undefined ? baseUrl : apiOrigin();
  const origin = rawOrigin.trim();

  // Strip trailing slashes
  let cleanOrigin = origin.replace(/\/+$/, '');
  // If the base ends with /api/v1, strip it so we can append exactly once
  if (cleanOrigin.endsWith('/api/v1')) {
    cleanOrigin = cleanOrigin.slice(0, -'/api/v1'.length);
  }

  // Strip leading and trailing slashes from endpoint
  let cleanEndpoint = endpoint.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  // If endpoint explicitly starts with /api/v1 or api/v1, strip it
  if (cleanEndpoint === 'api/v1') {
    cleanEndpoint = '';
  } else if (cleanEndpoint.startsWith('api/v1/')) {
    cleanEndpoint = cleanEndpoint.slice('api/v1/'.length);
  }

  // Assemble path prefix with exactly one /api/v1
  const pathPrefix = cleanOrigin.length > 0 ? `${cleanOrigin}/api/v1` : '/api/v1';
  const fullPath = cleanEndpoint.length > 0 ? `${pathPrefix}/${cleanEndpoint}` : pathPrefix;

  const queryString = buildQueryString(query);
  return queryString.length > 0 ? `${fullPath}?${queryString}` : fullPath;
}

/**
 * Standard gateway API error representation.
 */
export class ApiError extends Error {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.message || `API error ${envelope.error_code} (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = envelope.error_code;
    this.retryable = envelope.retryable;
    this.correlationId = envelope.correlation_id;
    this.details = envelope.details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Configuration options for the CommandCenterApiClient.
 */
export interface ApiClientConfig {
  readonly baseUrl?: string;
  readonly tenantId?: string;
  readonly operatorId?: string;
  readonly fetch?: typeof fetch;
  readonly defaultHeaders?: Record<string, string>;
}

/**
 * Per-request overrides.
 */
export interface RequestOptions {
  readonly tenantId?: string;
  readonly operatorId?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/**
 * Typed browser-safe Command Center API Client.
 */
export class CommandCenterApiClient {
  private readonly baseUrl?: string;
  private readonly tenantId?: string;
  private readonly operatorId?: string;
  private readonly customFetch?: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = config.baseUrl;
    this.tenantId = config.tenantId;
    this.operatorId = config.operatorId;
    this.customFetch = config.fetch;
    this.defaultHeaders = config.defaultHeaders || {};
  }

  /** Gets the active fetch implementation. */
  private get fetchFn(): typeof fetch {
    if (this.customFetch) {
      return this.customFetch;
    }
    if (typeof fetch !== 'undefined') {
      return fetch.bind(globalThis);
    }
    throw new Error('No fetch implementation available in current environment.');
  }

  /**
   * Internal HTTP execution helper that builds URLs, injects tenant/operator headers,
   * and unwraps the standard API error envelope on failures.
   */
  async request<T>(
    endpoint: string,
    init: RequestInit = {},
    query?: Record<string, string | number | boolean | null | undefined | readonly (string | number | boolean)[]>,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = buildApiUrl(endpoint, query, this.baseUrl);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
      ...options.headers,
    };

    if (init.body && typeof init.body === 'string' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const tenantId = options.tenantId || this.tenantId;
    if (tenantId) {
      headers['x-tenant-id'] = tenantId;
    }

    const operatorId = options.operatorId || this.operatorId;
    if (operatorId) {
      headers['x-operator-id'] = operatorId;
    }

    const response = await this.fetchFn(url, {
      ...init,
      headers,
      signal: options.signal,
    });

    if (!response.ok) {
      let envelope: ApiErrorEnvelope;
      try {
        const errorJson = await response.json();
        envelope = {
          error_code: errorJson.error_code || 'HTTP_ERROR',
          message: errorJson.message || response.statusText,
          retryable: Boolean(errorJson.retryable),
          correlation_id: errorJson.correlation_id || response.headers.get('x-correlation-id') || '',
          details: errorJson.details,
        };
      } catch {
        envelope = {
          error_code: 'HTTP_ERROR',
          message: response.statusText || `Request failed with status ${response.status}`,
          retryable: response.status >= 500 && response.status !== 501,
          correlation_id: response.headers.get('x-correlation-id') || '',
        };
      }
      throw new ApiError(response.status, envelope);
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return (await response.json()) as T;
  }

  // ==========================================================================
  // R14: Approval Center & Decision Operations
  // ==========================================================================

  /**
   * R14: GET /api/v1/approvals?status=PENDING
   * Reads pending approval items with optional cursor pagination.
   */
  async getApprovals(
    params: GetApprovalsParams = { status: 'PENDING' },
    options?: RequestOptions
  ): Promise<GetApprovalsResponse> {
    const query = {
      status: params.status || 'PENDING',
      cursor: params.cursor,
      limit: params.limit,
    };
    return this.request<GetApprovalsResponse>('/approvals', { method: 'GET' }, query, options);
  }

  /**
   * Supplemental approval detail read: GET /api/v1/approvals/{id}
   */
  async getApproval(
    approvalId: string,
    options?: RequestOptions
  ): Promise<ApprovalDetailResponse> {
    return this.request<ApprovalDetailResponse>(
      `/approvals/${encodeURIComponent(approvalId)}`,
      { method: 'GET' },
      undefined,
      options
    );
  }

  /**
   * SCR-003: POST /api/v1/approvals/{id}/decision
   * Submits an atomic operator decision (APPROVE | REJECT | MODIFY | PAUSE | CANCEL)
   * requiring expected_payload_sha256.
   */
  async submitApprovalDecision(
    approvalId: string,
    body: ApprovalDecisionRequest,
    options?: RequestOptions
  ): Promise<ApprovalDecisionResponse> {
    return this.request<ApprovalDecisionResponse>(
      `/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  // ==========================================================================
  // R15: Customer 360 & Timeline Operations
  // ==========================================================================

  /**
   * R15: GET /api/v1/customers/{customer_id}/timeline
   * Reads customer timeline entries with FACT/SIGNAL/HYPOTHESIS/DECISION/ACTION separation.
   */
  async getCustomerTimeline(
    customerId: string,
    params?: CustomerTimelineParams,
    options?: RequestOptions
  ): Promise<CustomerTimelineResponse> {
    const query = {
      cursor: params?.cursor,
      limit: params?.limit,
      from: params?.from,
      to: params?.to,
    };
    return this.request<CustomerTimelineResponse>(
      `/customers/${encodeURIComponent(customerId)}/timeline`,
      { method: 'GET' },
      query,
      options
    );
  }

  // ==========================================================================
  // R16: Agent Operations & Runs
  // ==========================================================================

  /**
   * R16: GET /api/v1/runs
   * Reads operational agent run history with step latencies and authority verdicts.
   */
  async getRuns(
    params?: GetRunsParams,
    options?: RequestOptions
  ): Promise<GetRunsResponse> {
    const query = {
      cursor: params?.cursor,
      limit: params?.limit,
      agent_id: params?.agent_id,
      state: params?.state,
      status: params?.status,
      from: params?.from,
      to: params?.to,
    };
    return this.request<GetRunsResponse>('/runs', { method: 'GET' }, query, options);
  }

  /**
   * R13: POST /api/v1/operations/runs/{run_id}/retry
   * Operator-initiated re-dispatch of a failed, verified side-effect-free run.
   */
  async retryRun(
    runId: string,
    body: RunRetryRequest = {},
    options?: RequestOptions
  ): Promise<TaskAcceptedResponse> {
    return this.request<TaskAcceptedResponse>(
      `/operations/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  // ==========================================================================
  // R17: Telemetry & KPI Snapshot
  // ==========================================================================

  /**
   * R17: GET /api/v1/telemetry/kpi-snapshot
   * Reads the 10 baseline executive indicators with explicit source_status.
   */
  async getKpiSnapshot(
    params?: GetKpiSnapshotParams,
    options?: RequestOptions
  ): Promise<KpiSnapshotResponse> {
    const query = {
      window: params?.window,
      timezone: params?.timezone,
      cursor: params?.cursor,
      limit: params?.limit,
    };
    return this.request<KpiSnapshotResponse>('/telemetry/kpi-snapshot', { method: 'GET' }, query, options);
  }

  /**
   * R09: Constructs the Server-Sent Events (SSE) telemetry stream URL.
   */
  getTelemetryStreamUrl(params?: {
    metric?: string;
    channel?: string;
    cursor?: string;
  }): string {
    return buildApiUrl('/telemetry/stream', params, this.baseUrl);
  }

  // ==========================================================================
  // SCR-005: Conversation Console & Session Takeover Controls
  // ==========================================================================

  /**
   * POST /api/v1/conversations/{id}/takeover
   * Human operator acquires the exclusive takeover lease.
   */
  async takeoverConversation(
    conversationId: string,
    body: ConversationTakeoverRequest,
    options?: RequestOptions
  ): Promise<ConversationTakeoverResponse> {
    return this.request<ConversationTakeoverResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  /**
   * POST /api/v1/conversations/{id}/takeover/heartbeat
   * Renews the operator takeover lease (default 60s lease renewed every 30s).
   */
  async heartbeatTakeover(
    conversationId: string,
    body: ConversationTakeoverHeartbeatRequest,
    options?: RequestOptions
  ): Promise<ConversationTakeoverHeartbeatResponse> {
    return this.request<ConversationTakeoverHeartbeatResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover/heartbeat`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  /**
   * POST /api/v1/conversations/{id}/resume
   * Returns conversation to autonomous agent control.
   */
  async resumeConversation(
    conversationId: string,
    body: ConversationResumeRequest,
    options?: RequestOptions
  ): Promise<ConversationResumeResponse> {
    return this.request<ConversationResumeResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/resume`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  /**
   * POST /api/v1/conversations/{id}/messages
   * Sends an inbound message or operator response with idempotency key.
   */
  async postConversationMessage(
    conversationId: string,
    body: PostMessageRequest,
    options?: RequestOptions
  ): Promise<TaskAcceptedResponse> {
    return this.request<TaskAcceptedResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }

  // ==========================================================================
  // Storefront & Integration Helpers
  // ==========================================================================

  /**
   * POST /api/v1/storefront/stream
   * First-party storefront widget chat turn.
   */
  async postStorefrontStream(
    body: StorefrontStreamRequest,
    options?: RequestOptions
  ): Promise<Response> {
    const url = buildApiUrl('/storefront/stream', undefined, this.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      ...this.defaultHeaders,
      ...options?.headers,
    };
    const tenantId = options?.tenantId || this.tenantId;
    if (tenantId) headers['x-tenant-id'] = tenantId;

    return this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  }

  /**
   * POST /api/v1/storefront/events
   * Ingests storefront events with idempotency on event_id.
   */
  async postStorefrontEvent(
    body: PlatformEventEnvelope & { session_id?: string },
    options?: RequestOptions
  ): Promise<EventIngestionResponse> {
    return this.request<EventIngestionResponse>(
      '/storefront/events',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options
    );
  }
}

/** Default shared singleton instance. */
export const apiClient = new CommandCenterApiClient();

/** Factory function to create custom configured clients. */
export function createApiClient(config?: ApiClientConfig): CommandCenterApiClient {
  return new CommandCenterApiClient(config);
}

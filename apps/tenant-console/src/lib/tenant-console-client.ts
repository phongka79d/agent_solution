import { HttpClient, type HttpClientConfig, type RequestOptions } from '@agentos/ui-foundation';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  CompanyActivityResponse,
  CompanyAiTeamResponse,
  CompanyAttentionResponse,
  CompanyGovernanceResponse,
  CompanyIntegrationsResponse,
  CompanyOverviewResponse,
  GetApprovalsParams,
  GetApprovalsResponse,
} from '@agentos/api-contract';
import type {
  ConversationListParams,
  ConversationListResponse,
  ConversationMessagesResponse,
  ConversationResumeRequest,
  ConversationResumeResponse,
  ConversationSummaryResponse,
  ConversationTakeoverHeartbeatRequest,
  ConversationTakeoverHeartbeatResponse,
  ConversationTakeoverRequest,
  ConversationTakeoverResponse,
  CustomerListParams,
  CustomerListResponse,
  CustomerProfileResponse,
  CustomerTimelineParams,
  CustomerTimelineResponse,
  EventIngestionResponse,
  GetKpiSnapshotParams,
  KpiSnapshotResponse,
  PlatformEventEnvelope,
  PostMessageRequest,
  StorefrontStreamRequest,
  TaskAcceptedResponse,
} from './types/tenant-console';

const CSRF_COOKIE = 'agentos_tenant_csrf';
const CSRF_HEADER = 'x-csrf-token';
const DISALLOWED_BROWSER_HEADERS = ['authorization', 'x-tenant-id', 'x-operator-id'];

export type { AuthSession };

export class AuthRequestError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.message === 'string' ? payload.message : `Authentication request failed (${status})`);
    this.name = 'AuthRequestError';
    this.status = status;
    this.payload = payload;
  }
}

function browserCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  if (!match) return undefined;
  const value = match.slice(CSRF_COOKIE.length + 1);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isMutation(method: string | undefined): boolean {
  return method !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function secureBrowserFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const header of DISALLOWED_BROWSER_HEADERS) headers.delete(header);
    if (isMutation(init.method)) {
      const csrf = browserCsrfToken();
      if (csrf) headers.set(CSRF_HEADER, csrf);
    }
    const response = await fetchImpl(input, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
    if (response.status === 401 && typeof window !== 'undefined') {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      let pathname = '';
      try {
        const parsed = new URL(rawUrl, window.location.origin);
        pathname = parsed.pathname;
      } catch {
        pathname = '';
      }
      if (pathname === '/api/auth/session' || pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
        const current = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/sign-in?reason=expired&next=${encodeURIComponent(current)}`);
      }
    }
    return response;
  };
}

/** Tenant-console methods are limited to the KPI, approval, customer, takeover, and storefront contracts. */
export class TenantConsoleClient extends HttpClient {
  private readonly browserFetch: typeof fetch;
  private readonly bootstrapFetch: typeof fetch;
  constructor(config: HttpClientConfig = {}) {
    const fetchImpl = config.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) throw new Error('No fetch implementation available in current environment.');
    const secureFetch = secureBrowserFetch(fetchImpl);
    super({ ...config, baseUrl: config.baseUrl ?? '', fetch: secureFetch });
    this.browserFetch = secureFetch;
    this.bootstrapFetch = fetchImpl;
  }

  private async authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.browserFetch(path, init);
    if (!response.ok) {
      let payload: Record<string, unknown> = {};
      try {
        const value: unknown = await response.json();
        if (value && typeof value === 'object' && !Array.isArray(value)) payload = value as Record<string, unknown>;
      } catch {
        // Preserve the HTTP status when the BFF has no JSON body.
      }
      throw new AuthRequestError(response.status, payload);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async ensureAuthCsrfCookie(): Promise<void> {
    if (browserCsrfToken()) return;
    await this.bootstrapFetch('/api/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    await this.ensureAuthCsrfCookie();
    return this.authRequest<AuthSession>('/api/auth/sign-in', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'same-origin',
    });
  }

  async getAuthSession(): Promise<AuthSession> {
    return this.authRequest<AuthSession>('/api/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  }

  async signOut(): Promise<void> {
    await this.ensureAuthCsrfCookie();
    await this.authRequest<void>('/api/auth/sign-out', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  }

  async getCompanyOverview(options?: RequestOptions | undefined): Promise<CompanyOverviewResponse> {
    return this.request<CompanyOverviewResponse>('/company/overview', { method: 'GET' }, undefined, options);
  }

  async getCompanyAttention(options?: RequestOptions | undefined): Promise<CompanyAttentionResponse> {
    return this.request<CompanyAttentionResponse>('/company/attention', { method: 'GET' }, undefined, options);
  }

  async getCompanyAiTeam(options?: RequestOptions | undefined): Promise<CompanyAiTeamResponse> {
    return this.request<CompanyAiTeamResponse>('/company/ai-team', { method: 'GET' }, undefined, options);
  }

  async getCompanyActivity(
    params: { readonly limit?: number | undefined; readonly cursor?: string | undefined } = {},
    options?: RequestOptions | undefined,
  ): Promise<CompanyActivityResponse> {
    return this.request<CompanyActivityResponse>(
      '/company/activity',
      { method: 'GET' },
      { limit: params.limit, cursor: params.cursor },
      options,
    );
  }

  async getCompanyIntegrations(options?: RequestOptions | undefined): Promise<CompanyIntegrationsResponse> {
    return this.request<CompanyIntegrationsResponse>('/company/integrations', { method: 'GET' }, undefined, options);
  }

  async getCompanyGovernance(options?: RequestOptions | undefined): Promise<CompanyGovernanceResponse> {
    return this.request<CompanyGovernanceResponse>('/company/settings/governance', { method: 'GET' }, undefined, options);
  }

  async getApprovals(
    params: GetApprovalsParams = { status: 'PENDING' },
    options?: RequestOptions | undefined,
  ): Promise<GetApprovalsResponse> {
    return this.request<GetApprovalsResponse>(
      '/approvals',
      { method: 'GET' },
      { status: params.status || 'PENDING', cursor: params.cursor, limit: params.limit },
      options,
    );
  }

  async getApproval(
    approvalId: string,
    options?: RequestOptions | undefined,
  ): Promise<ApprovalDetailResponse> {
    return this.request<ApprovalDetailResponse>(
      `/approvals/${encodeURIComponent(approvalId)}`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async submitApprovalDecision(
    approvalId: string,
    body: ApprovalDecisionRequest,
    options?: RequestOptions | undefined,
  ): Promise<ApprovalDecisionResponse> {
    return this.request<ApprovalDecisionResponse>(
      `/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async getCustomerTimeline(
    customerId: string,
    params?: CustomerTimelineParams | undefined,
    options?: RequestOptions | undefined,
  ): Promise<CustomerTimelineResponse> {
    return this.request<CustomerTimelineResponse>(
      `/customers/${encodeURIComponent(customerId)}/timeline`,
      { method: 'GET' },
      {
        cursor: params?.cursor,
        limit: params?.limit,
        from: params?.from,
        to: params?.to,
      },
      options,
    );
  }

  async getConversations(
    params: ConversationListParams = {},
    options?: RequestOptions | undefined,
  ): Promise<ConversationListResponse> {
    return this.request<ConversationListResponse>(
      '/conversations',
      { method: 'GET' },
      { cursor: params.cursor, limit: params.limit },
      options,
    );
  }

  async getConversationMessages(
    conversationId: string,
    params: ConversationListParams = {},
    options?: RequestOptions | undefined,
  ): Promise<ConversationMessagesResponse> {
    return this.request<ConversationMessagesResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'GET' },
      { cursor: params.cursor, limit: params.limit },
      options,
    );
  }

  async getConversationSummary(
    conversationId: string,
    options?: RequestOptions | undefined,
  ): Promise<ConversationSummaryResponse> {
    return this.request<ConversationSummaryResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/summary`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async getCustomers(
    params: CustomerListParams = {},
    options?: RequestOptions | undefined,
  ): Promise<CustomerListResponse> {
    return this.request<CustomerListResponse>(
      '/customers',
      { method: 'GET' },
      { query: params.query, cursor: params.cursor, limit: params.limit },
      options,
    );
  }

  async getCustomerProfile(
    customerId: string,
    options?: RequestOptions | undefined,
  ): Promise<CustomerProfileResponse> {
    return this.request<CustomerProfileResponse>(
      `/customers/${encodeURIComponent(customerId)}/profile`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async getKpiSnapshot(
    params?: GetKpiSnapshotParams | undefined,
    options?: RequestOptions | undefined,
  ): Promise<KpiSnapshotResponse> {
    return this.request<KpiSnapshotResponse>(
      '/telemetry/kpi-snapshot',
      { method: 'GET' },
      {
        window: params?.window,
        timezone: params?.timezone,
        cursor: params?.cursor,
        limit: params?.limit,
      },
      options,
    );
  }

  getTelemetryStreamUrl(params?: {
    readonly metric?: string | undefined;
    readonly channel?: string | undefined;
    readonly cursor?: string | undefined;
  }): string {
    return this.url('/telemetry/stream', params);
  }

  async takeoverConversation(
    conversationId: string,
    body: ConversationTakeoverRequest,
    options?: RequestOptions | undefined,
  ): Promise<ConversationTakeoverResponse> {
    return this.request<ConversationTakeoverResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async heartbeatTakeover(
    conversationId: string,
    body: ConversationTakeoverHeartbeatRequest,
    options?: RequestOptions | undefined,
  ): Promise<ConversationTakeoverHeartbeatResponse> {
    return this.request<ConversationTakeoverHeartbeatResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/takeover/heartbeat`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async resumeConversation(
    conversationId: string,
    body: ConversationResumeRequest,
    options?: RequestOptions | undefined,
  ): Promise<ConversationResumeResponse> {
    return this.request<ConversationResumeResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/resume`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async postConversationMessage(
    conversationId: string,
    body: PostMessageRequest,
    options?: RequestOptions | undefined,
  ): Promise<TaskAcceptedResponse> {
    return this.request<TaskAcceptedResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/operator-messages`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async postOperatorMessage(
    conversationId: string,
    body: PostMessageRequest,
    options?: RequestOptions | undefined,
  ): Promise<TaskAcceptedResponse> {
    return this.postConversationMessage(conversationId, body, options);
  }

  async postStorefrontStream(
    body: StorefrontStreamRequest,
    options?: RequestOptions | undefined,
  ): Promise<Response> {
    return this.requestRaw(
      '/storefront/stream',
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...options?.headers,
        },
      },
    );
  }

  async postStorefrontEvent(
    body: PlatformEventEnvelope & { readonly session_id?: string | undefined },
    options?: RequestOptions | undefined,
  ): Promise<EventIngestionResponse> {
    return this.request<EventIngestionResponse>(
      '/storefront/events',
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async getCampaigns(
    params?: { readonly limit?: number | undefined; readonly cursor?: string | undefined } | undefined,
    options?: RequestOptions | undefined,
  ): Promise<{ readonly items: readonly Record<string, unknown>[]; readonly next_cursor?: string | null }> {
    return this.request(
      '/campaigns',
      { method: 'GET' },
      { limit: params?.limit, cursor: params?.cursor },
      options,
    );
  }

  async getCampaign(
    runId: string,
    options?: RequestOptions | undefined,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/campaigns/${encodeURIComponent(runId)}`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async createCampaignDraft(
    body: {
      readonly idempotency_key: string;
      readonly segment_id: string;
      readonly objective: string;
      readonly instruction?: string | undefined;
      readonly content_constraints?: Record<string, unknown> | undefined;
    },
    options?: RequestOptions | undefined,
  ): Promise<TaskAcceptedResponse> {
    return this.request<TaskAcceptedResponse>(
      '/campaigns/drafts',
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }

  async getRunTrace(
    runId: string,
    options?: RequestOptions | undefined,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/runs/${encodeURIComponent(runId)}/trace`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async getDemoCatalog(
    options?: RequestOptions | undefined,
  ): Promise<{ readonly items: readonly Record<string, unknown>[]; readonly snapshot_at?: string | undefined }> {
    return this.request(
      '/demo/catalog',
      { method: 'GET' },
      undefined,
      options,
    );
  }
}

export const tenantConsoleClient = new TenantConsoleClient();

export function createTenantConsoleClient(config?: HttpClientConfig | undefined): TenantConsoleClient {
  return new TenantConsoleClient(config);
}

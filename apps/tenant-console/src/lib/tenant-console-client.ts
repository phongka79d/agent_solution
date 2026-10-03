import { HttpClient, type HttpClientConfig, type RequestOptions } from '@agentos/ui-foundation';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  CompanyActivityResponse,
  CompanyAiTeamResponse,
  CompanyAttentionResponse,
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
  CompanyConnectorsResponse,
  CompanyGovernanceSettings,
  CompanyGovernanceUpdateRequest,
  CompanyLlmResponse,
  CompanyLlmUpdateRequest,
  CompanyProfileResponse,
  CompanyProfileUpdateRequest,
  ConnectorTestResponse,
  LlmProbeResult,
  ConnectorUpdateRequest,
  ConnectorUpdateResponse,
  ConversationTakeoverResponse,
  CustomerListParams,
  CustomerListResponse,
  CustomerProfileResponse,
  CustomerTimelineParams,
  CustomerTimelineResponse,
  PostMessageRequest,
  ConversationOperatorMessageResponse,
  AiTeamActivationAction,
  AiTeamDomain,
  AiTeamDomainResponse,
  CompanySkill,
  CompanyAnalyticsResponse,
  CompanyAnalyticsWindow,
  SkillHealthResponse,
  SkillSettingsUpdateRequest,
  SkillTestResponse,
  SkillsResponse,
} from './types/tenant-console';

const CSRF_COOKIE = 'agentos_tenant_csrf';
const CSRF_HEADER = 'x-csrf-token';
const DISALLOWED_BROWSER_HEADERS = ['authorization', 'x-tenant-id', 'x-operator-id'];

/** One redacted configuration-audit row as returned by `GET /api/v1/company/audit`. */
export interface CompanyAuditEvent {
  readonly event_id: string;
  readonly chain_seq: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly scope: string;
  readonly action: string;
  readonly tenant_id: string | null;
  readonly target: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly before_state?: unknown;
  readonly after_state?: unknown;
  readonly correlation_id: string;
  readonly created_at: string;
}
export interface CompanyOwnerInput {
  readonly input_id: string;
  readonly status: 'UNRESOLVED' | 'RESOLVED';
  readonly version: number;
  readonly resolved_at: string | null;
}

export type CompanyOwnerInputResolution =
  | { readonly value: Readonly<Record<string, unknown>> }
  | { readonly value_ref: string };


/** Environment probe returned by `GET /api/v1/testing/status`. */
export interface TestingStatusResponse {
  readonly tenant_id: string;
  readonly data_class: string;
  readonly enabled: boolean;
}

export interface CompanyAuditPage {
  readonly items?: readonly CompanyAuditEvent[];
  readonly next_cursor?: string | null;
  readonly chain_verified?: boolean;
  readonly chain_verification?: string;
  readonly verified?: boolean | string;
}

/** A still-usable invitation link as the accept page inspects it (T9.3). */
export interface InvitationInspection {
  readonly email: string;
  readonly tenant_id: string;
  readonly role_bundle: 'COMPANY_ADMIN' | 'OPERATOR' | 'VIEWER';
  readonly expires_at: string;
}
export type CompanyUserRole = 'COMPANY_ADMIN' | 'OPERATOR' | 'VIEWER';
export type CompanyUserStatus = 'INVITED' | 'ACTIVE' | 'DEACTIVATED';

export interface CompanyUserRecord {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly email: string;
  readonly role_bundle: CompanyUserRole;
  readonly status: CompanyUserStatus;
  readonly last_sign_in_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CompanyInvitationRecord {
  readonly invitation_id: string;
  readonly email: string;
  readonly role_bundle: CompanyUserRole;
  readonly expires_at: string;
}

export interface CompanyUsersResponse {
  readonly items: readonly CompanyUserRecord[];
}

export interface CompanyUserUpdate {
  readonly user_id: string;
  readonly role_bundle?: CompanyUserRole;
  readonly status?: CompanyUserStatus;
}


export type { AuthSession };

export class AuthRequestError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;
  /** Seconds to wait before retrying, parsed from the `Retry-After` header when the server sends it. */
  readonly retryAfter: number | null;

  constructor(status: number, payload: Record<string, unknown>, retryAfter: number | null = null) {
    super(typeof payload.message === 'string' ? payload.message : `Authentication request failed (${status})`);
    this.name = 'AuthRequestError';
    this.status = status;
    this.payload = payload;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : null;
  }
  return null;
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

/** Browser fetch for BFF calls: CSRF on mutations, no caller-forged auth headers, 401 → sign-in. */
export function secureBrowserFetch(fetchImpl: typeof fetch): typeof fetch {
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
      throw new AuthRequestError(response.status, payload, parseRetryAfter(response.headers.get('retry-after')));
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

  async renewSession(): Promise<AuthSession> {
    return this.authRequest<AuthSession>('/api/auth/renew', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
  }

  /** Inspects an invitation link before the invitee chooses a password (T9.3, public). */
  async inspectInvitation(token: string): Promise<InvitationInspection> {
    return this.authRequest<InvitationInspection>('/api/auth/invitations/inspect', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
  }

  /** Redeems an invitation: sets the password and activates the membership (T9.3, public). */
  async acceptInvitation(
    token: string,
    password: string,
    display_name?: string,
  ): Promise<{ readonly accepted: true }> {
    return this.authRequest<{ accepted: true }>('/api/auth/invitations/accept', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password,
        ...(display_name === undefined || display_name.trim().length === 0 ? {} : { display_name: display_name.trim() }),
      }),
      credentials: 'same-origin',
    });
  }

  async getCompanyOverview(options?: RequestOptions | undefined): Promise<CompanyOverviewResponse> {
    return this.request<CompanyOverviewResponse>('/company/overview', { method: 'GET' }, undefined, options);
  }

  async getCompanyAttention(options?: RequestOptions | undefined): Promise<CompanyAttentionResponse> {
    return this.request<CompanyAttentionResponse>('/company/attention', { method: 'GET' }, undefined, options);
  }

  /** Environment probe backing the workspace data-class chip and the Test lab entry. */
  async getTestingStatus(options?: RequestOptions | undefined): Promise<TestingStatusResponse> {
    return this.request<TestingStatusResponse>('/testing/status', { method: 'GET' }, undefined, options);
  }

  async getCompanyAiTeam(options?: RequestOptions | undefined): Promise<CompanyAiTeamResponse> {
    return this.request<CompanyAiTeamResponse>('/company/ai-team', { method: 'GET' }, undefined, options);
  }

  /** Per-domain activation snapshot with the unmet prerequisite reasons that block activation. */
  async getAiTeamDomain(domain: AiTeamDomain, options?: RequestOptions | undefined): Promise<AiTeamDomainResponse> {
    return this.request<AiTeamDomainResponse>(
      `/company/ai-team/${encodeURIComponent(domain)}`,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  /** Activate, pause or resume one AI Team domain; a 409 carries the unmet prerequisites. */
  async changeAiTeamDomain(
    domain: AiTeamDomain,
    action: AiTeamActivationAction,
    options?: RequestOptions | undefined,
  ): Promise<AiTeamDomainResponse> {
    return this.request<AiTeamDomainResponse>(
      `/company/ai-team/${encodeURIComponent(domain)}/${action}`,
      { method: 'POST' },
      undefined,
      options,
    );
  }

  async getSkills(options?: RequestOptions | undefined): Promise<SkillsResponse> {
    return this.request<SkillsResponse>('/skills', { method: 'GET' }, undefined, options);
  }

  async getSkill(skillId: string, options?: RequestOptions | undefined): Promise<CompanySkill> {
    const response = await this.request<{ readonly skill: CompanySkill }>(
      `/skills/${encodeURIComponent(skillId)}`,
      { method: 'GET' },
      undefined,
      options,
    );
    return response.skill;
  }

  /** Narrows a skill binding; the immutable contract fields are never sent. */
  async updateSkillSettings(
    skillId: string,
    body: SkillSettingsUpdateRequest,
    options?: RequestOptions | undefined,
  ): Promise<CompanySkill> {
    const response = await this.request<{ readonly skill: CompanySkill }>(
      `/skills/${encodeURIComponent(skillId)}/settings`,
      { method: 'PATCH', body: JSON.stringify(body) },
      undefined,
      options,
    );
    return response.skill;
  }

  async setSkillAgents(
    skillId: string,
    agents: readonly string[],
    options?: RequestOptions | undefined,
  ): Promise<readonly string[]> {
    const response = await this.request<{ readonly assigned_agents: readonly string[] }>(
      `/skills/${encodeURIComponent(skillId)}/agents`,
      { method: 'PUT', body: JSON.stringify({ agents }) },
      undefined,
      options,
    );
    return response.assigned_agents;
  }

  async testSkill(skillId: string, options?: RequestOptions | undefined): Promise<SkillTestResponse> {
    return this.request<SkillTestResponse>(
      `/skills/${encodeURIComponent(skillId)}/test`,
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      undefined,
      options,
    );
  }

  async getSkillHealth(skillId: string, options?: RequestOptions | undefined): Promise<SkillHealthResponse> {
    return this.request<SkillHealthResponse>(
      `/skills/${encodeURIComponent(skillId)}/health`,
      { method: 'GET' },
      undefined,
      options,
    );
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

  async getCompanyIntegrations(options?: RequestOptions | undefined): Promise<CompanyConnectorsResponse> {
    return this.request<CompanyConnectorsResponse>('/company/integrations', { method: 'GET' }, undefined, options);
  }

  /** Saves catalog config and an optional write-only secret; the response never echoes the secret. */
  async updateCompanyIntegration(
    connectorId: string,
    body: ConnectorUpdateRequest,
    version: number,
    options?: RequestOptions | undefined,
  ): Promise<ConnectorUpdateResponse> {
    return this.request<ConnectorUpdateResponse>(
      `/company/integrations/${encodeURIComponent(connectorId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
      undefined,
      { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async testCompanyIntegration(
    connectorId: string,
    options?: RequestOptions | undefined,
  ): Promise<ConnectorTestResponse> {
    return this.request<ConnectorTestResponse>(
      `/company/integrations/${encodeURIComponent(connectorId)}/test`,
      { method: 'POST' },
      undefined,
      options,
    );
  }

  async disconnectCompanyIntegration(
    connectorId: string,
    version: number,
    options?: RequestOptions | undefined,
  ): Promise<ConnectorUpdateResponse> {
    return this.request<ConnectorUpdateResponse>(
      `/company/integrations/${encodeURIComponent(connectorId)}/disconnect`,
      { method: 'POST' },
      undefined,
      { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async getCompanyGovernance(options?: RequestOptions | undefined): Promise<CompanyGovernanceSettings> {
    return this.request<CompanyGovernanceSettings>('/company/settings/governance', { method: 'GET' }, undefined, options);
  }

  /** Saves governance with `If-Match`; a stale version is rejected by the server with `VERSION_CONFLICT`. */
  async updateCompanyGovernance(
    body: CompanyGovernanceUpdateRequest,
    version: number,
    options?: RequestOptions | undefined,
  ): Promise<CompanyGovernanceSettings> {
    return this.request<CompanyGovernanceSettings>(
      '/company/settings/governance',
      { method: 'PUT', body: JSON.stringify(body) },
      undefined,
      { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async getCompanyProfile(options?: RequestOptions | undefined): Promise<CompanyProfileResponse> {
    return this.request<CompanyProfileResponse>('/company/settings/profile', { method: 'GET' }, undefined, options);
  }

  async updateCompanyProfile(
    body: CompanyProfileUpdateRequest,
    version: number,
    options?: RequestOptions | undefined,
  ): Promise<CompanyProfileResponse> {
    return this.request<CompanyProfileResponse>(
      '/company/settings/profile',
      { method: 'PUT', body: JSON.stringify(body) },
      undefined,
      { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async getCompanyUsers(options?: RequestOptions | undefined): Promise<CompanyUsersResponse> {
    return this.request<CompanyUsersResponse>('/company/users', { method: 'GET' }, undefined, options);
  }

  async inviteCompanyUser(
    email: string,
    role_bundle: CompanyUserRole,
    options?: RequestOptions | undefined,
  ): Promise<CompanyInvitationRecord> {
    return this.request<CompanyInvitationRecord>(
      '/company/users',
      { method: 'POST', body: JSON.stringify({ email, role_bundle }) },
      undefined,
      options,
    );
  }

  async updateCompanyUser(
    update: CompanyUserUpdate,
    options?: RequestOptions | undefined,
  ): Promise<CompanyUserRecord> {
    return this.request<CompanyUserRecord>(
      '/company/users',
      { method: 'PATCH', body: JSON.stringify(update) },
      undefined,
      options,
    );
  }

  async getCompanyLlm(options?: RequestOptions | undefined): Promise<CompanyLlmResponse> {
    return this.request<CompanyLlmResponse>('/company/settings/llm', { method: 'GET' }, undefined, options);
  }

  /**
   * Saves the LLM configuration. `api_key` is write-only: it is sent only when the operator sets a
   * new key, and the response never echoes it. `config_version` seeds `If-Match` when present.
   */
  async updateCompanyLlm(
    body: CompanyLlmUpdateRequest,
    version: string | null,
    options?: RequestOptions | undefined,
  ): Promise<CompanyLlmResponse> {
    return this.request<CompanyLlmResponse>(
      '/company/settings/llm',
      { method: 'PUT', body: JSON.stringify(body) },
      undefined,
      version === null ? options : { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async testCompanyLlm(options?: RequestOptions | undefined): Promise<LlmProbeResult> {
    return this.request<LlmProbeResult>('/company/settings/llm/test', { method: 'POST' }, undefined, options);
  }
  async getCompanyOwnerInputs(options?: RequestOptions | undefined): Promise<{ readonly items: readonly CompanyOwnerInput[] }> {
    return this.request<{ readonly items: readonly CompanyOwnerInput[] }>('/company/owner-inputs', { method: 'GET' }, undefined, options);
  }

  async resolveCompanyOwnerInput(
    input_id: string,
    body: CompanyOwnerInputResolution,
    version: number,
    options?: RequestOptions | undefined,
  ): Promise<{ readonly input: CompanyOwnerInput }> {
    return this.request<{ readonly input: CompanyOwnerInput }>(
      `/company/owner-inputs/${encodeURIComponent(input_id)}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      { ...options, headers: { ...options?.headers, 'If-Match': `"${version}"` } },
    );
  }

  async getCompanyAudit(
    params: { readonly limit?: number | undefined; readonly cursor?: string | undefined; readonly scope?: string | undefined } = {},
    options?: RequestOptions | undefined,
  ): Promise<CompanyAuditPage> {
    return this.request<CompanyAuditPage>(
      '/company/audit',
      { method: 'GET' },
      { limit: params.limit, cursor: params.cursor, scope: params.scope },
      options,
    );
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

  /** T6.10 truthful company analytics; the window stays inside 24h | 7d | 30d. */
  async getCompanyAnalytics(
    window: CompanyAnalyticsWindow,
    options?: RequestOptions | undefined,
  ): Promise<CompanyAnalyticsResponse> {
    return this.request<CompanyAnalyticsResponse>(
      '/company/analytics',
      { method: 'GET' },
      { window },
      options,
    );
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
  ): Promise<ConversationOperatorMessageResponse> {
    return this.request<ConversationOperatorMessageResponse>(
      `/conversations/${encodeURIComponent(conversationId)}/operator-messages`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      options,
    );
  }
}

export const tenantConsoleClient = new TenantConsoleClient();

export function createTenantConsoleClient(config?: HttpClientConfig | undefined): TenantConsoleClient {
  return new TenantConsoleClient(config);
}

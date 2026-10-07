import { safeNext } from '@agentos/ui-foundation/auth';
import { HttpClient, type HttpClientConfig, type QueryParams, type RequestOptions } from '@agentos/ui-foundation';

const PLATFORM_CSRF_COOKIE = 'agentos_platform_csrf';
const MUTATION_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

function csrfTokenFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const pair of document.cookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== PLATFORM_CSRF_COOKIE) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}
import type {
  AutonomyDemoteRequest,
  AutonomyInspectionResponse,
  GetRunsParams,
  GetRunsResponse,
  RunRetryRequest,
  TaskAcceptedResponse,
  TenantWorkspaceResponse,
} from './types/admin-and-runs';

/** P5 tenant-admin route paths. The gateway supplies the /api/v1 prefix. */
export const TENANT_ADMIN_PATHS = Object.freeze({
  currentTenant: '/admin/tenants/current',
  autonomy: '/admin/autonomy',
  pause: '/admin/autonomy/pause',
  resume: '/admin/autonomy/resume',
  demote: '/admin/autonomy/demote',
} as const);

/** Browser-safe transport for platform-admin P5 and operations routes only. */
export class AdminOperationsClient extends HttpClient {
  constructor(config: HttpClientConfig = {}) {
    // Platform-admin browser traffic must stay same-origin; the BFF owns the API bearer.
    super({ ...config, baseUrl: '' });
  }

  override async requestRaw(
    endpoint: string,
    init: RequestInit = {},
    query?: QueryParams,
    options: RequestOptions = {},
  ): Promise<Response> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.delete('authorization');
    headers.delete('x-tenant-id');
    headers.delete('x-operator-id');
    if (MUTATION_METHODS[method]) {
      const csrfToken = csrfTokenFromCookie();
      if (csrfToken) headers.set('x-csrf-token', csrfToken);
    }
    const response = await super.requestRaw(
      endpoint,
      { ...init, credentials: init.credentials ?? 'same-origin' },
      query,
      { ...options, headers: Object.fromEntries(headers.entries()) },
    );
    if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/sign-in') {
      const next = safeNext(`${window.location.pathname}${window.location.search}`);
      window.location.assign(`/sign-in?reason=expired&next=${encodeURIComponent(next)}`);
    }
    return response;
  }
  async getRuns(
    params?: GetRunsParams,
    options?: RequestOptions,
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

  async retryRun(
    runId: string,
    body: RunRetryRequest = {},
    options?: RequestOptions,
  ): Promise<TaskAcceptedResponse> {
    return this.request<TaskAcceptedResponse>(
      `/operations/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options,
    );
  }

  async getCurrentTenant(options?: RequestOptions): Promise<TenantWorkspaceResponse> {
    return this.request<TenantWorkspaceResponse>(
      TENANT_ADMIN_PATHS.currentTenant,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async getAutonomy(options?: RequestOptions): Promise<AutonomyInspectionResponse> {
    return this.request<AutonomyInspectionResponse>(
      TENANT_ADMIN_PATHS.autonomy,
      { method: 'GET' },
      undefined,
      options,
    );
  }

  async pauseAutonomy(options?: RequestOptions): Promise<unknown> {
    return this.request<unknown>(TENANT_ADMIN_PATHS.pause, { method: 'POST' }, undefined, options);
  }

  async resumeAutonomy(options?: RequestOptions): Promise<unknown> {
    return this.request<unknown>(TENANT_ADMIN_PATHS.resume, { method: 'POST' }, undefined, options);
  }

  async demoteAutonomy(
    body: AutonomyDemoteRequest,
    options?: RequestOptions,
  ): Promise<unknown> {
    return this.request<unknown>(
      TENANT_ADMIN_PATHS.demote,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      options,
    );
  }
}

export const adminOperationsClient = new AdminOperationsClient();

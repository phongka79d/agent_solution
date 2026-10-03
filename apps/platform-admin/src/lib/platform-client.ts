'use client';
import type { components, paths } from '@agentos/api-contract';
import type {
  PlatformProvidersResponse,
  PlatformReadiness,
  PlatformTenant,
  PlatformTenantsResponse,
  PlatformUsage,
  PlatformUsageResponse,
} from '@agentos/api-contract';

export type {
  PlatformProvider,
  PlatformProvidersResponse,
  PlatformReadiness,
  PlatformTenant,
  PlatformTenantsResponse,
  PlatformUsage,
  PlatformUsageResponse,
} from '@agentos/api-contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error_code: string,
    readonly correlation_id: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const PLATFORM_CSRF_COOKIE = 'agentos_platform_csrf';

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

export async function platformJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string> | undefined ?? {}) };
  if (method !== 'GET' && method !== 'HEAD') {
    const csrfToken = csrfTokenFromCookie();
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  const response = await fetch(`/api/v1/${path.replace(/^\//, '')}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* malformed/non-JSON errors are handled below */ }
  if (!response.ok) {
    const details = typeof payload === 'object' && payload !== null
      ? payload as Record<string, unknown>
      : {};
    const message = typeof details['message'] === 'string' ? details['message'] : 'Unable to load data.';
    throw new ApiError(
      response.status,
      typeof details['error_code'] === 'string' ? details['error_code'] : 'UNKNOWN_ERROR',
      typeof details['correlation_id'] === 'string' ? details['correlation_id'] : 'unavailable',
      message,
    );
  }
  return payload as T;
}
type AuthInvitationRequestPath = 'invitations/inspect' | 'invitations/accept';

async function authInvitationRequest<T>(path: AuthInvitationRequestPath, body: Readonly<Record<string, string>>): Promise<T> {
  if (csrfTokenFromCookie() === null) {
    await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  }
  const csrfToken = csrfTokenFromCookie();
  if (csrfToken === null) {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'unavailable', 'Invitation authentication is unavailable.');
  }
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Preserve the HTTP status when the BFF has no JSON body.
  }
  if (!response.ok) {
    const errorCode = payload !== null && typeof payload === 'object' && 'error_code' in payload && typeof payload.error_code === 'string'
      ? payload.error_code
      : payload !== null && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'AUTH_UNAVAILABLE';
    const correlationId = payload !== null && typeof payload === 'object' && 'correlation_id' in payload && typeof payload.correlation_id === 'string'
      ? payload.correlation_id
      : 'unavailable';
    const message = payload !== null && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message
      : 'Invitation request failed.';
    throw new ApiError(response.status, errorCode, correlationId, message);
  }
  return payload as T;
}

export type PlatformAdminStatus = components['schemas']['PlatformAdmin']['status'];

export type PlatformAdmin = components['schemas']['PlatformAdmin'];
export type PlatformAdminsResponse = components['schemas']['PlatformAdminsResponse'];

export type PlatformAdminInvitation = components['schemas']['PlatformAdminInvitationResponse'];

/** OpenAPI currently has no success schema for invitation inspection. */
export interface PlatformInvitationInspection {
  readonly email: string;
  readonly tenant_id: string;
  readonly role_bundle: 'COMPANY_ADMIN' | 'OPERATOR' | 'VIEWER' | 'PLATFORM_ADMIN';
  readonly scope: 'company' | 'platform';
  readonly expires_at: string;
}

export async function listPlatformAdmins(): Promise<readonly PlatformAdmin[]> {
  const data = await platformJson<PlatformAdminsResponse>('platform/admins');
  return Array.isArray(data.items) ? data.items : [];
}

export async function invitePlatformAdmin(email: string): Promise<PlatformAdminInvitation> {
  return platformJson<PlatformAdminInvitation>('platform/admins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export function inspectPlatformInvitation(token: string): Promise<PlatformInvitationInspection> {
  return authInvitationRequest<PlatformInvitationInspection>('invitations/inspect', { token });
}

export function acceptPlatformInvitation(
  token: string,
  password: string,
  displayName?: string,
): Promise<{ readonly accepted: true }> {
  return authInvitationRequest<{ readonly accepted: true }>('invitations/accept', {
    token,
    password,
    ...(displayName === undefined || displayName.trim().length === 0 ? {} : { display_name: displayName.trim() }),
  });
}


export async function listTenants(): Promise<readonly PlatformTenant[]> {
  const data = await platformJson<PlatformTenantsResponse>('platform/tenants');
  return Array.isArray(data.items) ? data.items : [];
}

/** Company directory projection (T8.2). Same shape as a tenant row. */
export type PlatformCompany = PlatformTenant;
export type PlatformCompaniesResponse = components['schemas']['PlatformTenantsResponse'];

export async function listCompanies(): Promise<readonly PlatformCompany[]> {
  const data = await platformJson<PlatformCompaniesResponse>('platform/companies');
  return Array.isArray(data.items) ? data.items : [];
}

/** No OpenAPI success schema exists yet for this derived per-company rollup. */
export interface PlatformCompanyOverview {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly data_class: string;
  readonly created_at: string;
  readonly runs_total: number;
  readonly runs_failed: number;
  readonly runs_running: number;
  readonly runs_waiting: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
  readonly needs_attention: boolean;
  readonly last_activity_at: string | null;
}

export async function getCompanyOverview(id: string): Promise<PlatformCompanyOverview> {
  return platformJson<PlatformCompanyOverview>(`platform/companies/${encodeURIComponent(id)}/overview`);
}

/** OpenAPI has no success schemas for these cross-company run projections yet. */
export interface PlatformRunListItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly current_step: number;
  readonly state: string;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly correlation_id: string;
}

export interface PlatformRunsSummaryRow {
  readonly state: string;
  readonly run_count: number;
  readonly tenant_count: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
}

export interface PlatformReconciliationItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly state: string;
  readonly failure_class: string | null;
  readonly attempts: number;
  readonly max_retries: number;
  readonly reason: string;
  readonly correlation_id: string;
  readonly updated_at: string;
}

/** Provisioning request/response bodies have no matching OpenAPI schemas yet. */
export interface ProvisionTenantInput {
  readonly display_name: string;
  readonly data_class: string;
  readonly locale: string;
  readonly currency: string;
}

export interface ProvisionedTenant {
  readonly tenant_id: string;
  readonly status: string;
}

/** Creates a company shell through the BFF-allowlisted provisioning route (T8.2). */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  const idempotency_key = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return platformJson<ProvisionedTenant>('provisioning/tenants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, idempotency_key }),
  });
}

/** The company invitation operation has no documented success schema yet. */
export interface CompanyAdminInvitation {
  readonly invitation_id: string;
  readonly email: string;
  readonly role_bundle: 'COMPANY_ADMIN';
  readonly expires_at: string;
}

export async function inviteCompanyAdmin(companyId: string, email: string): Promise<CompanyAdminInvitation> {
  return platformJson<CompanyAdminInvitation>(
    `platform/companies/${encodeURIComponent(companyId)}/invitations`,
    {
      method: 'POST',
      body: JSON.stringify({ email, role_bundle: 'COMPANY_ADMIN' }),
    },
  );
}

export async function getTenant(id: string): Promise<PlatformTenant> {
  return platformJson<PlatformTenant>(`platform/tenants/${encodeURIComponent(id)}`);
}

export async function getReadiness(id: string): Promise<PlatformReadiness> {
  return platformJson<PlatformReadiness>(`platform/tenants/${encodeURIComponent(id)}/readiness`);
}

export type PlatformCompanyUserRole = components['schemas']['PlatformCompanyUser']['role_bundle'];
export type PlatformCompanyUserStatus = components['schemas']['PlatformCompanyUser']['status'];

export type PlatformCompanyUser = components['schemas']['PlatformCompanyUser'];

export async function listCompanyUsers(companyId: string): Promise<readonly PlatformCompanyUser[]> {
  const response = await platformJson<components['schemas']['PlatformCompanyUsersResponse']>(
    `platform/companies/${encodeURIComponent(companyId)}/users`,
  );
  return response.items;
}

/** OpenAPI only describes these autonomy rows as arbitrary objects, so the UI keeps their known fields locally. */
export interface PlatformCompanyAutonomyPolicy {
  readonly policy_id: string;
  readonly policy_version: string;
  readonly skill_id: string;
  readonly state: string;
  readonly evidence_window_ref: string | null;
  readonly reason: string;
  readonly effective_at: string;
}

export type PlatformCompanyAutonomy = Omit<
  paths['/api/v1/platform/companies/{id}/autonomy']['get']['responses'][200]['content']['application/json'],
  'current' | 'history'
> & {
  readonly current: readonly PlatformCompanyAutonomyPolicy[];
  readonly history: readonly PlatformCompanyAutonomyPolicy[];
};

/** OpenAPI currently has no success schema for the platform audit projection. */
export interface PlatformCompanyAuditEvent {
  readonly event_id: string;
  readonly chain_seq: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly created_at: string;
}

export type PlatformAutonomyAction = 'pause' | 'resume' | 'demote';
export type PlatformCompanyLifecycleAction = 'suspend' | 'resume';

/** OpenAPI has no request/response schema for the per-company autonomy commands yet. */
export interface PlatformAutonomyActionInput {
  readonly reason: string;
  readonly skill_id?: string;
}

export interface PlatformAutonomyActionResult {
  readonly accepted: boolean;
  readonly eligible: boolean;
  readonly reason: string;
  readonly record?: PlatformCompanyAutonomyPolicy;
}

/** The invitation response currently has no matching OpenAPI schema. */
export interface PlatformCompanyInvitation {
  readonly invitation_id: string;
  readonly email: string;
  readonly role_bundle: PlatformCompanyUserRole;
  readonly expires_at: string;
}

export async function getCompanyAutonomy(companyId: string): Promise<PlatformCompanyAutonomy> {
  return platformJson<PlatformCompanyAutonomy>(`platform/companies/${encodeURIComponent(companyId)}/autonomy`);
}

export async function listCompanyRuns(companyId: string): Promise<readonly PlatformRunListItem[]> {
  const query = new URLSearchParams({ company_id: companyId, limit: '50' });
  const data = await platformJson<{ readonly items: readonly PlatformRunListItem[] }>(`platform/runs?${query.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function getCompanyUsage(companyId: string, from: string, to: string): Promise<readonly PlatformUsage[]> {
  const items = await getUsage(from, to);
  return items.filter((item) => item.tenant_id === companyId);
}

export async function listCompanyAuditEvents(companyId: string): Promise<readonly PlatformCompanyAuditEvent[]> {
  const query = new URLSearchParams({ tenant_id: companyId, limit: '50' });
  const data = await platformJson<{ readonly items: readonly PlatformCompanyAuditEvent[] }>(`platform/audit?${query.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function executeCompanyAutonomyAction(
  companyId: string,
  action: PlatformAutonomyAction,
  input: PlatformAutonomyActionInput,
): Promise<PlatformAutonomyActionResult> {
  return platformJson<PlatformAutonomyActionResult>(
    `platform/companies/${encodeURIComponent(companyId)}/autonomy/${action}`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function changeCompanyLifecycle(
  companyId: string,
  action: PlatformCompanyLifecycleAction,
  reason: string,
): Promise<{ readonly tenant_id: string; readonly status: string }> {
  return platformJson<{ readonly tenant_id: string; readonly status: string }>(
    `platform/companies/${encodeURIComponent(companyId)}/${action}`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

export async function resendCompanyUserInvitation(
  companyId: string,
  email: string,
  role_bundle: PlatformCompanyUserRole,
): Promise<PlatformCompanyInvitation> {
  return platformJson<PlatformCompanyInvitation>(
    `platform/companies/${encodeURIComponent(companyId)}/invitations`,
    { method: 'POST', body: JSON.stringify({ email, role_bundle }) },
  );
}

export async function deactivateCompanyUser(companyId: string, userId: string): Promise<PlatformCompanyUser> {
  return platformJson<PlatformCompanyUser>(
    `platform/companies/${encodeURIComponent(companyId)}/users/${encodeURIComponent(userId)}/deactivate`,
    { method: 'POST' },
  );
}

export async function getUsage(from: string, to: string): Promise<readonly PlatformUsage[]> {
  const query = new URLSearchParams({ from, to });
  const data = await platformJson<PlatformUsageResponse>(`platform/usage?${query.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

/** Platform-level LLM provider configuration as returned by `GET /platform/providers`. */
export type PlatformLlmProvider = components['schemas']['PlatformLlmProvider'];

/** OpenAPI currently has no success schema for the provider test endpoint. */
export interface ProviderProbeView {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

/** Provider update has no documented request body schema yet. */
export interface ProviderUpsertInput {
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly is_default: boolean;
  /** Write-only: absent or null leaves the stored secret untouched. */
  readonly api_key?: string | null;
}

export async function listProviderConfigs(): Promise<readonly PlatformLlmProvider[]> {
  const data = await platformJson<PlatformProvidersResponse>('platform/providers');
  return Array.isArray(data.providers) ? data.providers : [];
}

export async function saveProviderConfig(
  providerId: string,
  input: ProviderUpsertInput,
): Promise<PlatformLlmProvider> {
  return platformJson<PlatformLlmProvider>(`platform/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function testProviderConnection(providerId: string): Promise<ProviderProbeView> {
  return platformJson<ProviderProbeView>(`platform/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  });
}

/** OpenAPI owns the common catalog statistics; console-only fields stay layered on its item schema. */
export type PlatformSkillCatalogEntry = components['schemas']['PlatformSkillCatalogItem'] & {
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: string;
  readonly required_authority: string;
  readonly autonomy_class: string;
  readonly completion: string;
  readonly allowed_agents: readonly string[];
  readonly connector_kinds: readonly string[];
  readonly retired: boolean;
  readonly contract_version: string;
};

export type PlatformSkillCatalogResponse = Omit<components['schemas']['PlatformSkillCatalogResponse'], 'catalog'> & {
  readonly catalog: readonly PlatformSkillCatalogEntry[];
};

export async function listSkillCatalog(): Promise<readonly PlatformSkillCatalogEntry[]> {
  const data = await platformJson<PlatformSkillCatalogResponse>('platform/skill-catalog');
  return Array.isArray(data.catalog) ? data.catalog : [];
}

/** The entitlement mutation currently has no success response schema. */
export interface PlatformSkillEntitlement {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly enabled: boolean;
  readonly version: string;
}

/** Per-company entitlement toggle (`PUT /platform/skill-catalog/:id/entitlement/:tenant_id`). */
export async function setSkillEntitlement(
  skillId: string,
  tenantId: string,
  entitled: boolean,
  version: string | null,
): Promise<PlatformSkillEntitlement> {
  const data = await platformJson<{ entitlement: PlatformSkillEntitlement }>(
    `platform/skill-catalog/${encodeURIComponent(skillId)}/entitlement/${encodeURIComponent(tenantId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitled, version }),
    },
  );
  return data.entitlement;
}

/** Changes the signed-in operator's password when the console uses database identity (T9.2). */
export async function changePlatformPassword(currentPassword: string, newPassword: string): Promise<void> {
  await platformJson<{ changed: boolean }>('auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

/**
 * Tenant-console type surface for the /api/v1 client.
 * Schema-backed DTOs alias @agentos/api-contract; local shapes remain only where no matching schema exists.
 */

import type { components } from '@agentos/api-contract';
import type { TaskLifecycleState } from '@agentos/ui-foundation';

export type { AuthSession, Permission, TenantMembership, UserIdentity } from '@agentos/ui-foundation/auth';
export type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalDetailResponse,
  ApprovalQueueItem,
  CompanyActivityItem,
  CompanyActivityResponse,
  CompanyAiTeamAgent,
  CompanyAiTeamResponse,
  CompanyAttentionItem,
  CompanyAttentionResponse,
  CompanyGovernanceResponse,
  CompanyIntegrationItem,
  CompanyIntegrationsResponse,
  CompanyOverviewResponse,
  GetApprovalsParams,
  GetApprovalsResponse,
} from '@agentos/api-contract';

// R14: Approval Center
export type ApprovalDecision = components['schemas']['ApprovalDecisionRequest']['decision'];
export type ApprovalDecisionStatus = components['schemas']['ApprovalDecisionResponse']['status'];
/** UI status vocabulary includes presentation states not present in the API's approval status enum. */
export type ApprovalStatus =
  | 'AWAITING_HUMAN'
  | 'PENDING'
  | 'PAUSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCELLED'
  | 'QUEUED';

/** Governance response schema shared with the API; the contract owns its optional timestamp. */
export type CompanyGovernanceSettings = components['schemas']['CompanyGovernanceResponse'];

export type GovernanceSettingsResponse = CompanyGovernanceSettings;

// R15: Customer 360 timeline
export type CustomerTimelineParams = components['schemas']['CustomerTimelineParams'];
export type TimelineEntry = components['schemas']['CustomerTimelineEntry'];

export type CustomerTimelineEntry = TimelineEntry;

export type CustomerTimelineResponse = components['schemas']['CustomerTimelineResponse'];

// SCR-005: Conversation takeover and messaging
export type TakeoverMode = components['schemas']['ConversationTakeoverRequest']['takeover_mode'];
export type ConversationWireStatus = 'ACTIVE' | 'HUMAN_TAKEOVER' | 'CLOSED';

export type ConversationTakeoverRequest = components['schemas']['ConversationTakeoverRequest'];
export type ConversationTakeoverResponse = components['schemas']['ConversationTakeoverResponse'];
export type ConversationTakeoverHeartbeatRequest = components['schemas']['ConversationTakeoverHeartbeatRequest'];
export type ConversationTakeoverHeartbeatResponse = components['schemas']['ConversationTakeoverHeartbeatResponse'];
export type ConversationResumeRequest = components['schemas']['ConversationResumeRequest'];
export type ConversationResumeResponse = components['schemas']['ConversationResumeResponse'];
export type ConversationListParams = components['schemas']['ConversationListParams'];
export type ConversationListResponse = components['schemas']['ConversationListResponse'];
export type ConversationMessagesResponse = components['schemas']['ConversationMessagesResponse'];
export type ConversationSummaryResponse = components['schemas']['ConversationSummaryResponse'];
export type ConversationOperatorMessageResponse = components['schemas']['ConversationOperatorMessageResponse'];
export interface CustomerListParams {
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}
export interface CustomerListResponse {
  readonly items: readonly Record<string, unknown>[];
  readonly next_cursor?: string | null | undefined;
  readonly nextCursor?: string | null | undefined;
}
export interface CustomerProfileResponse extends Record<string, unknown> {}
export type PostMessageRequest = components['schemas']['ConversationOperatorMessageRequest'];

// Durable task acknowledgement and storefront integration
export interface TaskAcceptedResponse {
  readonly task_id: string;
  readonly conversation_id: string | null;
  readonly status: TaskLifecycleState;
  readonly task_version: number;
  readonly correlation_id: string;
}

// T6.9: connector catalog, binding and probe DTOs returned by /company/integrations.
export type ConnectorStatusCode = components['schemas']['CompanyIntegrationItem']['status'];
export type ProbeCheckOutcome = 'PASS' | 'FAIL';

export interface ConnectorProbeCheck {
  readonly probe: string;
  readonly outcome: ProbeCheckOutcome;
  readonly latency_ms: number;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

export interface ConnectorProbeResult {
  readonly outcome: ProbeCheckOutcome;
  readonly checks: readonly ConnectorProbeCheck[];
}

export interface ConnectorSecretDescription {
  readonly fingerprint: string;
  readonly last4: string;
}

export interface ConnectorProbeSummary {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
  readonly probed_at: string | null;
}

export interface ConnectorBinding {
  readonly status: string;
  readonly mode: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly bound_at: string;
  readonly probe: ConnectorProbeSummary | null;
  readonly secret: ConnectorSecretDescription | null;
}

/** OpenAPI owns the documented identity and state; the console consumes additional connector metadata. */
export type CompanyConnectorItem = components['schemas']['CompanyIntegrationItem'] & {
  readonly probe?: ConnectorProbeSummary | undefined;
  readonly connector_id: string;
  readonly display_key: string;
  readonly catalog_category: string;
  readonly integrated: boolean;
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly auth_schemes: readonly string[];
  readonly probes: readonly string[];
  readonly binding: ConnectorBinding | null;
};

export type CompanyConnectorsResponse = Omit<components['schemas']['CompanyIntegrationsResponse'], 'items'> & {
  readonly items: readonly CompanyConnectorItem[];
};

export interface ConnectorUpdateRequest {
  readonly config: Readonly<Record<string, unknown>>;
  readonly secret?: string | undefined;
}

export interface ConnectorUpdateResponse {
  readonly binding: ConnectorBinding;
}

export interface ConnectorTestResponse extends ConnectorProbeResult {
  readonly binding: ConnectorBinding;
}

// R16: Company settings (profile, governance, LLM)
export interface BrandProfile {
  readonly voice?: string | undefined;
  readonly prohibited_claims_url?: string | undefined;
  readonly logo_url?: string | undefined;
}

export interface CompanyProfileResponse {
  readonly tenant_id: string;
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: BrandProfile;
  readonly version: number;
  readonly updated_at: string;
}

export interface CompanyProfileUpdateRequest {
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: BrandProfile;
}

export type CompanyGovernanceUpdateRequest = components['schemas']['CompanyGovernanceUpdateRequest'];

export type StructuredMode = 'json_object' | 'json_schema';

export interface CompanyLlmEffective {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: StructuredMode;
  readonly secret_configured: boolean;
}

export interface CompanyLlmResponse {
  readonly tenant_id: string;
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id: string | null;
  readonly base_url: string | null;
  readonly reasoning_model: string | null;
  readonly fast_model: string | null;
  readonly timeout_ms: number | null;
  readonly structured_mode: StructuredMode | null;
  readonly monthly_token_budget: number | null;
  readonly secret_configured: boolean;
  readonly config_version: string | null;
  readonly updated_at: string | null;
  readonly effective: CompanyLlmEffective | null;
}

export interface CompanyLlmUpdateRequest {
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id?: string | null | undefined;
  readonly base_url?: string | null | undefined;
  readonly reasoning_model?: string | null | undefined;
  readonly fast_model?: string | null | undefined;
  readonly timeout_ms?: number | null | undefined;
  readonly structured_mode?: StructuredMode | null | undefined;
  readonly monthly_token_budget?: number | null | undefined;
  readonly api_key?: string | undefined;
}

export interface LlmProbeResult {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

// T6.4 AI Team per-domain activation and T4.6 skills management.

export type AiTeamDomain = 'marketing' | 'sales' | 'care';
export type AiTeamActivationAction = 'activate' | 'pause' | 'resume';
export type AiTeamActivationStatus = components['schemas']['CompanyAiTeamDomainResponse']['activation_status'];

export type AiTeamPrerequisite = components['schemas']['CompanyAiTeamPrerequisite'];

export type AiTeamDomainResponse = components['schemas']['CompanyAiTeamDomainResponse'];

export type SkillAvailabilityReason =
  | 'OK'
  | 'NOT_CONFIGURED'
  | 'DISABLED_BY_TENANT'
  | 'MISSING_CONFIGURATION'
  | 'CONNECTOR_UNBOUND'
  | 'NO_ASSIGNED_AGENT'
  | 'RETIRED';

export interface SkillAvailability {
  readonly available: boolean;
  readonly status: string;
  readonly reason: SkillAvailabilityReason;
}

export interface CompanySkill {
  readonly skill_id: string;
  readonly display_key: string;
  readonly domain: string;
  readonly effect_class: 'READ' | 'EFFECT' | 'APPROVAL' | 'INTERNAL';
  readonly required_authority: string;
  readonly autonomy_class: 'NEVER' | 'PROMOTABLE';
  readonly completion: 'SYNC' | 'AWAITS_HUMAN';
  readonly connector_kinds: readonly string[];
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly allowed_agents: readonly string[];
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly connector_id: string | null;
  readonly version: string | null;
  readonly assigned_agents: readonly string[];
  readonly availability: SkillAvailability;
}

export interface SkillsResponse {
  readonly skills: readonly CompanySkill[];
}

export interface SkillSettingsUpdateRequest {
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly connector_id: string | null;
  readonly version: string | null;
}

export interface SkillTestResult {
  readonly test_id: string;
  readonly skill_id: string;
  readonly mode: 'READ_DISPATCH' | 'CONNECTOR_DRY_RUN';
  readonly outcome: 'PASS' | 'FAIL' | 'REFUSED';
  readonly latency_ms: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly tested_by: string;
  readonly tested_at: string;
}

export interface SkillTestResponse {
  readonly result: SkillTestResult;
}

export interface SkillHealthSnapshot {
  readonly window_start: string;
  readonly success_count: number;
  readonly failure_count: number;
  readonly refusal_count: number;
  readonly awaiting_human_count: number;
  readonly success_rate: number | null;
  readonly avg_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly last_activity_at: string | null;
  readonly last_error_class: string | null;
}

export interface SkillHealthResponse {
  readonly health: SkillHealthSnapshot;
  readonly recent_tests: readonly SkillTestResult[];
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST' | null;
}

// T6.10: company analytics contract returned by GET /company/analytics.
export type CompanyAnalyticsWindow = '24h' | '7d' | '30d';
export type CompanyAnalyticsSourceStatus = 'OK' | 'NO_DATA' | 'NOT_INTEGRATED';

export interface CompanyAnalyticsBreakdownEntry {
  readonly key: string;
  readonly value: number;
}

export interface CompanyAnalyticsKpi {
  readonly key: string;
  readonly kind: 'NUMBER' | 'PERCENT' | 'DURATION_MS' | 'BREAKDOWN';
  readonly value: number | null;
  readonly unit: 'count' | 'percent' | 'ms';
  readonly source_status: CompanyAnalyticsSourceStatus;
  readonly as_of: string;
  readonly note?: string | undefined;
  readonly breakdown?: readonly CompanyAnalyticsBreakdownEntry[] | undefined;
  readonly detail?: Readonly<Record<string, number>> | undefined;
}

export interface CompanyAnalyticsResponse {
  readonly window: CompanyAnalyticsWindow;
  readonly as_of: string;
  readonly kpis: readonly CompanyAnalyticsKpi[];
}

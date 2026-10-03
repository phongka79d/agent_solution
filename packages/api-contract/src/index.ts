import type { components, paths } from './schema.js';

export type { components, paths } from './schema.js';

export type CompanyAttentionItem = components['schemas']['CompanyAttentionItem'];
export type CompanyAttentionResponse = components['schemas']['CompanyAttentionResponse'];
export type CompanyAiTeamAgent = components['schemas']['CompanyAiTeamAgent'];
export type CompanyAiTeamResponse = components['schemas']['CompanyAiTeamResponse'];
export type CompanyActivityItem = components['schemas']['CompanyActivityItem'];
export type CompanyActivityResponse = components['schemas']['CompanyActivityResponse'];
export type CompanyIntegrationItem = components['schemas']['CompanyIntegrationItem'];
export type CompanyIntegrationsResponse = components['schemas']['CompanyIntegrationsResponse'];
export type CompanyOverviewResponse = components['schemas']['CompanyOverviewResponse'];
export type CompanyGovernanceResponse = components['schemas']['CompanyGovernanceResponse'];

export type ApprovalDecision = components['schemas']['ApprovalDecisionRequest']['decision'];
export type ApprovalQueueItem = components['schemas']['ApprovalQueueItem'];
export type GetApprovalsParams = NonNullable<paths['/api/v1/approvals']['get']['parameters']['query']>;
export type ApprovalListResponse = components['schemas']['ApprovalListResponse'];
export type GetApprovalsResponse = ApprovalListResponse;
export type ApprovalDetailResponse = components['schemas']['ApprovalDetailResponse'];
export type ApprovalDecisionRequest = components['schemas']['ApprovalDecisionRequest'];
export type ApprovalDecisionResponse = components['schemas']['ApprovalDecisionResponse'];

export type PlatformTenant = components['schemas']['PlatformTenant'];
export type PlatformReadiness = components['schemas']['PlatformReadiness'];
export type PlatformUsage = components['schemas']['PlatformUsage'];
export type PlatformProvider = components['schemas']['PlatformProvider'];
export type PlatformTenantsResponse = components['schemas']['PlatformTenantsResponse'];
export type PlatformUsageResponse = components['schemas']['PlatformUsageResponse'];
export type PlatformProvidersResponse = components['schemas']['PlatformProvidersResponse'];

export type ApiComponents = components['schemas'];

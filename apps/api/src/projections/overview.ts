import type {
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyConnectorProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyOwnerInputProjectionSource,
  CompanyReconciliationProjectionSource,
  CompanyRunProjectionSource,
} from '@agentos/database';
import { mapAiTeam, type AiTeamAgent, type AiTeamProjectionSources } from './ai-team.js';
import { mapAttention, type AttentionItem } from './attention.js';
import { mapActivity, type ActivityItem, type ActivityPageOptions, type ActivityProjectionSources } from './activity.js';

export interface OverviewMetricsSource {
  readonly runs?: number | null;
  readonly completed_runs?: number | null;
  readonly revenue?: number | null;
}

export interface OverviewProviderSource {
  readonly configured: boolean;
  readonly provider?: string | null;
}

export interface OverviewProjectionSources extends ActivityProjectionSources {
  readonly approvals?: readonly (CompanyApprovalProjectionSource & { readonly domain?: 'marketing' | 'sales' | 'care' | 'platform' | null })[];
  readonly handoffs?: readonly (CompanyHandoffProjectionSource & { readonly domain?: 'marketing' | 'sales' | 'care' | 'platform' | null })[];
  readonly connectors?: readonly CompanyConnectorProjectionSource[];
  readonly owner_inputs?: readonly CompanyOwnerInputProjectionSource[];
  readonly reconciliations?: readonly CompanyReconciliationProjectionSource[];
  readonly agents?: readonly CompanyAgentProjectionSource[];
  readonly enabled_modules?: readonly string[];
  readonly module_capabilities?: AiTeamProjectionSources['module_capabilities'];
  readonly runs_today?: readonly CompanyRunProjectionSource[];
  readonly provider?: OverviewProviderSource;
  readonly metrics?: OverviewMetricsSource;
}

export interface OverviewProjection {
  readonly attention: readonly AttentionItem[];
  readonly agents: readonly AiTeamAgent[];
  readonly activity: readonly ActivityItem[];
  readonly metrics?: Readonly<Record<string, number>>;
}

export function mapOverview(
  sources: OverviewProjectionSources,
  activityOptions?: ActivityPageOptions,
): OverviewProjection {
  const activity = mapActivity(sources, activityOptions);
  const aiTeamSources: AiTeamProjectionSources = {
    ...(sources.agents === undefined ? {} : { agents: sources.agents }),
    ...(sources.enabled_modules === undefined ? {} : { enabled_modules: sources.enabled_modules }),
    ...(sources.module_capabilities === undefined ? {} : { module_capabilities: sources.module_capabilities }),
    ...(sources.runs_today === undefined ? {} : { runs_today: sources.runs_today }),
    ...(sources.approvals === undefined
      ? {}
      : {
          approvals: sources.approvals.map(({ domain, ...approval }) => ({
            ...approval,
            ...(domain === 'marketing' || domain === 'sales' || domain === 'care' ? { domain } : {}),
          })),
        }),
    ...(sources.handoffs === undefined
      ? {}
      : {
          handoffs: sources.handoffs.map(({ domain, ...handoff }) => ({
            ...handoff,
            ...(domain === 'marketing' || domain === 'sales' || domain === 'care' ? { domain } : {}),
          })),
        }),
    ...(sources.provider === undefined ? {} : { provider: { configured: sources.provider.configured } }),
  };
  const response: OverviewProjection = {
    attention: mapAttention(sources),
    agents: mapAiTeam(aiTeamSources),
    activity: activity.items,
  };
  const metricsSource = sources.metrics;
  if (metricsSource === undefined) return response;
  const metrics: Record<string, number> = {};
  if (typeof metricsSource.runs === 'number' && Number.isFinite(metricsSource.runs)) metrics.runs = metricsSource.runs;
  if (typeof metricsSource.completed_runs === 'number' && Number.isFinite(metricsSource.completed_runs)) metrics.completed_runs = metricsSource.completed_runs;
  if (typeof metricsSource.revenue === 'number' && Number.isFinite(metricsSource.revenue)) metrics.revenue = metricsSource.revenue;
  return Object.keys(metrics).length === 0 ? response : { ...response, metrics };
}

export const projectOverview = mapOverview;

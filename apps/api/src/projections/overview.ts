import type {
  CompanyActivityProjectionSource,
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyCampaignProjectionSource,
  CompanyConnectorProjectionSource,
  CompanyConversationProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyOwnerInputProjectionSource,
  CompanyReconciliationProjectionSource,
  CompanyRunProjectionSource,
} from '@agentos/database';
import {
  mapAiTeamStrip,
  type AiTeamCapabilitySource,
  type AiTeamProjectionSources,
  type AiTeamStripEntry,
} from './ai-team.js';
import {
  groupAttention,
  mapAttention,
  type AttentionGroup,
  type AttentionProviderSource,
  type CompanyDomain,
  type CompanyParkedDraftProjectionSource,
} from './attention.js';
import { mapActivity, type ActivityItem, type ActivityPageOptions, type ActivityProjectionSources } from './activity.js';

export type OverviewSection = 'attention' | 'ai_team' | 'today' | 'activity' | 'workspace';
export type SectionStatus = 'OK' | 'ERROR';

export interface TodayMetric {
  readonly key: 'conversations' | 'ai_resolved' | 'handed_to_staff' | 'approvals_pending' | 'campaigns_by_state';
  readonly count: number;
  readonly updated_at: string;
  readonly params?: Readonly<Record<string, string>>;
}
export interface TodaySection {
  readonly updated_at: string;
  readonly metrics: readonly TodayMetric[];
}

export interface WorkspaceChecklistItem {
  readonly key: string;
  readonly label_key: string;
  readonly done: boolean;
  readonly href: string;
}
export interface WorkspaceSection {
  readonly status: string;
  readonly checklist: readonly WorkspaceChecklistItem[];
}

/** Observed workspace readiness flags assembled by the route from shell, connectors and providers. */
export interface WorkspaceOverviewSource {
  readonly status: string;
  readonly profile_ready: boolean;
  readonly erp_ready: boolean;
  readonly knowledge_ready: boolean;
  readonly llm_ready: boolean;
  readonly channels_ready: boolean;
  readonly test_agents_ready: boolean;
}

export interface OverviewProjectionSources {
  readonly approvals?: readonly (CompanyApprovalProjectionSource & { readonly domain?: CompanyDomain | null })[];
  readonly handoffs?: readonly (CompanyHandoffProjectionSource & { readonly domain?: CompanyDomain | null })[];
  readonly connectors?: readonly CompanyConnectorProjectionSource[];
  readonly owner_inputs?: readonly CompanyOwnerInputProjectionSource[];
  readonly reconciliations?: readonly CompanyReconciliationProjectionSource[];
  readonly parked_drafts?: readonly CompanyParkedDraftProjectionSource[];
  readonly agents?: readonly CompanyAgentProjectionSource[];
  readonly enabled_modules?: readonly string[];
  readonly module_capabilities?: readonly AiTeamCapabilitySource[];
  readonly runs_today?: readonly CompanyRunProjectionSource[];
  readonly conversations_today?: readonly CompanyConversationProjectionSource[];
  readonly campaigns_today?: readonly CompanyCampaignProjectionSource[];
  readonly provider?: AttentionProviderSource;
  readonly activity?: readonly CompanyActivityProjectionSource[];
  readonly workspace?: WorkspaceOverviewSource;
}

export interface OverviewProjection {
  readonly attention: readonly AttentionGroup[];
  readonly ai_team: readonly AiTeamStripEntry[];
  readonly today?: TodaySection;
  readonly activity: readonly ActivityItem[];
  readonly workspace?: WorkspaceSection;
  /** Per-section outcome so the UI can show a scoped error with retry instead of a blank page. */
  readonly sections: Readonly<Record<OverviewSection, SectionStatus>>;
}

const WORKSPACE_CHECKLIST: readonly { key: string; label_key: string; href: string; flag: keyof WorkspaceOverviewSource }[] = [
  { key: 'profile', label_key: 'overview.checklist.profile', href: '/settings', flag: 'profile_ready' },
  { key: 'erp', label_key: 'overview.checklist.erp', href: '/integrations', flag: 'erp_ready' },
  { key: 'knowledge', label_key: 'overview.checklist.knowledge', href: '/knowledge', flag: 'knowledge_ready' },
  { key: 'llm', label_key: 'overview.checklist.llm', href: '/integrations', flag: 'llm_ready' },
  { key: 'channels', label_key: 'overview.checklist.channels', href: '/integrations', flag: 'channels_ready' },
  { key: 'agents', label_key: 'overview.checklist.agents', href: '/ai-team', flag: 'test_agents_ready' },
];

function maxIso(values: readonly string[]): string {
  let max = '';
  for (const value of values) if (value > max) max = value;
  return max;
}

function startOfTodayIso(now: Date): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString();
}

function todayMetrics(sources: OverviewProjectionSources, now: Date): readonly TodayMetric[] {
  const metrics: TodayMetric[] = [];
  const conversations = sources.conversations_today;
  if (conversations !== undefined && conversations.length > 0) {
    metrics.push({ key: 'conversations', count: conversations.length, updated_at: maxIso(conversations.map((row) => row.occurred_at)) });
  }
  const runs = sources.runs_today;
  const resolved = runs?.filter((run) => run.state.toLowerCase() === 'completed') ?? [];
  if (runs !== undefined && resolved.length > 0) {
    metrics.push({ key: 'ai_resolved', count: resolved.length, updated_at: maxIso(resolved.map((run) => run.occurred_at)) });
  }
  const handoffs = sources.handoffs;
  const since = startOfTodayIso(now);
  const handed = handoffs?.filter((handoff) => handoff.created_at >= since) ?? [];
  if (handoffs !== undefined && handed.length > 0) {
    metrics.push({ key: 'handed_to_staff', count: handed.length, updated_at: maxIso(handed.map((handoff) => handoff.created_at)) });
  }
  const approvals = sources.approvals;
  if (approvals !== undefined && approvals.length > 0) {
    metrics.push({
      key: 'approvals_pending',
      count: approvals.length,
      updated_at: maxIso(approvals.map((approval) => approval.created_at)),
    });
  }
  const campaigns = sources.campaigns_today;
  if (campaigns !== undefined && campaigns.length > 0) {
    const byState = new Map<string, CompanyCampaignProjectionSource[]>();
    for (const campaign of campaigns) {
      const rows = byState.get(campaign.state);
      if (rows === undefined) byState.set(campaign.state, [campaign]);
      else rows.push(campaign);
    }
    for (const [state, rows] of byState) {
      metrics.push({
        key: 'campaigns_by_state',
        count: rows.length,
        updated_at: maxIso(rows.map((row) => row.updated_at)),
        params: { state },
      });
    }
  }
  return metrics;
}

function workspaceSection(source: WorkspaceOverviewSource | undefined): WorkspaceSection | undefined {
  if (source === undefined || source.status.toUpperCase() === 'ACTIVE') return undefined;
  const checklist: WorkspaceChecklistItem[] = WORKSPACE_CHECKLIST.map((item) => ({
    key: item.key,
    label_key: item.label_key,
    href: item.href,
    done: source[item.flag] === true,
  }));
  checklist.push({ key: 'activate', label_key: 'overview.checklist.activate', href: '/settings', done: false });
  return { status: source.status, checklist };
}

/** Builds every Overview section independently so one failure never blanks the others. */
export function mapOverview(
  sources: OverviewProjectionSources,
  activityOptions?: ActivityPageOptions,
  now: Date = new Date(),
): OverviewProjection {
  let attention: readonly AttentionGroup[] = [];
  let ai_team: readonly AiTeamStripEntry[] = [];
  let today: TodaySection | undefined;
  let activity: readonly ActivityItem[] = [];
  let workspace: WorkspaceSection | undefined;
  const sections: Record<OverviewSection, SectionStatus> = {
    attention: 'OK', ai_team: 'OK', today: 'OK', activity: 'OK', workspace: 'OK',
  };

  try {
    attention = groupAttention(mapAttention(sources));
  } catch {
    sections.attention = 'ERROR';
  }
  try {
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
    ai_team = mapAiTeamStrip(aiTeamSources);
  } catch {
    sections.ai_team = 'ERROR';
  }
  try {
    const metrics = todayMetrics(sources, now);
    if (metrics.length > 0) today = { updated_at: maxIso(metrics.map((metric) => metric.updated_at)), metrics };
  } catch {
    sections.today = 'ERROR';
  }
  try {
    activity = mapActivity(sources as ActivityProjectionSources, activityOptions).items;
  } catch {
    sections.activity = 'ERROR';
  }
  try {
    workspace = workspaceSection(sources.workspace);
  } catch {
    sections.workspace = 'ERROR';
  }

  return {
    attention,
    ai_team,
    activity,
    sections,
    ...(today === undefined ? {} : { today }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

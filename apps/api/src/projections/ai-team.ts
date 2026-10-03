import type {
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyRunProjectionSource,
} from '@agentos/database';

export type AiTeamDomain = 'marketing' | 'sales' | 'care';
export type AiTeamReadiness = 'READY' | 'NOT_READY' | 'UNKNOWN';
export type AiTeamStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED' | 'NOT_READY' | 'NO_DATA';

export interface AiTeamAgent {
  readonly domain: AiTeamDomain;
  readonly status: AiTeamStatus;
  readonly enabled: boolean;
  readonly readiness: AiTeamReadiness;
  readonly runs_today?: number;
  readonly pending_approvals?: number;
  readonly open_handoffs?: number;
}

export interface AiTeamProviderSource {
  readonly configured: boolean;
}
export interface AiTeamCapabilitySource {
  readonly capability_id: string;
  readonly status: string;
}
export interface AiTeamProjectionSources {
  readonly agents?: readonly CompanyAgentProjectionSource[];
  readonly enabled_modules?: readonly string[];
  readonly module_capabilities?: readonly AiTeamCapabilitySource[];
  readonly runs_today?: readonly CompanyRunProjectionSource[];
  readonly approvals?: readonly (CompanyApprovalProjectionSource & { readonly domain?: AiTeamDomain | null })[];
  readonly handoffs?: readonly (CompanyHandoffProjectionSource & { readonly domain?: AiTeamDomain | null })[];
  readonly provider?: AiTeamProviderSource;
}

function domainOf(value: string | null | undefined): AiTeamDomain | null {
  const text = value?.toLowerCase() ?? '';
  if (text.includes('marketing') || text.includes('mkt')) return 'marketing';
  if (text.includes('sales') || text.includes('sal')) return 'sales';
  if (text.includes('care') || text.includes('support') || text.includes('cs')) return 'care';
  return null;
}

/** Projects the three company-facing agent domains without inventing missing counters. */
export function mapAiTeam(sources: AiTeamProjectionSources): readonly AiTeamAgent[] {
  const observedAgents: Partial<Record<AiTeamDomain, CompanyAgentProjectionSource[]>> = {};
  for (const agent of sources.agents ?? []) {
    const domain = domainOf(agent.domain);
    if (domain === null) continue;
    (observedAgents[domain] ??= []).push(agent);
  }

  return (['marketing', 'sales', 'care'] as const).map((domain) => {
    const domainAgents = observedAgents[domain];
    const capabilityRows = sources.module_capabilities?.filter((capability) => domainOf(capability.capability_id) === domain);
    const capability = capabilityRows?.[0];
    const capabilityEnabled = capabilityRows === undefined
      ? undefined
      : capability !== undefined && capability.status === 'ENABLED';
    const agentStatuses = domainAgents?.map((agent) =>
      agent.activation_status ?? (agent.is_active ? 'ACTIVE' : 'NOT_ACTIVATED'),
    );
    const agentsActive = agentStatuses !== undefined && agentStatuses.length > 0
      && agentStatuses.every((status) => status === 'ACTIVE');
    const agentsPaused = agentStatuses !== undefined && agentStatuses.length > 0
      && agentStatuses.every((status) => status === 'PAUSED');
    const explicitlyEnabled = (sources.enabled_modules ?? []).some((module) => {
      const normalized = domainOf(module);
      return normalized === domain || module.toLowerCase() === domain;
    });
    const fallbackEnabled = sources.enabled_modules === undefined
      ? agentsActive
      : explicitlyEnabled;
    const enabledFlag = capabilityEnabled === undefined
      ? fallbackEnabled
      : capabilityEnabled && (domainAgents === undefined || agentsActive);
    const providerConfigured = sources.provider?.configured;
    const capabilityReady = capabilityEnabled !== false;
    const readiness: AiTeamReadiness = !capabilityReady
      ? 'NOT_READY'
      : providerConfigured === undefined
        ? 'UNKNOWN'
        : providerConfigured
          ? 'READY'
          : 'NOT_READY';
    const paused = capability?.status === 'DISABLED' && agentsPaused;
    const missingAgents = sources.agents !== undefined && domainAgents?.length === 0;
    const partialActivation = capabilityEnabled === true && domainAgents !== undefined
      && domainAgents.length > 0 && !agentsActive;
    const status: AiTeamStatus = paused
      ? 'PAUSED'
      : missingAgents && capabilityEnabled === true
        ? 'NO_DATA'
        : partialActivation
          ? 'NOT_READY'
          : !enabledFlag
            ? 'DISABLED'
            : readiness === 'NOT_READY'
              ? 'NOT_READY'
              : 'ACTIVE';
    const runRows = (sources.runs_today ?? []).filter((run) => domainOf(run.domain) === domain);
    const approvalRows = (sources.approvals ?? []).filter((approval) => (approval.domain ?? domainOf(approval.skill_name)) === domain);
    const handoffRows = (sources.handoffs ?? []).filter((handoff) => (handoff.domain ?? 'care') === domain && handoff.status !== 'COMPLETED');
    const counters = {
      ...(sources.runs_today !== undefined && runRows.length > 0 ? { runs_today: runRows.length } : {}),
      ...(sources.approvals !== undefined && approvalRows.length > 0 ? { pending_approvals: approvalRows.length } : {}),
      ...(sources.handoffs !== undefined && handoffRows.length > 0 ? { open_handoffs: handoffRows.length } : {}),
    };
    return { domain, status, enabled: enabledFlag, readiness, ...counters };
  });
}

export const projectAiTeam = mapAiTeam;

/** One compact AI Team card on the Overview: status + reason + a single observed counter. */
export interface AiTeamStripEntry {
  readonly domain: AiTeamDomain;
  readonly status: AiTeamStatus;
  readonly reason_key: string;
  readonly counter_key?: 'runs_today' | 'pending_approvals' | 'open_handoffs';
  readonly counter_value?: number;
  readonly href: string;
}

function reasonKeyOf(agent: AiTeamAgent): string {
  if (agent.status === 'ACTIVE') return 'company.ai_team.reason.active';
  if (agent.status === 'PAUSED') return 'company.ai_team.reason.paused';
  if (agent.status === 'NO_DATA') return 'company.ai_team.reason.no_data';
  if (agent.status === 'DISABLED') return 'company.ai_team.reason.disabled';
  return agent.readiness === 'NOT_READY'
    ? 'company.ai_team.reason.not_ready'
    : 'company.ai_team.reason.unknown';
}

/** Maps the three AI domains to the Overview strip, omitting counters no source observed. */
export function mapAiTeamStrip(sources: AiTeamProjectionSources): readonly AiTeamStripEntry[] {
  return mapAiTeam(sources).map((agent) => {
    const counters: readonly ['runs_today' | 'pending_approvals' | 'open_handoffs', number | undefined][] = [
      ['runs_today', agent.runs_today],
      ['pending_approvals', agent.pending_approvals],
      ['open_handoffs', agent.open_handoffs],
    ];
    const observed = counters.find(([, value]) => value !== undefined && value > 0);
    return {
      domain: agent.domain,
      status: agent.status,
      reason_key: reasonKeyOf(agent),
      href: `/ai-team/${agent.domain}`,
      ...(observed === undefined ? {} : { counter_key: observed[0], counter_value: observed[1] as number }),
    };
  });
}

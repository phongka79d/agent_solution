import type {
  CompanyAgentProjectionSource,
  CompanyApprovalProjectionSource,
  CompanyHandoffProjectionSource,
  CompanyRunProjectionSource,
} from '@agentos/database';

export type AiTeamDomain = 'marketing' | 'sales' | 'care';
export type AiTeamReadiness = 'READY' | 'NOT_READY' | 'UNKNOWN';
export type AiTeamStatus = 'ACTIVE' | 'DISABLED' | 'NOT_READY' | 'NO_DATA';

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
  const observedAgents: Partial<Record<AiTeamDomain, CompanyAgentProjectionSource>> = {};
  for (const agent of sources.agents ?? []) {
    const domain = domainOf(agent.domain);
    if (domain !== null && observedAgents[domain] === undefined) observedAgents[domain] = agent;
  }

  return (['marketing', 'sales', 'care'] as const).map((domain) => {
    const sourceAgent = observedAgents[domain];
    const capabilityRows = sources.module_capabilities?.filter((capability) => domainOf(capability.capability_id) === domain);
    const capability = capabilityRows?.[0];
    const capabilityEnabled = capabilityRows === undefined
      ? undefined
      : capability !== undefined
        && capability.status !== 'UNCONFIGURED'
        && capability.status !== 'DISABLED';
    const explicitlyEnabled = (sources.enabled_modules ?? []).some((module) => {
      const normalized = domainOf(module);
      return normalized === domain || module.toLowerCase() === domain;
    });
    const enabledFlag = capabilityEnabled ?? (
      sources.enabled_modules === undefined
        ? sourceAgent?.is_active === true
        : explicitlyEnabled
    );
    const providerConfigured = sources.provider?.configured;
    const capabilityReady = capabilityEnabled !== false;
    const readiness: AiTeamReadiness = !capabilityReady
      ? 'NOT_READY'
      : providerConfigured === undefined
        ? 'UNKNOWN'
        : providerConfigured
          ? 'READY'
          : 'NOT_READY';
    const status: AiTeamStatus = !enabledFlag
      ? 'DISABLED'
      : readiness === 'NOT_READY'
        ? 'NOT_READY'
        : sourceAgent === undefined && sources.agents !== undefined
          ? 'NO_DATA'
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

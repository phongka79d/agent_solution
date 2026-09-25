import { computeEffectKey, computeRequestFingerprint, evaluateAuthorityVerdict } from '@agentos/core-engine';
import {
  DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT,
  createPlatformSkillRegistry,
  createSkillRuntimeEngine,
} from '@agentos/skills';

import { createCareSkillDispatcher } from './dispatcher.js';
import { createCareSkillToolPort } from './tool-port.js';
import type { CareSkillOptions, CareSkillServices } from './types.js';

export type { CareSkillEnv, CareSkillOptions, CareSkillServices, VerifiedCustomerIdentity } from './types.js';
export { CareSkillToolError, createCareSkillToolPort } from './tool-port.js';
export { createCareSkillDispatcher } from './dispatcher.js';

/**
 * Creates the platform Care skill services, including the platform skill registry
 * bound to the Care tool port, the SkillRuntimeEngine, and the adapter dispatcher.
 *
 * @param options Dependencies and environment configuration for Care skills.
 * @returns The registry, tool port, dispatcher, and unbound capabilities list.
 */
export function createCareSkillServices(options: CareSkillOptions): CareSkillServices {
  const tool_port = createCareSkillToolPort(options);
  const clock = options.now ?? (() => new Date());
  const registry = createPlatformSkillRegistry({ tools: tool_port, clock }, options.skill_enablement);

  const engine = createSkillRuntimeEngine({
    registry,
    digestPayload: (payload) => computeRequestFingerprint(payload as Record<string, unknown>),
    deriveEffectKey: (identity) => computeEffectKey(identity),
    evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
    ...(options.now ? { now: () => options.now!().getTime() } : {}),
  });

  const dispatcher = createCareSkillDispatcher({
    engine,
    resolve_correlation_id: options.resolve_correlation_id,
    resolve_grant: options.resolve_grant,
    ...(options.erp_read && typeof (options.erp_read as any).reconcile === 'function'
      ? { erp_reconcile: (input) => (options.erp_read as any).reconcile(input) }
      : {}),
  });

  const unbound: string[] = [];
  if (!options.erp_read) {
    unbound.push('API-001.OrderConnector: no ERP read connector is bound (erp_read is null)');
  }
  const caseManagementEnabled = (
    options.skill_enablement ?? DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT
  ).enabled_skill_ids.includes('skill.care.manage_case');
  if (caseManagementEnabled && !options.case_sla_target_hours) {
    unbound.push('PostgreSQL.CaseManagementStore: no tenant-specific SLA policy is bound; case creation and priority changes refuse');
  }
  return {
    registry,
    tool_port,
    dispatcher,
    unbound,
  };
}

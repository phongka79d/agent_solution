import { computeEffectKey, computeRequestFingerprint, evaluateAuthorityVerdict } from '@agentos/core-engine';
import { createSalesSkills, createSkillRegistry, createSkillRuntimeEngine } from '@agentos/skills';

import { createSalesSkillDispatcher } from './dispatcher.js';
import { createSalesSkillToolPort } from './tool-port.js';
import type { SalesSkillOptions, SalesSkillServices } from './types.js';

export type {
  SalesContextAggregatorLike,
  SalesRecommendationRevenueEvidence,
  SalesRecommendationRevenueEvidencePort,
  SalesSkillOptions,
  SalesSkillServices,
} from './types.js';
export { SalesSkillToolError, createSalesSkillToolPort } from './tool-port.js';
export { createSalesSkillDispatcher } from './dispatcher.js';

const ENABLED_SALES_SKILLS: ReadonlySet<string> = new Set([
  'skill.sales.search_product',
  'skill.sales.check_stock',
  'skill.sales.retrieve_customer',
  'skill.sales.recommend_product',
]);

export function createSalesSkillServices(options: SalesSkillOptions): SalesSkillServices {
  const tool_port = createSalesSkillToolPort({
    erp_read: options.erp_read,
    context: options.context,
    ...(options.revenue_evidence === undefined ? {} : { revenue_evidence: options.revenue_evidence }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const clock = options.now ?? (() => new Date());
  const registry = createSkillRegistry();
  for (const row of createSalesSkills({ tools: tool_port, clock })) {
    registry.register({ ...row, enabled: ENABLED_SALES_SKILLS.has(row.skill_id) });
  }
  const engine = createSkillRuntimeEngine({
    registry,
    digestPayload: (payload) => computeRequestFingerprint(payload as Record<string, unknown>),
    deriveEffectKey: (identity) => computeEffectKey(identity),
    evaluateAuthority: (granted, required) => evaluateAuthorityVerdict(granted, required),
    ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
  });
  const dispatcher = createSalesSkillDispatcher({
    engine,
    resolve_correlation_id: options.resolve_correlation_id,
    resolve_grant: options.resolve_grant,
  });

  const unbound: string[] = [];
  if (options.erp_read === null) {
    unbound.push('API-001 catalog/inventory: no ERP read connector is bound');
  }
  if (options.revenue_evidence === undefined) {
    unbound.push('Core.RecommendationEngine revenue evidence: no owner-approved revenue model is bound');
  }

  return { registry, tool_port, dispatcher, unbound };
}

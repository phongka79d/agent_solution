/**
 * @file The 23 platform skill rows of `implement/05` §4, composed into a runtime registry.
 *
 * Enablement is a gate decision, not an effect-class inference. The default keeps the historical
 * Gate P0 posture as an explicit allowlist; callers for a later gate must pass that gate's own
 * allowlist. A disabled row still resolves and carries its full contract, but refuses at dispatch.
 */

import type { ISkillContract, PlatformSkillDependencies, PlatformSkillRow } from '../contracts/index.js';
import { createSkillRegistry, type SkillRegistry } from '../registry.js';
import { createCareSkills } from './care/index.js';
import { createMarketingSkills } from './mkt/index.js';
import { createSalesSkills } from './sales/index.js';
export { createSalesSkills } from './sales/index.js';

/** Explicit gate input consumed by the registry factory. Unknown ids simply enable no row. */
export interface PlatformSkillEnablement {
  readonly enabled_skill_ids: readonly string[];
}

/** Gate P0 allowlist: the rows approved for the foundation/read-only gate. */
export const DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT: PlatformSkillEnablement = Object.freeze({
  enabled_skill_ids: Object.freeze([
    'skill.mkt.analyze_market_signal',
    'skill.mkt.check_consent',
    'skill.mkt.audit_brand_compliance',
    'skill.mkt.evaluate_attribution',
    'skill.sales.search_product',
    'skill.sales.check_stock',
    'skill.sales.check_price',
    'skill.sales.retrieve_customer',
    'skill.sales.recommend_product',
    'skill.care.search_faq',
    'skill.care.lookup_order',
    'skill.care.track_shipping',
    'skill.care.analyze_churn_risk',
  ]),
});

/** The §4 registry order: seven Marketing rows, eight Sales rows, eight Care rows. */
export function createPlatformSkills(
  deps: PlatformSkillDependencies,
  enablement: PlatformSkillEnablement = DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT,
): readonly ISkillContract[] {
  const rows: readonly PlatformSkillRow[] = [
    ...createMarketingSkills(deps),
    ...createSalesSkills(deps),
    ...createCareSkills(deps),
  ];
  const enabledSkillIds = new Set(enablement.enabled_skill_ids);

  return rows.map((row) => ({ ...row, enabled: enabledSkillIds.has(row.skill_id) }));
}

/**
 * Builds the registry holding every platform row.
 *
 * @param deps The injected tool seam and clock the rows are bound to.
 * @param enablement The explicit gate allowlist; it never derives enablement from effect class.
 * @returns A registry whose rows all passed the §6.1 registration invariants.
 */
export function createPlatformSkillRegistry(
  deps: PlatformSkillDependencies,
  enablement: PlatformSkillEnablement = DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT,
): SkillRegistry {
  const registry = createSkillRegistry();
  for (const row of createPlatformSkills(deps, enablement)) {
    registry.register(row);
  }
  return registry;
}

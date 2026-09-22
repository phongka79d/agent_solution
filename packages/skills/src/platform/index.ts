/**
 * @file The 23 platform skill rows of `implement/05` §4, composed into a runtime registry.
 *
 * Enablement is decided here rather than per row, so the gate's scope is stated once: Gate P0
 * registers all 23 rows and enables the read-only class, because P0 disables every external effect
 * (`implement/09` Gate P0, `implement/05` §7 "Registry foundation: all 23 rows registered, read-only
 * classes enabled"). A disabled row still resolves and still carries its full contract; it refuses
 * at dispatch with `SKILL_DISABLED` instead of degrading to an unguarded fallback.
 */

import type { ISkillContract, PlatformSkillDependencies, PlatformSkillRow } from '../contracts/index.js';
import { createSkillRegistry, type SkillRegistry } from '../registry.js';
import { createCareSkills } from './care/index.js';
import { createMarketingSkills } from './mkt/index.js';
import { createSalesSkills } from './sales/index.js';

/** The §4 registry order: seven Marketing rows, eight Sales rows, eight Care rows. */
export function createPlatformSkills(deps: PlatformSkillDependencies): readonly ISkillContract[] {
  const rows: readonly PlatformSkillRow[] = [
    ...createMarketingSkills(deps),
    ...createSalesSkills(deps),
    ...createCareSkills(deps),
  ];

  return rows.map((row) => ({ ...row, enabled: row.effect_class === 'READ' }));
}

/**
 * Builds the registry holding every platform row.
 *
 * @param deps The injected tool seam and clock the rows are bound to.
 * @returns A registry whose rows all passed the §6.1 registration invariants.
 */
export function createPlatformSkillRegistry(deps: PlatformSkillDependencies): SkillRegistry {
  const registry = createSkillRegistry();
  for (const row of createPlatformSkills(deps)) {
    registry.register(row);
  }
  return registry;
}

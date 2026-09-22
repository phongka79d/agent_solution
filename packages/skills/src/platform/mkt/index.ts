/**
 * @file The seven Marketing rows of `implement/05` §4.1, in registry order (skills 1-7).
 *
 * Each row is transcribed from its own §4 block by the module named below, so the composition here
 * is only ordering plus dependency injection: `createPlatformSkills` concatenates the three domain
 * factories, and no row in this list can be built without the injected tool port.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { createMktAnalyzeSignal } from './analyze-market-signal.js';
import { createMktAuditBrand } from './audit-brand-compliance.js';
import { createMktCheckConsent } from './check-consent.js';
import { createMktDispatchCampaign } from './dispatch-campaign.js';
import { createMktEvaluateAttribution } from './evaluate-attribution.js';
import { createMktGenerateContent } from './generate-content.js';
import { createMktSegmentAudience } from './segment-audience.js';

/**
 * Builds the seven Marketing rows of `implement/05` §4.1 in specification order.
 *
 * @param deps The injected tool port and clock every row dispatches through.
 * @returns The rows for `skill.mkt.analyze_market_signal`, `skill.mkt.segment_audience`,
 *   `skill.mkt.check_consent`, `skill.mkt.generate_content`, `skill.mkt.audit_brand_compliance`,
 *   `skill.mkt.dispatch_campaign` and `skill.mkt.evaluate_attribution`, in that order and without
 *   an `enabled` flag: the gate decides enablement, never the row.
 */
export function createMarketingSkills(
  deps: PlatformSkillDependencies,
): readonly PlatformSkillRow<unknown, unknown>[] {
  return [
    createMktAnalyzeSignal(deps),
    createMktSegmentAudience(deps),
    createMktCheckConsent(deps),
    createMktGenerateContent(deps),
    createMktAuditBrand(deps),
    createMktDispatchCampaign(deps),
    createMktEvaluateAttribution(deps),
  ];
}

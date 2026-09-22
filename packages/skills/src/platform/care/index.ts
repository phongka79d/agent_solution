/**
 * @file Barrel of the eight Customer Care & Retention rows of
 * `implement/05-skill-system-specifications.md` §4.3 (skills 16-23), in the order the specification
 * lists them.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { createCareAnalyzeChurnRisk } from './analyze-churn-risk.js';
import { createCareEscalateToHuman } from './escalate-to-human.js';
import { createCareInitiateReturn } from './initiate-return.js';
import { createCareIssueRetentionOffer } from './issue-retention-offer.js';
import { createCareLookupOrder } from './lookup-order.js';
import { createCareManageCase } from './manage-case.js';
import { createCareSearchFAQ } from './search-faq.js';
import { createCareTrackShipping } from './track-shipping.js';

/**
 * Builds the eight Customer Care & Retention rows of §4.3 in specification order.
 *
 * @param deps The injected tool port and clock every row dispatches through.
 * @returns The rows for `skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping`,
 *   `skill.care.manage_case`, `skill.care.initiate_return`, `skill.care.escalate_to_human`,
 *   `skill.care.analyze_churn_risk` and `skill.care.issue_retention_offer`, in that order and without
 *   an `enabled` flag: the gate decides enablement, never the row.
 */
export function createCareSkills(
  deps: PlatformSkillDependencies,
): readonly PlatformSkillRow<unknown, unknown>[] {
  return [
    createCareSearchFAQ(deps),
    createCareLookupOrder(deps),
    createCareTrackShipping(deps),
    createCareManageCase(deps),
    createCareInitiateReturn(deps),
    createCareEscalateToHuman(deps),
    createCareAnalyzeChurnRisk(deps),
    createCareIssueRetentionOffer(deps),
  ];
}

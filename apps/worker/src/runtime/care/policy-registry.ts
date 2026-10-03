/**
 * @file Customer Care Policy Registry and Payload Field Allowlist (implement/04 §3.2, implement/08 §1.2).
 *
 * Invariant:
 * Contains the canonical PolicyRegistrySkill definitions and allowed payload fields for Customer Care.
 */

import {
  PLATFORM_SKILL_ROWS,
  payloadFieldsForRows,
  policyRegistryForRows,
} from '@agentos/skills';

const CARE_POLICY_ROWS = PLATFORM_SKILL_ROWS.filter((row) => row.domain === 'care');
export const CARE_ALLOWED_PAYLOAD_FIELDS = payloadFieldsForRows(CARE_POLICY_ROWS);
export const CARE_SKILLS = policyRegistryForRows(CARE_POLICY_ROWS);

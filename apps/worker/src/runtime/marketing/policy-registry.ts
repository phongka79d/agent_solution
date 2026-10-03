import {
  PLATFORM_SKILL_ROWS,
  payloadFieldsForRows,
  policyRegistryForRows,
} from '@agentos/skills';

export const MARKETING_SKILL_ROWS = Object.freeze(
  PLATFORM_SKILL_ROWS.filter((row) => row.domain === 'marketing'),
);

export const MARKETING_ALLOWED_PAYLOAD_FIELDS = payloadFieldsForRows(MARKETING_SKILL_ROWS);
export const MARKETING_SKILLS = policyRegistryForRows(MARKETING_SKILL_ROWS);

import type { AuthorityLevel } from '../contracts/types.js';

/** Canonical low-risk skills are the only skills eligible for controlled autonomy. */
export const PROMOTABLE_SKILL_IDS: ReadonlySet<string> = new Set([
  'skill.sales.check_stock',
  'skill.sales.search_product',
  'skill.sales.retrieve_customer',
  'skill.care.search_faq',
  'skill.mkt.segment_audience',
  'skill.mkt.generate_content',
]);


export function isAutonomousAuthority(value: unknown): value is Exclude<AuthorityLevel, 'AUTH-4' | 'AUTH-5'> {
  return value === 'AUTH-0' || value === 'AUTH-1' || value === 'AUTH-2' || value === 'AUTH-3';
}

export function isNeverPromotableSkill(skill_id: string, required_authority?: unknown): boolean {
  return !PROMOTABLE_SKILL_IDS.has(skill_id.trim())
    || required_authority === 'AUTH-4'
    || required_authority === 'AUTH-5';
}

export function isPromotableSkill(skill_id: string, required_authority?: unknown): boolean {
  return PROMOTABLE_SKILL_IDS.has(skill_id.trim())
    && !isNeverPromotableSkill(skill_id, required_authority)
    && isAutonomousAuthority(required_authority);
}

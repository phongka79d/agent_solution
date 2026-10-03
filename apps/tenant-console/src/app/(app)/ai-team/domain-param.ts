import type { AiTeamDomain } from '../../../lib/types/tenant-console';

export const AI_TEAM_DOMAINS = ['marketing', 'sales', 'care'] as const;

/** Type guard for the `/ai-team/[domain]` route parameter. */
export function isAiTeamDomain(value: string): value is AiTeamDomain {
  return (AI_TEAM_DOMAINS as readonly string[]).includes(value);
}

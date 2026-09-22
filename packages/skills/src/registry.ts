import type { ISkillContract } from './contracts/index.js';

/** Error code every registration attempt fails with while the skill registry is unapproved. */
export const SKILL_ROW_UNAPPROVED = 'SKILL_ROW_UNAPPROVED';

/** Registry surface consumed by `apps/api` and `apps/worker`. */
export interface SkillRegistry {
  /**
   * Registers one skill row.
   *
   * @throws Always: no skill row may be registered until the registry rows are owner-approved.
   */
  register(skill: ISkillContract): never;
  /** Approved skill rows available to the runtime. Empty until the registry is authorized. */
  list(): readonly ISkillContract[];
}

/**
 * Creates the skill registry.
 *
 * @returns A registry whose `list()` is empty and whose `register()` fails closed with
 * `SKILL_ROW_UNAPPROVED`, so an unapproved skill can never execute.
 */
export function createSkillRegistry(): SkillRegistry {
  return {
    register(_skill: ISkillContract): never {
      throw new Error(
        `${SKILL_ROW_UNAPPROVED}: no skill row may be registered before the registry rows are owner-approved`,
      );
    },
    list(): readonly ISkillContract[] {
      return [];
    },
  };
}

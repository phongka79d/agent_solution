/**
 * @file The canonical skill registry (implement/05 §2, §6.1, §8.1; `implement/02` names this file).
 *
 * The registry is the complete admission contract for an invocation: a row that is not registered
 * here cannot be resolved, and a row that cannot pass {@link assertRegistrable} never becomes
 * resolvable. There is no fallback lookup, no cached copy and no implicit default — an unknown
 * `skill_id` is `SKILL_NOT_FOUND` (NFR-008).
 */

import { SkillError, type ISkillContract } from './contracts/index.js';
import { assertRegistrable } from './registration.js';

/** Registry surface consumed by the orchestrator, `apps/api` and `apps/worker`. */
export interface SkillRegistry {
  /**
   * Registers one row after validating every §6.1 registry invariant.
   *
   * @param skill The row to register.
   * @throws {SkillError} The first violated invariant's refusal code; nothing is stored.
   */
  register(skill: ISkillContract): void;
  /**
   * Resolves a row by immutable `skill_id`.
   *
   * @param skill_id The canonical identifier requested by the orchestrator.
   * @returns The registered row.
   * @throws {SkillError} `SKILL_NOT_FOUND` when the id is unknown.
   */
  resolve(skill_id: string): ISkillContract;
  /** Reports whether a row is registered, without throwing. */
  has(skill_id: string): boolean;
  /** Every registered row, in registration order. */
  list(): readonly ISkillContract[];
}

/**
 * Creates an empty registry.
 *
 * @returns A registry whose `resolve()` refuses every unknown id and whose `register()` either
 *   stores a fully valid row or stores nothing at all.
 */
export function createSkillRegistry(): SkillRegistry {
  const rows = new Map<string, ISkillContract>();

  return {
    register(skill: ISkillContract): void {
      assertRegistrable(skill, new Set(rows.keys()));
      rows.set(skill.skill_id, skill);
    },
    resolve(skill_id: string): ISkillContract {
      const skill = rows.get(skill_id);
      if (skill === undefined) {
        throw new SkillError(
          'SKILL_NOT_FOUND',
          'the skill id is not in the registry; there is no fallback row and no cached definition',
          skill_id,
        );
      }
      return skill;
    },
    has(skill_id: string): boolean {
      return rows.has(skill_id);
    },
    list(): readonly ISkillContract[] {
      return [...rows.values()];
    },
  };
}

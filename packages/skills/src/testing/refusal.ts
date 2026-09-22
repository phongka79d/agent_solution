/**
 * @file Refusal assertion shared by the skill-layer suites. Excluded from the package build.
 */

import { expect } from 'vitest';

import { isSkillError, type SkillErrorCode } from '../contracts/index.js';

/**
 * Asserts that a call refuses with a specific stable code, and not merely that it threw.
 *
 * @param run The call expected to refuse.
 * @param code The expected refusal code.
 */
export function expectRefusal(run: () => unknown, code: SkillErrorCode): void {
  let raised: unknown;
  try {
    run();
  } catch (error) {
    raised = error;
  }

  expect(isSkillError(raised)).toBe(true);
  expect(isSkillError(raised) ? raised.code : undefined).toBe(code);
}

/**
 * Asserts that an awaited call refuses with a specific stable code.
 *
 * @param run The promise expected to reject.
 * @param code The expected refusal code.
 */
export async function expectRefusalAsync(
  run: Promise<unknown>,
  code: SkillErrorCode,
): Promise<void> {
  let raised: unknown;
  try {
    await run;
  } catch (error) {
    raised = error;
  }

  expect(isSkillError(raised)).toBe(true);
  expect(isSkillError(raised) ? raised.code : undefined).toBe(code);
}

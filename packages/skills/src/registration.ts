/**
 * @file Registration gate of the canonical skill registry (implement/05 §2 `assertRegistrable`,
 * §6.1 registry invariants, §3.1 test contract).
 *
 * Every check below is fail-closed and runs before a row can be listed, so an incomplete or
 * self-contradicting contract can never become invocable policy. The gate is deliberately blind to
 * the caller: it validates the row, not the intent behind it.
 */

import {
  BASELINE_TEST_CASE_IDS,
  CANONICAL_AGENT_IDS,
  SkillError,
  isAuthorityLevel,
  type RetryPolicy,
  type SkillEffectClass,
  type TestCaseSpec,
} from './contracts/index.js';
import type { ISkillContract } from './contracts/index.js';
import { assertSupportedSchema } from './schema/index.js';

/** Canonical `skill.<domain>.<action>` identifier, bounded to the characters a row may use. */
const SKILL_ID_PATTERN = /^skill\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The four effect behaviours of §6.5. */
const EFFECT_CLASSES: readonly SkillEffectClass[] = Object.freeze([
  'READ',
  'INTERNAL',
  'EFFECT',
  'APPROVAL',
]);

/** Effect-bearing classes: the rows whose adapter call can change the world. */
const EFFECT_BEARING: readonly SkillEffectClass[] = Object.freeze(['EFFECT', 'APPROVAL']);

/** A field every row must populate; an empty one is a missing SRS §11 minimum, not a nit. */
function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The retry policy must be a usable budget; an unusable one would silently disable the bound. */
function assertUsableRetryPolicy(policy: RetryPolicy, skill_id: string): void {
  const usable =
    Number.isSafeInteger(policy.max_retries) &&
    policy.max_retries >= 0 &&
    Number.isFinite(policy.initial_interval_ms) &&
    policy.initial_interval_ms >= 0 &&
    Number.isFinite(policy.backoff_multiplier) &&
    policy.backoff_multiplier >= 1 &&
    Array.isArray(policy.non_retryable_errors);

  if (!usable) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'retry_policy must declare a non-negative max_retries, a non-negative initial_interval_ms, a backoff_multiplier of at least 1, and a non_retryable_errors list',
      skill_id,
    );
  }
}

/** The five mandatory §5 baseline cases must all be present, whatever else the row declares. */
function assertBaselineCases(test_cases: readonly TestCaseSpec[], skill_id: string): void {
  const missing = BASELINE_TEST_CASE_IDS.filter(
    (testId) => !test_cases.some((testCase) => testCase.test_id === testId),
  );

  if (missing.length > 0) {
    throw new SkillError(
      'MISSING_BASELINE_TEST_CASES',
      `the row must instantiate every §5 baseline case; missing ${missing.join(', ')}. A skill with no test contract is not registrable (§3.1)`,
      skill_id,
    );
  }
}

/**
 * Validates one row against the §6.1 registry invariants.
 *
 * @param skill The row offered for registration.
 * @param registered_ids Identifiers already taken; the registry is keyed by immutable `skill_id`.
 * @throws {SkillError} The most specific refusal code for the first violated invariant.
 */
export function assertRegistrable(skill: ISkillContract, registered_ids: ReadonlySet<string>): void {
  const skill_id = skill.skill_id;

  if (isNonEmptyText(skill_id) && registered_ids.has(skill_id)) {
    throw new SkillError(
      'SKILL_ALREADY_REGISTERED',
      'a row with this skill_id is already registered; the registry is keyed by immutable id',
      skill_id,
    );
  }

  if (typeof skill_id !== 'string' || !SKILL_ID_PATTERN.test(skill_id)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      `skill_id must be a canonical 'skill.<domain>.<action>' identifier, received '${String(skill_id)}'`,
    );
  }

  if (!isNonEmptyText(skill.purpose)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'purpose is SRS §11 field 2 and must state a non-empty operational scope',
      skill_id,
    );
  }

  if (typeof skill.timeout_ms !== 'number' || !Number.isSafeInteger(skill.timeout_ms) || skill.timeout_ms <= 0) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'timeout_ms is SRS §11 field 9 and must be a positive integer hard deadline',
      skill_id,
    );
  }

  if (!EFFECT_CLASSES.includes(skill.effect_class)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      `effect_class must be one of ${EFFECT_CLASSES.join(', ')} (§6.5)`,
      skill_id,
    );
  }

  if (!isNonEmptyText(skill.guarded_dependency)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'guarded_dependency must name the circuit-breaker key of the dependency this row guards (§6.5)',
      skill_id,
    );
  }

  if (!isNonEmptyText(skill.tool_binding)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'tool_binding is SRS §11 field 6 and must name the API-001/002/003 or internal engine binding',
      skill_id,
    );
  }

  if (skill.allowed_agents.length === 0) {
    throw new SkillError(
      'MISSING_ALLOWED_AGENTS',
      'allowed_agents is SRS §11 field 4; a row that authorizes nobody could never be invoked',
      skill_id,
    );
  }

  const unauthorized = skill.allowed_agents.filter(
    (agent) => !CANONICAL_AGENT_IDS.includes(agent),
  );
  if (unauthorized.length > 0) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      `allowed_agents must be drawn from the 13 canonical agents (§6.2); unknown ${unauthorized.join(', ')}`,
      skill_id,
    );
  }

  if (skill.required_authority === 'AUTH-5') {
    throw new SkillError(
      'PROHIBITED_AUTHORITY_REQUIREMENT',
      'AUTH-5 is the terminal hard deny verdict and is never a valid requirement (SRS §12, BR-008)',
      skill_id,
    );
  }

  if (!isAuthorityLevel(skill.required_authority)) {
    throw new SkillError(
      'INVALID_AUTHORITY_REQUIREMENT',
      `required_authority '${String(skill.required_authority)}' is outside the AUTH-0..AUTH-5 vocabulary (BR-008)`,
      skill_id,
    );
  }

  if (skill.effect_class === 'APPROVAL' && skill.required_authority !== 'AUTH-4') {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'an APPROVAL row is an AUTH-4 route whose effect exists only after the human decision (§6.5)',
      skill_id,
    );
  }

  if (EFFECT_BEARING.includes(skill.effect_class) && skill.retry_policy.retry_on_timeout) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'an effect-bearing row must declare retry_on_timeout: false; a timed-out external effect is reconciled by effect_key, never retried blind (§1.1 invariant 3, BR-006)',
      skill_id,
    );
  }

  assertUsableRetryPolicy(skill.retry_policy, skill_id);
  assertBaselineCases(skill.test_cases, skill_id);

  if (!isNonEmptyText(skill.audit_spec.evidence_card)) {
    throw new SkillError(
      'INVALID_SKILL_CONTRACT',
      'audit_spec.evidence_card is SRS §11 field 10 and must name the row’s evidence card',
      skill_id,
    );
  }

  assertSupportedSchema(skill_id, skill.input_schema);
  assertSupportedSchema(skill_id, skill.output_schema);
}

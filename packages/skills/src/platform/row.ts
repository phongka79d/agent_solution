/**
 * @file The single row factory every platform skill is built with (implement/05 §3, §6.1).
 *
 * A row is data: the eleven SRS minima, its effect class and its guarded dependency. The factory
 * supplies the two behaviours that must be identical for all 23 rows — normalizing input through
 * the declared `input_schema`, and dispatching the bound connector through the injected tool port —
 * so no row can quietly validate less, normalize differently, or reach an adapter by another route.
 */

import type { AuthorityLevel } from '@agentos/core-engine/contracts';

import type {
  AuditSpec,
  ExecutionContext,
  PlatformSkillDependencies,
  PlatformSkillRow,
  RetryPolicy,
  SkillEffectClass,
  TestCaseSpec,
} from '../contracts/index.js';
import { normalizeAgainstSchema } from '../schema/index.js';

/** The declarative half of a platform row. `enabled` is absent: the gate decides it, not the row. */
export interface PlatformRowSpec {
  readonly skill_id: string;
  readonly purpose: string;
  readonly effect_class: SkillEffectClass;
  readonly guarded_dependency: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_agents: readonly string[];
  readonly required_authority: AuthorityLevel;
  readonly tool_binding: string;
  readonly validation_rules: readonly string[];
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  readonly audit_spec: AuditSpec;
  readonly test_cases: readonly TestCaseSpec[];
}

/**
 * Builds one registry row.
 *
 * @param deps Injected tool seam and clock; the row holds no ambient dependency.
 * @param spec The row's declarative contract, taken from its `implement/05` §4 block.
 * @returns A row whose `validateInput` normalizes through `input_schema` and whose `execute`
 *   dispatches through the tool port bound to `tool_binding`.
 */
export function definePlatformRow<TInput, TOutput>(
  deps: PlatformSkillDependencies,
  spec: PlatformRowSpec,
): PlatformSkillRow<TInput, TOutput> {
  return {
    ...spec,
    validateInput: (input: unknown): TInput =>
      normalizeAgainstSchema<TInput>(spec.skill_id, spec.input_schema, input),
    execute: (input: TInput, context: ExecutionContext): Promise<TOutput> =>
      deps.tools.invoke<TInput, TOutput>({
        skill_id: spec.skill_id,
        tool_binding: spec.tool_binding,
        input,
        context,
      }),
  };
}

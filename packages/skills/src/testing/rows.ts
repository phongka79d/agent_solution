/**
 * @file Fixture rows for the skill-layer suites. Not part of the shipped package: `tsconfig.build`
 * excludes this directory, so nothing here can reach a runtime image.
 */

import {
  BASELINE_TEST_CASE_IDS,
  type ExecutionContext,
  type ISkillContract,
  type SkillToolPort,
  type TestCaseSpec,
} from '../contracts/index.js';
import { normalizeAgainstSchema } from '../schema/index.js';

/** A supported input schema: one required string, no additional members allowed. */
export const FIXTURE_INPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'sku_id'],
  properties: {
    tenant_id: { type: 'string' },
    sku_id: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    note: { type: ['string', 'null'] },
  },
  additionalProperties: false,
});

/** A supported output schema: one required string. */
export const FIXTURE_OUTPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['sku_id'],
  properties: { sku_id: { type: 'string' } },
  additionalProperties: false,
});

/** The five §5 baseline cases every registrable row must carry. */
export function fixtureBaselineCases(): readonly TestCaseSpec[] {
  return BASELINE_TEST_CASE_IDS.map((test_id) => ({
    test_id,
    category: 'HAPPY_PATH',
    scenario: 'fixture baseline setup',
    expected_outcome: 'fixture baseline outcome',
    required: true,
  }));
}

/**
 * Builds a fully valid row.
 *
 * The default `execute` dispatches through the injected tool port, exactly as every platform row
 * does, so a suite can observe what reached the adapter rather than a stub answer that never left
 * the process. `retry_on_timeout` follows the effective `effect_class`: an effect-bearing override
 * gets the `false` the §6.1 invariant requires, so an override changes one thing at a time.
 *
 * @param overrides Fields to replace, so a single invariant can be broken per test.
 * @param tools The adapter seam the row is dispatched through.
 * @returns A row that passes every §6.1 registration invariant unless an override breaks one.
 */
export function fixtureRow(
  overrides: Partial<ISkillContract> = {},
  tools?: SkillToolPort,
): ISkillContract {
  const effect_class = overrides.effect_class ?? 'READ';
  const effectBearing = effect_class === 'EFFECT' || effect_class === 'APPROVAL';
  const skill_id = overrides.skill_id ?? 'skill.test.fixture';
  const tool_binding = overrides.tool_binding ?? 'API-001.CatalogConnector';

  const base: ISkillContract = {
    skill_id,
    purpose: 'fixture row for the registry and runtime suites',
    effect_class,
    guarded_dependency: 'Test.Fixture',
    input_schema: FIXTURE_INPUT_SCHEMA,
    output_schema: FIXTURE_OUTPUT_SCHEMA,
    allowed_agents: ['CS-01'],
    required_authority: 'AUTH-1',
    tool_binding,
    validation_rules: ['fixture rule'],
    retry_policy: {
      max_retries: 1,
      initial_interval_ms: 0,
      backoff_multiplier: 2,
      retry_on_timeout: !effectBearing,
      non_retryable_errors: ['FIXTURE_FATAL'],
    },
    timeout_ms: 1_000,
    audit_spec: {
      log_level: 'INFO',
      mask_pii_fields: [],
      evidence_card: 'EV_TEST_FIXTURE',
      record_latency: true,
    },
    test_cases: [
      ...fixtureBaselineCases(),
      {
        test_id: 'TC-SKILL-99-06',
        category: 'BOUNDARY',
        scenario: 'fixture boundary setup',
        expected_outcome: 'fixture boundary outcome',
        required: true,
      },
    ],
    enabled: true,
    validateInput: (input: unknown): unknown => input,
    execute: async (input: unknown, context: ExecutionContext): Promise<unknown> => {
      if (tools === undefined) {
        throw new Error(`${skill_id} was dispatched without a bound connector`);
      }
      return tools.invoke({ skill_id, tool_binding, input, context });
    },
    ...overrides,
  };

  return {
    ...base,
    validateInput:
      overrides.validateInput ??
      ((input: unknown): unknown =>
        normalizeAgainstSchema(base.skill_id, base.input_schema, input)),
  };
}

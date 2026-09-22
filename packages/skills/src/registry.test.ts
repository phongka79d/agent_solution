import { describe, expect, it } from 'vitest';

import { createSkillRegistry } from './registry.js';
import { expectRefusal } from './testing/refusal.js';
import { fixtureRow } from './testing/rows.js';

describe('createSkillRegistry', () => {
  it('resolves a registered row by immutable id and refuses an unknown one', () => {
    const registry = createSkillRegistry();
    registry.register(fixtureRow());

    expect(registry.has('skill.test.fixture')).toBe(true);
    expect(registry.resolve('skill.test.fixture').skill_id).toBe('skill.test.fixture');
    expectRefusal(() => registry.resolve('skill.test.absent'), 'SKILL_NOT_FOUND');
  });

  it('refuses a second row with the same skill_id', () => {
    const registry = createSkillRegistry();
    registry.register(fixtureRow());

    expectRefusal(() => registry.register(fixtureRow()), 'SKILL_ALREADY_REGISTERED');
  });

  it('refuses a malformed skill_id', () => {
    expectRefusal(
      () => createSkillRegistry().register(fixtureRow({ skill_id: 'sales.check_price' })),
      'INVALID_SKILL_CONTRACT',
    );
  });

  it('refuses a row that authorizes no agent', () => {
    expectRefusal(
      () => createSkillRegistry().register(fixtureRow({ allowed_agents: [] })),
      'MISSING_ALLOWED_AGENTS',
    );
  });

  it('refuses an allowed agent outside the 13 canonical agents', () => {
    expectRefusal(
      () => createSkillRegistry().register(fixtureRow({ allowed_agents: ['HUMAN_HANDOFF'] })),
      'INVALID_SKILL_CONTRACT',
    );
  });

  it('refuses AUTH-5 as a requirement, which is a verdict and never registrable', () => {
    expectRefusal(
      () => createSkillRegistry().register(fixtureRow({ required_authority: 'AUTH-5' })),
      'PROHIBITED_AUTHORITY_REQUIREMENT',
    );
  });

  it('refuses a row that omits the five baseline test cases', () => {
    const withoutBaselines = fixtureRow({
      test_cases: [
        {
          test_id: 'TC-SKILL-99-06',
          category: 'BOUNDARY',
          scenario: 'only a specific case',
          expected_outcome: 'it is not enough',
          required: true,
        },
      ],
    });

    expectRefusal(
      () => createSkillRegistry().register(withoutBaselines),
      'MISSING_BASELINE_TEST_CASES',
    );
  });

  it('refuses an effect-bearing row that would retry a timed-out external effect', () => {
    const dangerous = fixtureRow({
      effect_class: 'EFFECT',
      retry_policy: {
        max_retries: 2,
        initial_interval_ms: 0,
        backoff_multiplier: 2,
        retry_on_timeout: true,
        non_retryable_errors: [],
      },
    });

    expectRefusal(() => createSkillRegistry().register(dangerous), 'INVALID_SKILL_CONTRACT');
  });

  it('refuses an APPROVAL row that is not routed through AUTH-4', () => {
    expectRefusal(
      () =>
        createSkillRegistry().register(
          fixtureRow({ effect_class: 'APPROVAL', required_authority: 'AUTH-3' }),
        ),
      'INVALID_SKILL_CONTRACT',
    );
  });

  it('refuses a row whose schema uses a keyword the validator cannot enforce', () => {
    const unsupported = fixtureRow({
      input_schema: {
        type: 'object',
        properties: { sku_id: { type: 'string', format: 'hostname' } },
      },
    });

    expectRefusal(() => createSkillRegistry().register(unsupported), 'INVALID_SCHEMA');
  });

  it('stores nothing when a registration is refused', () => {
    const registry = createSkillRegistry();

    expectRefusal(
      () => registry.register(fixtureRow({ required_authority: 'AUTH-5' })),
      'PROHIBITED_AUTHORITY_REQUIREMENT',
    );
    expect(registry.list()).toEqual([]);
    expect(registry.has('skill.test.fixture')).toBe(false);
  });

  it('lists rows in registration order', () => {
    const registry = createSkillRegistry();
    registry.register(fixtureRow({ skill_id: 'skill.test.first' }));
    registry.register(fixtureRow({ skill_id: 'skill.test.second' }));

    expect(registry.list().map((row) => row.skill_id)).toEqual([
      'skill.test.first',
      'skill.test.second',
    ]);
  });
});

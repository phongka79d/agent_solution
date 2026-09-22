import { describe, expect, it } from 'vitest';

import type { ISkillContract } from './contracts/index.js';
import { createSkillRegistry } from './registry.js';

/**
 * A well-formed skill row used to prove that registration is refused for a valid row too.
 *
 * @param skill_id Identifier of the skill row under test.
 * @returns A skill contract satisfying the eleven SRS-minimum fields.
 */
function draftSkill(skill_id: string): ISkillContract {
  return {
    skill_id,
    purpose: 'fixture skill row',
    input_schema: {},
    output_schema: {},
    allowed_agents: ['CS-01'],
    required_authority: 'AUTH-1',
    tool_binding: 'adapter:fake',
    validation_rules: [],
    retry_policy: {
      max_retries: 0,
      initial_interval_ms: 0,
      backoff_multiplier: 1,
      retry_on_timeout: false,
      non_retryable_errors: [],
    },
    timeout_ms: 1_000,
    audit_spec: {
      log_level: 'INFO',
      mask_pii_fields: [],
      evidence_card: 'fixture',
      record_latency: false,
    },
    test_cases: [],
    validateInput: (input: unknown) => input,
    execute: async () => ({}),
  };
}

describe('createSkillRegistry', () => {
  it('lists nothing and refuses every registration while no skill row is approved', () => {
    const registry = createSkillRegistry();

    expect(registry.list()).toEqual([]);
    expect(() => registry.register(draftSkill('skill-fixture'))).toThrowError(
      /^SKILL_ROW_UNAPPROVED/,
    );
  });
});

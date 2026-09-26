/**
 * @file Registry completeness contract (implement/05 §6.1 registry invariants, §8 scenario 1, §7
 * Gate P0 "all 23 rows registered, read-only classes enabled").
 *
 * These cases use the real row schemas: a row that loses a §11 minimum, drops a baseline test case,
 * widens its authority, or claims a retry consent it must not have fails here.
 */

import { describe, expect, it } from 'vitest';

import {
  BASELINE_TEST_CASE_IDS,
  CANONICAL_AGENT_IDS,
  type PlatformSkillDependencies,
  type SkillEffectClass,
  type SkillToolInvocation,
} from '../contracts/index.js';
import { DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT, createPlatformSkillRegistry, createPlatformSkills } from './index.js';

/** No connector is bound in this suite: the rows are inspected, never dispatched. */
const DEPS: PlatformSkillDependencies = {
  tools: {
    invoke<TInput, TOutput>(_invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      return Promise.reject(new Error('no connector is bound in the P0 registry suite'));
    },
  },
  clock: () => new Date('2026-01-01T00:00:00.000Z'),
};

/** The §4 registry, in canonical order. */
const CANONICAL_SKILL_IDS: readonly string[] = Object.freeze([
  'skill.mkt.analyze_market_signal',
  'skill.mkt.segment_audience',
  'skill.mkt.check_consent',
  'skill.mkt.generate_content',
  'skill.mkt.audit_brand_compliance',
  'skill.mkt.dispatch_campaign',
  'skill.mkt.evaluate_attribution',
  'skill.sales.search_product',
  'skill.sales.check_stock',
  'skill.sales.check_price',
  'skill.sales.retrieve_customer',
  'skill.sales.recommend_product',
  'skill.sales.create_cart',
  'skill.sales.create_order',
  'skill.sales.send_message',
  'skill.care.search_faq',
  'skill.care.lookup_order',
  'skill.care.track_shipping',
  'skill.care.manage_case',
  'skill.care.initiate_return',
  'skill.care.escalate_to_human',
  'skill.care.analyze_churn_risk',
  'skill.care.issue_retention_offer',
]);

const EFFECT_BEARING: readonly SkillEffectClass[] = Object.freeze(['EFFECT', 'APPROVAL']);

describe('platform skill registry', () => {
  const rows = createPlatformSkills(DEPS);

  it('registers exactly the 23 named rows, once each, in canonical order', () => {
    expect(rows.map((row) => row.skill_id)).toEqual(CANONICAL_SKILL_IDS);
  });

  it('gives every row the eleven SRS §11 minima and the §6.5 effect contract', () => {
    for (const row of rows) {
      expect(row.purpose.length, row.skill_id).toBeGreaterThan(0);
      expect(Object.keys(row.input_schema).length, row.skill_id).toBeGreaterThan(0);
      expect(Object.keys(row.output_schema).length, row.skill_id).toBeGreaterThan(0);
      expect(row.allowed_agents.length, row.skill_id).toBeGreaterThan(0);
      expect(row.tool_binding.length, row.skill_id).toBeGreaterThan(0);
      expect(row.validation_rules.length, row.skill_id).toBeGreaterThan(0);
      expect(row.timeout_ms, row.skill_id).toBeGreaterThan(0);
      expect(row.audit_spec.evidence_card.length, row.skill_id).toBeGreaterThan(0);
      expect(row.guarded_dependency.length, row.skill_id).toBeGreaterThan(0);
      expect(Number.isSafeInteger(row.retry_policy.max_retries), row.skill_id).toBe(true);
    }
  });

  it('gives every row the five §5 baseline cases plus at least one skill-specific case', () => {
    for (const row of rows) {
      const ids = row.test_cases.map((testCase) => testCase.test_id);
      for (const baseline of BASELINE_TEST_CASE_IDS) {
        expect(ids, row.skill_id).toContain(baseline);
      }
      expect(ids.length, row.skill_id).toBeGreaterThan(BASELINE_TEST_CASE_IDS.length);
      expect(
        row.test_cases.filter((testCase) => !BASELINE_TEST_CASE_IDS.includes(testCase.test_id)).length,
        row.skill_id,
      ).toBeGreaterThan(0);
    }
  });

  it('authorizes only the 13 canonical agents', () => {
    for (const row of rows) {
      for (const agent of row.allowed_agents) {
        expect(CANONICAL_AGENT_IDS, `${row.skill_id} → ${agent}`).toContain(agent);
      }
    }
  });

  it('never requires AUTH-5 and never routes an APPROVAL row anywhere but AUTH-4', () => {
    for (const row of rows) {
      expect(row.required_authority, row.skill_id).not.toBe('AUTH-5');
      expect(['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3', 'AUTH-4'], row.skill_id).toContain(
        row.required_authority,
      );
      if (row.effect_class === 'APPROVAL') {
        expect(row.required_authority, row.skill_id).toBe('AUTH-4');
      }
    }
  });

  it('lets no effect-bearing row consent to a blind retry of a timed-out effect', () => {
    for (const row of rows) {
      if (EFFECT_BEARING.includes(row.effect_class)) {
        expect(row.retry_policy.retry_on_timeout, row.skill_id).toBe(false);
      }
    }
  });

  it('enables exactly the rows explicitly approved by the Gate P0 read-only policy', () => {
    const enabledIds = rows.filter((row) => row.enabled).map((row) => row.skill_id);
    const readOnlyIds = rows.filter((row) => row.effect_class === 'READ').map((row) => row.skill_id);

    expect(enabledIds).toEqual(readOnlyIds);
    expect(rows.some((row) => row.skill_id === 'skill.mkt.segment_audience' && row.enabled)).toBe(false);
  });
  it('enables escalation only when a later gate explicitly opts it in', () => {
    const p1Enablement = {
      enabled_skill_ids: [
        ...DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT.enabled_skill_ids,
        'skill.care.escalate_to_human',
      ],
    } as const;
    const rows = createPlatformSkills(DEPS, p1Enablement);

    expect(rows.find((row) => row.skill_id === 'skill.care.escalate_to_human')?.enabled).toBe(true);
    expect(rows.find((row) => row.skill_id === 'skill.care.manage_case')?.enabled).toBe(false);
    expect(rows.filter((row) => row.enabled).map((row) => row.skill_id)).toContain('skill.care.search_faq');
  });

  it('keeps manage_case disabled until a later gate explicitly enables it', () => {
    expect(rows.find((row) => row.skill_id === 'skill.care.manage_case')?.enabled).toBe(false);
    const p1bEnablement = {
      enabled_skill_ids: [
        ...DEFAULT_P0_PLATFORM_SKILL_ENABLEMENT.enabled_skill_ids,
        'skill.care.manage_case',
      ],
    } as const;

    const p1bRows = createPlatformSkills(DEPS, p1bEnablement);
    expect(p1bRows.find((row) => row.skill_id === 'skill.care.manage_case')?.enabled).toBe(true);
  });

  it('requires case id and expected version on every non-create manage_case action', () => {
    const manageCase = rows.find((row) => row.skill_id === 'skill.care.manage_case')!;
    const base = {
      tenant_id: 'tenant-1',
      customer_id: 'customer-1',
      intent: 'billing',
      priority: 'P2',
      conversation_id: 'conversation-1',
      action_type: 'CREATE',
    };

    expect(() => manageCase.validateInput(base)).not.toThrow();
    expect(() => manageCase.validateInput({ ...base, action_type: 'TRANSITION_STATE' })).toThrow();
    expect(() => manageCase.validateInput({ ...base, action_type: 'TRANSITION_STATE', case_id: 'case-1' })).toThrow();
    expect(() => manageCase.validateInput({
      ...base,
      action_type: 'TRANSITION_STATE',
      case_id: 'case-1',
      expected_case_version: 1,
    })).not.toThrow();
  });
  it('resolves every row through a registry built from the same rows', () => {
    const registry = createPlatformSkillRegistry(DEPS);

    expect(registry.list()).toHaveLength(CANONICAL_SKILL_IDS.length);
    for (const skill_id of CANONICAL_SKILL_IDS) {
      expect(registry.resolve(skill_id).skill_id).toBe(skill_id);
    }
  });
});

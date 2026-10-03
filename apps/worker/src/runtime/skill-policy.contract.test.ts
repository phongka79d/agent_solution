import { describe, expect, it } from 'vitest';

import { PROMOTABLE_SKILL_IDS } from '@agentos/core-engine';
import {
  PLATFORM_SKILL_ROWS,
  payloadFieldsForRows,
  policyRegistryForRows,
  toPolicyRegistrySkill,
} from '@agentos/skills';
import {
  CARE_ALLOWED_PAYLOAD_FIELDS,
  CARE_SKILLS,
} from './care/policy-registry.js';
import {
  MARKETING_ALLOWED_PAYLOAD_FIELDS,
  MARKETING_SKILLS,
} from './marketing/policy-registry.js';
import {
  SALES_ALLOWED_PAYLOAD_FIELDS,
  SALES_SKILLS,
} from './sales/policy-engine.js';

const PEP_SKILLS = Object.freeze({ ...SALES_SKILLS, ...CARE_SKILLS, ...MARKETING_SKILLS });
const PEP_PAYLOAD_FIELDS = Object.freeze({
  ...SALES_ALLOWED_PAYLOAD_FIELDS,
  ...CARE_ALLOWED_PAYLOAD_FIELDS,
  ...MARKETING_ALLOWED_PAYLOAD_FIELDS,
});

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('PEP registries derived from canonical skill rows', () => {
  it('projects every row exactly once with matching policy, payload, and autonomy metadata', () => {
    const rowIds = PLATFORM_SKILL_ROWS.map((row) => row.skill_id);
    const derivedPolicy = policyRegistryForRows(PLATFORM_SKILL_ROWS);
    const derivedPayloadFields = payloadFieldsForRows(PLATFORM_SKILL_ROWS);

    expect(sorted(Object.keys(PEP_SKILLS))).toEqual(sorted(rowIds));
    expect(sorted(Object.keys(PEP_PAYLOAD_FIELDS))).toEqual(sorted(rowIds));

    for (const row of PLATFORM_SKILL_ROWS) {
      const skillId = row.skill_id;
      const policy = PEP_SKILLS[skillId];
      const allowlist = PEP_PAYLOAD_FIELDS[skillId];
      const schemaProperties = row.input_schema['properties'];

      expect(policy, skillId).toEqual(derivedPolicy[skillId]);
      expect(policy, skillId).toEqual(toPolicyRegistrySkill(row));
      expect(policy?.allowed_agents, skillId).toEqual(row.allowed_agents);
      expect(policy?.required_authority, skillId).toBe(row.required_authority);
      expect(policy?.mutating, skillId).toBe(row.effect_class !== 'READ');
      expect(policy?.idempotent, skillId).toBe(row.effect_class === 'READ');
      expect(policy?.timeout_ms, skillId).toBe(row.timeout_ms);

      expect(allowlist, skillId).toEqual(derivedPayloadFields[skillId]);
      expect(Object.keys(allowlist ?? {}).sort(), skillId).toEqual(
        [...new Set([...Object.keys(schemaProperties as Record<string, unknown>), 'tenant_id', 'effect_key'])].sort(),
      );
      expect(row.display_key, skillId).toBe(row.skill_id.slice('skill.'.length));
      // Must satisfy agentos.skill_catalog's CHECK (0042); the `mkt` id segment is the marketing domain.
      const segment = row.skill_id.split('.')[1];
      expect(row.domain, skillId).toBe(segment === 'mkt' ? 'marketing' : segment);
      expect(['sales', 'care', 'marketing', 'knowledge', 'platform'], skillId).toContain(row.domain);
      expect(row.config_schema, skillId).toMatchObject({ type: 'object', additionalProperties: false });
      expect(row.autonomy_class, skillId).toMatch(/^(NEVER|PROMOTABLE)$/);
      expect(row.receipt_ref, skillId).not.toBe('');
      expect(['SYNC', 'AWAITS_HUMAN'], skillId).toContain(row.completion);
      // Only tenant connectors (API-001 ERP/POS, API-003) gate availability; internal bindings don't.
      expect(row.connector_kinds, skillId).toEqual(
        /^API-00[13]\./.test(row.tool_binding) ? [row.tool_binding] : [],
      );
    }

    const createOrder = PLATFORM_SKILL_ROWS.find((row) => row.skill_id === 'skill.sales.create_order');
    expect(createOrder).toMatchObject({
      effect_class: 'APPROVAL',
      required_authority: 'AUTH-4',
      allowed_agents: ['SAL-02'],
    });
    expect(PEP_SKILLS['skill.sales.create_order']).toMatchObject({
      mutating: true,
      idempotent: false,
      required_authority: 'AUTH-4',
    });


    expect(sorted(PROMOTABLE_SKILL_IDS)).toEqual(
      sorted(PLATFORM_SKILL_ROWS.filter((row) => row.autonomy_class === 'PROMOTABLE').map((row) => row.skill_id)),
    );
  });
});

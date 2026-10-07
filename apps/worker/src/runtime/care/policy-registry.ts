/**
 * @file Customer Care Policy Registry and Payload Field Allowlist (implement/04 §3.2, implement/08 §1.2).
 *
 * Invariant:
 * Contains the canonical PolicyRegistrySkill definitions and allowed payload fields for Customer Care.
 */

import type { PolicyRegistrySkill } from '@agentos/core-engine';
import { createPlatformSkills, type PlatformSkillDependencies, type SkillToolInvocation } from '@agentos/skills';

const CARE_SCHEMA_DEPENDENCIES: PlatformSkillDependencies = {
  tools: {
    invoke<TInput, TOutput>(_invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      return Promise.reject(new Error('schema-only skill construction must not invoke tools')) as Promise<TOutput>;
    },
  },
  clock: () => new Date(0),
};

function fieldsFromInputSchema(skill_id: string): Readonly<Record<string, true>> {
  const row = createPlatformSkills(CARE_SCHEMA_DEPENDENCIES).find((candidate) => candidate.skill_id === skill_id);
  const properties = row?.input_schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error(`CARE_SCHEMA_INVALID: ${skill_id} has no object input properties`);
  }
  return Object.freeze(
    Object.fromEntries(Object.keys(properties).map((field) => [field, true] as const)),
  ) as Readonly<Record<string, true>>;
}

/** Allowed fields in action payloads per Care skill, using static Record lookup */
export const CARE_ALLOWED_PAYLOAD_FIELDS: Readonly<Record<string, Readonly<Record<string, true>>>> = Object.freeze({
  'skill.care.lookup_order': Object.freeze({
    order_id: true,
    order_identifier: true,
    customer_id: true,
    verification_reference: true,
    verification_status: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.search_faq': Object.freeze({
    query: true,
    query_text: true,
    category: true,
    top_k: true,
    limit: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.track_shipping': Object.freeze({
    tracking_number: true,
    carrier: true,
    order_identifier: true,
    order_id: true,
    customer_id: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.manage_case': fieldsFromInputSchema('skill.care.manage_case'),
  'skill.care.initiate_return': Object.freeze({
    order_identifier: true,
    order_id: true,
    customer_id: true,
    items: true,
    reason: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.escalate_to_human': Object.freeze({
    tenant_id: true,
    session_id: true,
    conversation_id: true,
    customer_id: true,
    escalation_reason: true,
    summary_context: true,
    effect_key: true,
  }),
  'skill.care.analyze_churn_risk': Object.freeze({
    customer_id: true,
    recent_message_snippets: true,
    tenant_id: true,
    effect_key: true,
  }),
  'skill.care.issue_retention_offer': Object.freeze({
    customer_id: true,
    offer_scenario: true,
    target_cart_id: true,
    max_discount_value: true,
    price_protection_details: true,
    tenant_id: true,
    effect_key: true,
  }),
});

/** Canonical skill definitions for Customer Care from packages/skills/src/platform/care/*.ts */
export const CARE_SKILLS: Readonly<Record<string, PolicyRegistrySkill>> = Object.freeze({
  'skill.care.lookup_order': {
    skill_id: 'skill.care.lookup_order',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2000,
  },
  'skill.care.search_faq': {
    skill_id: 'skill.care.search_faq',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 1500,
  },
  'skill.care.track_shipping': {
    skill_id: 'skill.care.track_shipping',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-0',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2000,
  },
  'skill.care.manage_case': {
    skill_id: 'skill.care.manage_case',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
  'skill.care.initiate_return': {
    skill_id: 'skill.care.initiate_return',
    allowed_agents: Object.freeze(['CS-01']),
    required_authority: 'AUTH-4',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
  'skill.care.escalate_to_human': {
    skill_id: 'skill.care.escalate_to_human',
    allowed_agents: Object.freeze(['CS-01', 'CS-02']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: false,
    idempotent: false,
    epistemic_class: 'FACT',
    write_target: 'FACT',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 2000,
  },
  'skill.care.analyze_churn_risk': {
    skill_id: 'skill.care.analyze_churn_risk',
    allowed_agents: Object.freeze(['CS-02']),
    required_authority: 'AUTH-1',
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'HYPOTHESIS',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: true,
    timeout_ms: 2500,
  },
  'skill.care.issue_retention_offer': {
    skill_id: 'skill.care.issue_retention_offer',
    allowed_agents: Object.freeze(['CS-02']),
    required_authority: 'AUTH-3',
    mutating: true,
    price_bearing: true,
    idempotent: false,
    epistemic_class: 'DECISION',
    write_target: 'FACT',
    requires_consent: true,
    requires_verified_identity: true,
    timeout_ms: 3000,
  },
});

/**
 * @file Row `skill.care.search_faq` — approved Second Brain FAQ retrieval for verified resolutions.
 * Transcribed from `implement/05-skill-system-specifications.md` §4.3 skill 16 (lines 1736-1800); its
 * effect class and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from
 * the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.care.search_faq` (§4.3 skill 16). */
export interface InputCareSearchFAQ {
  tenant_id: string;
  query_text: string;
  top_k?: number;
}

/** Output of `skill.care.search_faq` (§4.3 skill 16). */
export interface OutputCareSearchFAQ {
  answers: Array<{ faq_id: string; question: string; approved_answer: string; source_file: string }>;
  match_confidence: number;
}

/** Immutable identifier of this row (§4.3 skill 16). */
export const CARE_SEARCH_FAQ_SKILL_ID = 'skill.care.search_faq';

/** Strict input schema of §4.3 skill 16, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'query_text'],
  properties: {
    tenant_id: { type: 'string' },
    query_text: { type: 'string', minLength: 1 },
    top_k: { type: 'integer', default: 3, maximum: 5 },
  },
  additionalProperties: false,
};

/** Output schema of §4.3 skill 16, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['answers', 'match_confidence'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['faq_id', 'question', 'approved_answer', 'source_file'],
        properties: {
          faq_id: { type: 'string' },
          question: { type: 'string' },
          approved_answer: { type: 'string' },
          source_file: { type: 'string' },
        },
      },
    },
    match_confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.3 skill 16). */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Queries approved Second Brain knowledge base (`/customer-care/faq.md`) for verified resolutions.',
  effect_class: 'READ',
  guarded_dependency: 'SecondBrain.FAQEngine',
  input_schema,
  output_schema,
  allowed_agents: ['CS-01'],
  required_authority: 'AUTH-0',
  tool_binding: 'SecondBrain.FAQEngine',
  validation_rules: ['answers must be sourced exclusively from approved Second Brain documents'],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 300,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['CORPUS_UNAVAILABLE'],
  },
  timeout_ms: 1500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_FAQ_QUERY',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`CS-01` at `AUTH-0` submits a non-empty `query_text` and the FAQ engine answers from the approved corpus.',
      expected_outcome: 'Approved answers with `source_file` citations',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario: 'A query whose wording matches no approved Second Brain document.',
      expected_outcome: 'No approved match → empty `answers`; nothing synthesized',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A payload with an empty `query_text`, and one with `top_k > 5`, are submitted.',
      expected_outcome: 'Empty `query_text` or `top_k > 5` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'SecondBrain.FAQEngine does not answer within the row timeout of 1500ms across the ≤3 retry budget.',
      expected_outcome: '`CORPUS_UNAVAILABLE` after ≤3; no partial citation presented',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical `query_text`/`top_k` read is submitted twice.',
      expected_outcome: 'Read-only: identical result; no corpus write',
      required: true,
    },
    {
      test_id: 'TC-SKILL-16-06',
      category: 'VALIDATION',
      scenario: 'Query with no approved corpus match.',
      expected_outcome:
        'Empty `answers`; the engine never synthesizes an unapproved answer (BR-003).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-16-07',
      category: 'RESILIENCE',
      scenario: 'Second Brain corpus unavailable.',
      expected_outcome:
        '`CORPUS_UNAVAILABLE` (non-retryable); no answer is invented and no partial citation is presented.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.care.search_faq` row (§4.3 skill 16).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `SecondBrain.FAQEngine` through the tool port.
 */
export function createCareSearchFAQ(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputCareSearchFAQ, OutputCareSearchFAQ> {
  return definePlatformRow<InputCareSearchFAQ, OutputCareSearchFAQ>(deps, {
    ...spec,
    skill_id: CARE_SEARCH_FAQ_SKILL_ID,
  });
}

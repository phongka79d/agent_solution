/**
 * @file `skill.mkt.generate_content` — Marketing row 4 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 829-929), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/**
 * §4.1 field 4 `channel_payload` of the row: one envelope per channel family, of which only the
 * variant matching `channel_type` is populated. Every optional member is optional because the
 * JSON-Schema block declares no `required` list for it.
 */
export interface ChannelSpecificPayload {
  channel_type: string;
  line_flex_container?: Record<string, unknown>;
  whatsapp_template?: { template_name: string; parameters: string[] };
  zalo_zns_template?: { template_id: string; template_data: Record<string, string> };
  meta_generic_card?: { title: string; subtitle: string; image_url?: string; cta_button_url?: string };
}

/**
 * §4.1 field 3 `Input*` of the row, normalized: `product_skus` declares no `required` entry and is
 * therefore optional.
 */
export interface InputMktGenerateContent {
  tenant_id: string;
  campaign_theme: string;
  channel: 'LINE_FLEX' | 'WHATSAPP_TEMPLATE' | 'EMAIL_HTML' | 'SMS_TEXT' | 'ZALO_ZNS' | 'TIKTOK_CARD' | 'MESSENGER_GENERIC' | 'INSTAGRAM_DIRECT';
  locale: 'zh-TW' | 'en-US' | 'vi-VN' | 'ja-JP';
  product_skus?: string[];
}

/** §4.1 field 4 `Output*` of the row. */
export interface OutputMktGenerateContent {
  draft_id: string;
  headline: string;
  body_content: string;
  cta_text: string;
  channel_payload: ChannelSpecificPayload;
}

/** Canonical id of §4.1 skill 4: the immutable key every dispatch envelope resolves by. */
export const GENERATE_CONTENT_SKILL_ID = 'skill.mkt.generate_content';

/** The §4.1 row without its id; {@link GENERATE_CONTENT_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose: 'Generates multi-channel copy tailored to audience segment and campaign goals.',
  effect_class: 'INTERNAL',
  guarded_dependency: 'Core.LLMContentEngine',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'campaign_theme', 'channel', 'locale'],
    properties: {
      tenant_id: { type: 'string' },
      campaign_theme: { type: 'string' },
      channel: {
        type: 'string',
        enum: [
          'LINE_FLEX',
          'WHATSAPP_TEMPLATE',
          'EMAIL_HTML',
          'SMS_TEXT',
          'ZALO_ZNS',
          'TIKTOK_CARD',
          'MESSENGER_GENERIC',
          'INSTAGRAM_DIRECT',
        ],
      },
      locale: { type: 'string', enum: ['zh-TW', 'en-US', 'vi-VN', 'ja-JP'] },
      product_skus: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['draft_id', 'headline', 'body_content', 'cta_text', 'channel_payload'],
    properties: {
      draft_id: { type: 'string' },
      headline: { type: 'string' },
      body_content: { type: 'string' },
      cta_text: { type: 'string' },
      channel_payload: {
        type: 'object',
        required: ['channel_type'],
        properties: {
          channel_type: { type: 'string' },
          line_flex_container: { type: 'object' },
          whatsapp_template: {
            type: 'object',
            properties: {
              template_name: { type: 'string' },
              parameters: { type: 'array', items: { type: 'string' } },
            },
          },
          zalo_zns_template: {
            type: 'object',
            properties: {
              template_id: { type: 'string' },
              template_data: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
          meta_generic_card: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              subtitle: { type: 'string' },
              image_url: { type: 'string' },
              cta_button_url: { type: 'string' },
            },
          },
        },
      },
    },
  },
  allowed_agents: ['MKT-03'],
  required_authority: 'AUTH-2',
  tool_binding: 'Core.LLMContentEngine',
  validation_rules: [
    'campaign_theme must not exceed 250 characters',
    'locale must be supported',
  ],
  retry_policy: {
    max_retries: 1,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.0,
    retry_on_timeout: true,
    non_retryable_errors: ['PROMPT_INJECTION_BLOCKED'],
  },
  timeout_ms: 5000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_MKT_CONTENT_DRAFT',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-03 holding an AUTH-2 grant; Core.LLMContentEngine answers inside the declared deadline.',
      expected_outcome:
        '`MKT-03` at `AUTH-2` → one draft with channel payload; nothing dispatched',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A caller outside `allowed_agents` invokes the row, or presents an `AUTH-1` grant against the `AUTH-2` requirement.',
      expected_outcome:
        'Unlisted agent → `UNAUTHORIZED_AGENT`; `AUTH-1` → `INSUFFICIENT_AUTHORITY`; no draft',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing a required field, carrying a `locale` outside the enum, or containing an illegal extra property.',
      expected_outcome:
        '250+ char theme or unsupported locale → validation failure before the LLM call',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `Core.LLMContentEngine` call hangs past `timeout_ms` of 5000ms.',
      expected_outcome: 'Engine timeout retried once; no partial draft persisted',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical brief is submitted twice.',
      expected_outcome:
        'Replay of the stored draft id returns the stored payload; no second billed generation',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04-06',
      category: 'SECURITY',
      scenario: '`campaign_theme` carrying instruction-override / prompt-injection text.',
      expected_outcome:
        '`PROMPT_INJECTION_BLOCKED` (non-retryable, `FATAL`); no `draft_id` and nothing persisted.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04-07',
      category: 'BOUNDARY',
      scenario: '`campaign_theme` longer than 250 characters, or an unsupported `locale`.',
      expected_outcome: 'Validation failure before the LLM call; no draft is generated.',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 4 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.generate_content` row, without an `enabled` flag — the gate owns that.
 */
export function createMktGenerateContent(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktGenerateContent, OutputMktGenerateContent> {
  return definePlatformRow<InputMktGenerateContent, OutputMktGenerateContent>(deps, {
    ...spec,
    skill_id: GENERATE_CONTENT_SKILL_ID,
  });
}

/**
 * @file Row `skill.sales.send_message` — dispatches a personalized consultation or cart recovery
 * message via the target channel. Transcribed from `implement/05-skill-system-specifications.md`
 * §4.2 skill 15 (lines 1648-1732); its effect class and circuit-breaker key come from the §6.5
 * matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Outbound payload of one message (§4.2 skill 15). */
export interface OutboundMessagePayload {
  text: string;
  quick_replies?: string[];
  template_id?: string;
  template_params?: Record<string, string>;
  card?: {
    title: string;
    description: string;
    image_url?: string;
    action_url?: string;
  };
}

/** Input of `skill.sales.send_message` (§4.2 skill 15). */
export interface InputSalesSendMessage {
  tenant_id: string;
  recipient_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'WEB_CHAT' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  message_content: OutboundMessagePayload;
  effect_key: string;
}

/** Output of `skill.sales.send_message` (§4.2 skill 15). */
export interface OutputSalesSendMessage {
  message_id: string;
  provider_reference: string;
  delivered_at: string;
}

/** Immutable identifier of this row (§4.2 skill 15). */
export const SALES_SEND_MESSAGE_SKILL_ID = 'skill.sales.send_message';

/** Strict input schema of §4.2 skill 15, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'recipient_id', 'channel', 'message_content', 'effect_key'],
  properties: {
    tenant_id: { type: 'string' },
    recipient_id: { type: 'string' },
    channel: {
      type: 'string',
      enum: [
        'LINE',
        'WHATSAPP',
        'WEB_CHAT',
        'SMS',
        'ZALO',
        'TIKTOK',
        'MESSENGER',
        'INSTAGRAM',
      ],
    },
    message_content: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        quick_replies: { type: 'array', items: { type: 'string' } },
        template_id: { type: 'string' },
        template_params: { type: 'object', additionalProperties: { type: 'string' } },
        card: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            image_url: { type: 'string' },
            action_url: { type: 'string' },
          },
        },
      },
    },
    effect_key: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 15, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['message_id', 'provider_reference', 'delivered_at'],
  properties: {
    message_id: { type: 'string' },
    provider_reference: { type: 'string' },
    delivered_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 15). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Dispatches personalized consultation or cart recovery message via target channel.',
  effect_class: 'EFFECT',
  guarded_dependency: 'API-003.CommunicationConnector',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
  required_authority: 'AUTH-3',
  tool_binding: 'API-003.CommunicationConnector',
  validation_rules: [
    'recipient must have active consent',
    'session mutex lock must not be held by human',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 500,
    backoff_multiplier: 2.0,
    retry_on_timeout: false,
    non_retryable_errors: ['BLOCKED_BY_USER', 'SESSION_EXPIRED'],
  },
  timeout_ms: 3000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['recipient_id'],
    evidence_card: 'EV_OUTBOUND_MESSAGE',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-02` at `AUTH-3` sends one consented message under a fresh `effect_key`, with no human holding the session mutex.',
      expected_outcome: 'One provider send; `message_id` + `provider_reference`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A recipient without active consent, and a session whose mutex is held by a human.',
      expected_outcome:
        'Missing/withdrawn consent → `CONSENT_REQUIRED` (`allowed=false`); human holds the mutex → refused; 0 sends',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'A payload missing `channel`, `message_content`, or `effect_key` is submitted.',
      expected_outcome:
        'Missing channel/content or `effect_key` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-003.CommunicationConnector does not answer within the row timeout of 3000ms.',
      expected_outcome: '`EFFECT_UNKNOWN`; no second send before reconciliation',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'Same `effect_key` with the same payload is replayed after a successful send, then replayed with a changed payload.',
      expected_outcome:
        'Same key + same payload → `REPLAY` with the stored `message_id`; one provider send; changed payload → `IDEMPOTENCY_CONFLICT`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-15-06',
      category: 'VALIDATION',
      scenario:
        'Recipient without active consent, or a session whose mutex is held by a human.',
      expected_outcome:
        'The message is refused before dispatch (`BLOCKED_BY_USER`/`SESSION_EXPIRED`); nothing is sent (BR-004).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-15-07',
      category: 'IDEMPOTENCY',
      scenario: 'Identical `effect_key` replayed after a successful send.',
      expected_outcome:
        'The stored `message_id` is returned; exactly one provider send occurs.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.send_message` row (§4.2 skill 15).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-003.CommunicationConnector` through the tool port.
 */
export function createSalesSendMessage(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesSendMessage, OutputSalesSendMessage> {
  return definePlatformRow<InputSalesSendMessage, OutputSalesSendMessage>(deps, {
    ...spec,
    skill_id: SALES_SEND_MESSAGE_SKILL_ID,
  });
}

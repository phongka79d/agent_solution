/**
 * @file Row `skill.sales.create_cart` — creates or modifies an active shopping cart for the current
 * session. Transcribed from `implement/05-skill-system-specifications.md` §4.2 skill 13 (lines
 * 1501-1576); its effect class and circuit-breaker key come from the §6.5 matrix, its baseline case
 * outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.create_cart` (§4.2 skill 13). */
export interface InputSalesCreateCart {
  tenant_id: string;
  session_id: string;
  customer_id?: string;
  items: Array<{ sku_id: string; quantity: number }>;
  idempotency_key: string;
}

/** Output of `skill.sales.create_cart` (§4.2 skill 13). */
export interface OutputSalesCreateCart {
  cart_id: string;
  item_count: number;
  subtotal: number;
  currency: string;
  updated_at: string;
}

/** Immutable identifier of this row (§4.2 skill 13). */
export const SALES_CREATE_CART_SKILL_ID = 'skill.sales.create_cart';

/** Strict input schema of §4.2 skill 13, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'session_id', 'items', 'idempotency_key'],
  properties: {
    tenant_id: { type: 'string' },
    session_id: { type: 'string' },
    customer_id: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sku_id', 'quantity'],
        properties: {
          sku_id: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
        },
      },
    },
    idempotency_key: { type: 'string' },
    offer_id: { type: 'string' },
    discount_amount: { type: 'number', minimum: 0 },
    discount_percent: { type: 'number', minimum: 0, maximum: 100 },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 13, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['cart_id', 'item_count', 'subtotal', 'currency', 'updated_at'],
  properties: {
    cart_id: { type: 'string' },
    item_count: { type: 'integer' },
    subtotal: { type: 'number' },
    currency: { type: 'string' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 13). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose: 'Creates or modifies an active shopping cart for the current session.',
  effect_class: 'EFFECT',
  guarded_dependency: 'API-002.CommerceCartAPI',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-02', 'SAL-04'],
  required_authority: 'AUTH-3',
  tool_binding: 'API-002.CommerceCartAPI',
  validation_rules: [
    'items array must not be empty',
    'all SKUs must have available inventory',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 400,
    backoff_multiplier: 1.5,
    retry_on_timeout: false,
    non_retryable_errors: ['OUT_OF_STOCK', 'IDEMPOTENCY_CONFLICT'],
  },
  timeout_ms: 2000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id'],
    evidence_card: 'EV_CART_MUTATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-02` at `AUTH-3` submits in-stock items under a fresh `idempotency_key`, with no human holding the session.',
      expected_outcome:
        'One cart mutation; `cart_id`, item count, subtotal returned; `EV_CART_MUTATION`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A run holding only `AUTH-2` invokes the row, and a second attempt targets a session whose mutex is held by a human.',
      expected_outcome:
        '`AUTH-2` → `INSUFFICIENT_AUTHORITY`; human-held session → refused; 0 mutations',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'An empty `items` array and a payload without `idempotency_key`.',
      expected_outcome:
        'Empty items or missing `idempotency_key` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-002.CommerceCartAPI does not answer within the row timeout of 2000ms.',
      expected_outcome:
        '`EFFECT_UNKNOWN`, no blind retry; reconcile by `idempotency_key` before re-dispatch',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'Same key with a same payload is replayed after a successful mutation, then replayed with a changed payload.',
      expected_outcome:
        'Same key + same payload → `REPLAY` with the original `cart_id`; changed payload → `IDEMPOTENCY_CONFLICT`; no duplicate line items',
      required: true,
    },
    {
      test_id: 'TC-SKILL-13-06',
      category: 'IDEMPOTENCY',
      scenario:
        'Identical `idempotency_key` replayed after a successful mutation.',
      expected_outcome:
        'The original `cart_id` and subtotal are returned; no duplicated line items and no second cart.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-13-07',
      category: 'VALIDATION',
      scenario: 'Any item without available inventory.',
      expected_outcome:
        '`OUT_OF_STOCK` (non-retryable); the cart is left unchanged (all-or-nothing).',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.create_cart` row (§4.2 skill 13).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-002.CommerceCartAPI` through the tool port.
 */
export function createSalesCreateCart(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesCreateCart, OutputSalesCreateCart> {
  return definePlatformRow<InputSalesCreateCart, OutputSalesCreateCart>(deps, {
    ...spec,
    skill_id: SALES_CREATE_CART_SKILL_ID,
  });
}

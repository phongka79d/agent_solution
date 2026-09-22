/**
 * @file Row `skill.sales.create_order` — creates a draft or pending order in ERP with
 * server-verified prices and a cryptographic effect key. Transcribed from
 * `implement/05-skill-system-specifications.md` §4.2 skill 14 (lines 1578-1646); its effect class
 * and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.create_order` (§4.2 skill 14). */
export interface InputSalesCreateOrder {
  tenant_id: string;
  cart_id: string;
  customer_id: string;
  shipping_address: Record<string, unknown>;
  payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
  effect_key: string;
}

/** Output of `skill.sales.create_order` (§4.2 skill 14). */
export interface OutputSalesCreateOrder {
  order_id: string;
  order_number: string;
  total_amount: number;
  currency: string;
  status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED';
  payment_url?: string;
  created_at: string;
}

/** Immutable identifier of this row (§4.2 skill 14). */
export const SALES_CREATE_ORDER_SKILL_ID = 'skill.sales.create_order';

/** Strict input schema of §4.2 skill 14, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: [
    'tenant_id',
    'cart_id',
    'customer_id',
    'shipping_address',
    'payment_method',
    'effect_key',
  ],
  properties: {
    tenant_id: { type: 'string' },
    cart_id: { type: 'string' },
    customer_id: { type: 'string' },
    shipping_address: { type: 'object' },
    payment_method: {
      type: 'string',
      enum: ['CREDIT_CARD', 'CVS_COD', 'LINE_PAY', 'JKOPAY', 'STRIPE', 'PAYPAL'],
    },
    effect_key: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 14, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['order_id', 'order_number', 'total_amount', 'currency', 'status', 'created_at'],
  properties: {
    order_id: { type: 'string' },
    order_number: { type: 'string' },
    total_amount: { type: 'number' },
    currency: { type: 'string' },
    status: { type: 'string', enum: ['DRAFT', 'PENDING_PAYMENT', 'CONFIRMED'] },
    payment_url: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 14). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Creates a draft or pending order in ERP with server-verified prices and cryptographic effect key.',
  effect_class: 'EFFECT',
  guarded_dependency: 'API-001.OrderConnector',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-02', 'SAL-04', 'SAL-05'],
  required_authority: 'AUTH-3',
  tool_binding: 'API-001.OrderConnector',
  validation_rules: [
    'effect_key must be unique within 72h Redis cache',
    'total_amount must match pricing engine quote',
    'payment_method must be supported in tenant country',
  ],
  retry_policy: {
    max_retries: 1,
    initial_interval_ms: 1000,
    backoff_multiplier: 1.0,
    retry_on_timeout: false,
    non_retryable_errors: ['ORDER_ALREADY_EXISTS', 'PAYMENT_REJECTED'],
  },
  timeout_ms: 4000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id', 'shipping_address'],
    evidence_card: 'EV_ORDER_CREATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-02` at `AUTH-3` submits a priced cart with `shipping_address`, a supported `payment_method`, and a fresh `effect_key`.',
      expected_outcome: 'One ERP order; `order_number` returned',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A total differing from the pricing-engine quote, an unsupported `payment_method`, and an unlisted caller.',
      expected_outcome:
        'Total ≠ pricing quote, unsupported payment method, or unlisted agent → refused before dispatch; 0 ERP calls',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'A payload missing `effect_key` and `shipping_address` is submitted.',
      expected_outcome:
        'Missing `effect_key`/address → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-001.OrderConnector does not answer within the row timeout of 4000ms.',
      expected_outcome:
        '`EFFECT_UNKNOWN`; reservation stays `RESERVED`; reconcile finds the order or proves absence before retry',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'Same `effect_key` with the same payload is replayed after ERP accepted the order, then replayed with a changed payload.',
      expected_outcome:
        'Same key + same payload → `REPLAY` with the stored order; exactly one order in ERP; changed payload → `IDEMPOTENCY_CONFLICT`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-14-06',
      category: 'IDEMPOTENCY',
      scenario:
        'Identical `effect_key` replayed after ERP accepted the order.',
      expected_outcome:
        'The stored `order_id`/`order_number` is returned; exactly one order exists in ERP (BR-005, BR-006).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-14-07',
      category: 'VALIDATION',
      scenario:
        '`total_amount` differing from the pricing-engine quote, or an unsupported `payment_method`.',
      expected_outcome:
        'The order is refused before ERP dispatch; no draft or pending order is created.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.create_order` row (§4.2 skill 14).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-001.OrderConnector` through the tool port.
 */
export function createSalesCreateOrder(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesCreateOrder, OutputSalesCreateOrder> {
  return definePlatformRow<InputSalesCreateOrder, OutputSalesCreateOrder>(deps, {
    ...spec,
    skill_id: SALES_CREATE_ORDER_SKILL_ID,
  });
}

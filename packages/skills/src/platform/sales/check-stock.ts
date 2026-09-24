/**
 * @file Row `skill.sales.check_stock` — real-time available-to-promise inventory across warehouses.
 * Transcribed from `implement/05-skill-system-specifications.md` §4.2 skill 9 (lines 1201-1259); its
 * effect class and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from
 * the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.check_stock` (§4.2 skill 9). */
export interface InputSalesCheckStock {
  tenant_id: string;
  sku_id: string;
  warehouse_id?: string;
}

/** Output of `skill.sales.check_stock` (§4.2 skill 9). */
export interface OutputSalesCheckStock {
  sku_id: string;
  available_quantity: number;
  in_stock: boolean;
  lead_time_days?: number;
  checked_at: string;
}

/** Immutable identifier of this row (§4.2 skill 9). */
export const SALES_CHECK_STOCK_SKILL_ID = 'skill.sales.check_stock';

/** Strict input schema of §4.2 skill 9, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'sku_id'],
  properties: {
    tenant_id: { type: 'string' },
    sku_id: { type: 'string' },
    warehouse_id: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 9, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['sku_id', 'available_quantity', 'in_stock', 'checked_at'],
  properties: {
    sku_id: { type: 'string' },
    available_quantity: { type: 'integer', minimum: 0 },
    in_stock: { type: 'boolean' },
    lead_time_days: { type: 'integer' },
    checked_at: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 9). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Retrieves real-time available-to-promise inventory across warehouses.',
  effect_class: 'READ',
  guarded_dependency: 'API-001.InventoryConnector',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-01', 'SAL-02', 'CS-01'],
  required_authority: 'AUTH-0',
  tool_binding: 'API-001.InventoryConnector',
  validation_rules: [
    'sku_id must exist in active catalog',
    'fail closed if WMS offline',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 500,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['SKU_NOT_FOUND'],
  },
  timeout_ms: 3000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_INVENTORY_CHECK',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-01` at `AUTH-0` reads availability for one `sku_id` and the WMS answers.',
      expected_outcome: '`available_quantity` + `in_stock` from the WMS',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario: 'A `sku_id` absent from the active catalog is requested.',
      expected_outcome:
        'SKU absent → `SKU_NOT_FOUND`; never a fabricated availability of 0',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A payload without `sku_id` is submitted.',
      expected_outcome: 'Missing `sku_id` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        "The WMS/inventory adapter is unreachable and the row's retry budget elapses (timeout 3000ms).",
      expected_outcome:
        'WMS down → `AUTHORITATIVE_SOURCE_UNAVAILABLE` after ≤3; stale cache never served as FACT',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The same `sku_id`/`warehouse_id` read is invoked twice.',
      expected_outcome:
        'Repeat read returns one latest snapshot; no reservation created',
      required: true,
    },
    {
      test_id: 'TC-SKILL-09-06',
      category: 'RESILIENCE',
      scenario: 'WMS/inventory adapter unreachable.',
      expected_outcome:
        'Fail closed with no `in_stock` claim; a stale cached quantity is never served as a FACT (`fail closed if WMS offline`).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-09-07',
      category: 'BOUNDARY',
      scenario: '`sku_id` absent from the active catalog.',
      expected_outcome:
        '`SKU_NOT_FOUND` (non-retryable); no availability of 0 is fabricated.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.check_stock` row (§4.2 skill 9).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-001.InventoryConnector` through the tool port.
 */
export function createSalesCheckStock(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesCheckStock, OutputSalesCheckStock> {
  return definePlatformRow<InputSalesCheckStock, OutputSalesCheckStock>(deps, {
    ...spec,
    skill_id: SALES_CHECK_STOCK_SKILL_ID,
  });
}

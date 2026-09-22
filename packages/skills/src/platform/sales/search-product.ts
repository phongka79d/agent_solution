/**
 * @file Row `skill.sales.search_product` — catalog keyword, category, or semantic vector search.
 * Transcribed from `implement/05-skill-system-specifications.md` §4.2 skill 8 (lines 1131-1199); its
 * effect class and circuit-breaker key come from the §6.5 matrix, its baseline case outcomes from
 * the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.search_product` (§4.2 skill 8); `limit` carries a JSON-Schema `default`. */
export interface InputSalesSearchProduct {
  tenant_id: string;
  query: string;
  category_id?: string;
  limit?: number;
}

/** Output of `skill.sales.search_product` (§4.2 skill 8). */
export interface OutputSalesSearchProduct {
  products: Array<{
    product_id: string;
    sku: string;
    name: string;
    list_price: number;
    currency: string;
    in_stock: boolean;
  }>;
  total_found: number;
}

/** Immutable identifier of this row (§4.2 skill 8). */
export const SALES_SEARCH_PRODUCT_SKILL_ID = 'skill.sales.search_product';

/** Strict input schema of §4.2 skill 8, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'query'],
  properties: {
    tenant_id: { type: 'string' },
    query: { type: 'string', minLength: 1 },
    category_id: { type: 'string' },
    limit: { type: 'integer', default: 5, maximum: 20 },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 8, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['products', 'total_found'],
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        required: ['product_id', 'sku', 'name', 'list_price', 'currency', 'in_stock'],
        properties: {
          product_id: { type: 'string' },
          sku: { type: 'string' },
          name: { type: 'string' },
          list_price: { type: 'number' },
          currency: { type: 'string' },
          in_stock: { type: 'boolean' },
        },
      },
    },
    total_found: { type: 'integer' },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 8). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Performs catalog keyword, category, or semantic vector search for products.',
  effect_class: 'READ',
  guarded_dependency: 'API-001.CatalogConnector',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-01', 'SAL-02'],
  required_authority: 'AUTH-0',
  tool_binding: 'API-001.CatalogConnector',
  validation_rules: [
    'query must not contain SQL or prompt injection tokens',
    'limit <= 20',
  ],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 300,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['MALFORMED_QUERY'],
  },
  timeout_ms: 1500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_CATALOG_SEARCH',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-01` at `AUTH-0` searches the tenant catalog with a schema-valid `query` and an in-bound `limit`, and API-001.CatalogConnector answers.',
      expected_outcome:
        '≤20 catalog matches with list price and stock flag from API-001',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        "A caller outside `allowed_agents` invokes the row, and a second run searches another tenant's catalog.",
      expected_outcome:
        'Unlisted agent → `UNAUTHORIZED_AGENT`; cross-tenant catalog → 0 rows',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        '`limit` 21 is submitted, and a `query` carrying injection tokens is submitted.',
      expected_outcome:
        '`limit=21` or injection tokens → `MALFORMED_QUERY` pre-adapter',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'API-001.CatalogConnector does not answer within the row timeout of 1500ms.',
      expected_outcome:
        'Read-only ≤3; exhaustion → `SKILL_EXECUTION_FAILED`; no cached price presented as live',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The identical search is invoked twice against the same catalog version.',
      expected_outcome:
        'Repeat returns the same result set for the same catalog version; no side effect',
      required: true,
    },
    {
      test_id: 'TC-SKILL-08-06',
      category: 'SECURITY',
      scenario: '`query` containing SQL or prompt-injection tokens.',
      expected_outcome:
        '`MALFORMED_QUERY` (non-retryable); the catalog adapter is never called.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-08-07',
      category: 'BOUNDARY',
      scenario: '`limit` = 21, or `limit` omitted.',
      expected_outcome:
        '`limit` 21 is rejected; an omitted `limit` defaults to 5 and never exceeds 20.',
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.search_product` row (§4.2 skill 8).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `API-001.CatalogConnector` through the tool port.
 */
export function createSalesSearchProduct(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesSearchProduct, OutputSalesSearchProduct> {
  return definePlatformRow<InputSalesSearchProduct, OutputSalesSearchProduct>(deps, {
    ...spec,
    skill_id: SALES_SEARCH_PRODUCT_SKILL_ID,
  });
}

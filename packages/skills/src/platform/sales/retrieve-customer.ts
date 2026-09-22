/**
 * @file Row `skill.sales.retrieve_customer` — Customer 360 hydration (profile, order history,
 * preferences) at `AUTH-0`. Transcribed from `implement/05-skill-system-specifications.md` §4.2
 * skill 11 (lines 1329-1387); its effect class and circuit-breaker key come from the §6.5 matrix,
 * its baseline case outcomes from the §6.6 table.
 */

import { definePlatformRow, type PlatformRowSpec } from '../row.js';
import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';

/** Input of `skill.sales.retrieve_customer` (§4.2 skill 11). */
export interface InputSalesRetrieveCustomer {
  tenant_id: string;
  customer_identifier: string;
}

/** Output of `skill.sales.retrieve_customer` (§4.2 skill 11). */
export interface OutputSalesRetrieveCustomer {
  customer_id: string;
  total_orders: number;
  lifetime_value: number;
  verified: boolean;
  rfm_segment: string;
  last_order_date: string | null;
}

/** Immutable identifier of this row (§4.2 skill 11). */
export const SALES_RETRIEVE_CUSTOMER_SKILL_ID = 'skill.sales.retrieve_customer';

/** Strict input schema of §4.2 skill 11, verbatim. */
const input_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['tenant_id', 'customer_identifier'],
  properties: {
    tenant_id: { type: 'string' },
    customer_identifier: { type: 'string' },
  },
  additionalProperties: false,
};

/** Output schema of §4.2 skill 11, verbatim. */
const output_schema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['customer_id', 'total_orders', 'lifetime_value', 'verified', 'rfm_segment'],
  properties: {
    customer_id: { type: 'string' },
    total_orders: { type: 'integer' },
    lifetime_value: { type: 'number' },
    verified: { type: 'boolean' },
    rfm_segment: { type: 'string' },
    last_order_date: { type: ['string', 'null'] },
  },
};

/** The declarative half of the row; `skill_id` is supplied by the factory (§4.2 skill 11). */
const spec: Omit<
  PlatformRowSpec,
  'skill_id'
> = {
  purpose:
    'Hydrates Customer 360 profile, order history, and preferences (AUTH-0 read-only).',
  effect_class: 'READ',
  guarded_dependency: 'PostgreSQL.Customer360Store',
  input_schema,
  output_schema,
  allowed_agents: ['SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05'],
  required_authority: 'AUTH-0',
  tool_binding: 'PostgreSQL.Customer360Store',
  validation_rules: ['tenant isolation boundary verified by RLS'],
  retry_policy: {
    max_retries: 3,
    initial_interval_ms: 300,
    backoff_multiplier: 1.5,
    retry_on_timeout: true,
    non_retryable_errors: ['NOT_FOUND'],
  },
  timeout_ms: 1500,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: ['customer_id', 'customer_identifier'],
    evidence_card: 'EV_CUSTOMER_HYDRATION',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        '`SAL-01` at `AUTH-0` reads the profile bound to its verified session identity.',
      expected_outcome: 'Verified session → profile for the bound customer only',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A run whose identity resolved to `UNRESOLVED` or whose bound `customer_id` differs from the requested profile; and a read attempted across tenants.',
      expected_outcome:
        'Identity `UNRESOLVED` or mismatched `customer_id` → refused, 0 rows; cross-tenant → 0 rows',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario: 'A payload without `customer_identifier` is submitted.',
      expected_outcome: 'Missing `customer_identifier` → `SCHEMA_VALIDATION_ERROR`',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario:
        'PostgreSQL.Customer360Store does not answer within the row timeout of 1500ms.',
      expected_outcome:
        'Store error ≤3; exhaustion refuses rather than returning a partial profile',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario:
        'The same `(tenant_id, customer_identifier)` read is invoked twice.',
      expected_outcome: 'Read-only: identical result; no profile mutation',
      required: true,
    },
    {
      test_id: 'TC-SKILL-11-06',
      category: 'AUTHORITY',
      scenario:
        'Run whose identity resolved to `UNRESOLVED`, or whose bound `customer_id` differs from the requested profile.',
      expected_outcome:
        'The call is refused and zero profile rows are released; an anonymous session never receives a Customer 360 FACT (BR-004, NFR-006).',
      required: true,
    },
    {
      test_id: 'TC-SKILL-11-07',
      category: 'SECURITY',
      scenario: 'Read attempted across tenants.',
      expected_outcome:
        "0 rows by RLS; the response does not disclose whether the other tenant's customer exists.",
      required: true,
    },
  ],
};

/**
 * Builds the `skill.sales.retrieve_customer` row (§4.2 skill 11).
 *
 * @param deps Injected tool port and clock; the row holds no ambient dependency.
 * @returns The row, with `validateInput` normalizing through its `input_schema` and `execute`
 *   dispatching `PostgreSQL.Customer360Store` through the tool port.
 */
export function createSalesRetrieveCustomer(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputSalesRetrieveCustomer, OutputSalesRetrieveCustomer> {
  return definePlatformRow<InputSalesRetrieveCustomer, OutputSalesRetrieveCustomer>(deps, {
    ...spec,
    skill_id: SALES_RETRIEVE_CUSTOMER_SKILL_ID,
  });
}

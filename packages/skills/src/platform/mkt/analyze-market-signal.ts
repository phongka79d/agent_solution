/**
 * @file `skill.mkt.analyze_market_signal` — Marketing row 1 of the platform registry, transcribed
 * verbatim from `implement/05` §4.1 (lines 643-711), with the effect class and guarded dependency
 * of the §6.5 matrix and this row's baseline outcomes from §6.6.
 *
 * The module is data plus its factory call: `definePlatformRow` supplies the single normalization
 * and the single dispatch route, so this row cannot validate less than its schema declares or reach
 * an adapter by another path. Enablement is deliberately absent — the gate decides it.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { definePlatformRow, type PlatformRowSpec } from '../row.js';

/** §4.1 field 3 `Input*` of the row, normalized: no property carries a JSON-Schema `default`. */
export interface InputMktAnalyzeSignal {
  tenant_id: string;
  market_region: 'TW' | 'GLOBAL_US' | 'GLOBAL_EU' | 'VN';
  category_id: string;
  observation_window_days: number;
}

/** §4.1 field 4 `Output*` of the row. */
export interface OutputMktAnalyzeSignal {
  signals: Array<{ signal_id: string; keyword: string; search_volume_growth: number; price_pressure_index: number }>;
  trend_velocity: 'SLOW' | 'STABLE' | 'RAPID' | 'EXPLOSIVE';
  analyzed_at: string;
}

/** Canonical id of §4.1 skill 1: the immutable key every dispatch envelope resolves by. */
export const ANALYZE_MARKET_SIGNAL_SKILL_ID = 'skill.mkt.analyze_market_signal';

/** The §4.1 row without its id; {@link ANALYZE_MARKET_SIGNAL_SKILL_ID} is bound at construction. */
const spec: Omit<PlatformRowSpec, 'skill_id'> = {
  purpose:
    'Analyzes external digital trends, competitor catalog movements, and search velocity to derive market signals.',
  effect_class: 'READ',
  guarded_dependency: 'API-002.EventIngestion',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['tenant_id', 'market_region', 'category_id', 'observation_window_days'],
    properties: {
      tenant_id: { type: 'string' },
      market_region: { type: 'string', enum: ['TW', 'GLOBAL_US', 'GLOBAL_EU', 'VN'] },
      category_id: { type: 'string' },
      observation_window_days: { type: 'integer', minimum: 1, maximum: 90 },
    },
    additionalProperties: false,
  },
  output_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['signals', 'trend_velocity', 'analyzed_at'],
    properties: {
      signals: {
        type: 'array',
        items: {
          type: 'object',
          required: ['signal_id', 'keyword', 'search_volume_growth', 'price_pressure_index'],
          properties: {
            signal_id: { type: 'string' },
            keyword: { type: 'string' },
            search_volume_growth: { type: 'number' },
            price_pressure_index: { type: 'number' },
          },
        },
      },
      trend_velocity: { type: 'string', enum: ['SLOW', 'STABLE', 'RAPID', 'EXPLOSIVE'] },
      analyzed_at: { type: 'string', format: 'date-time' },
    },
  },
  allowed_agents: ['MKT-01', 'MKT-02'],
  required_authority: 'AUTH-1',
  tool_binding: 'API-002.EventIngestion',
  validation_rules: [
    'observation_window_days must be between 1 and 90',
    'tenant_id must be authorized for specified market_region',
  ],
  retry_policy: {
    max_retries: 2,
    initial_interval_ms: 1000,
    backoff_multiplier: 2.0,
    retry_on_timeout: true,
    non_retryable_errors: ['INVALID_REGION', 'CATEGORY_NOT_FOUND'],
  },
  timeout_ms: 3000,
  audit_spec: {
    log_level: 'INFO',
    mask_pii_fields: [],
    evidence_card: 'EV_MKT_SIGNAL_ANALYSIS',
    record_latency: true,
  },
  test_cases: [
    {
      test_id: 'TC-SKILL-01',
      category: 'HAPPY_PATH',
      scenario:
        'Valid input payload submitted by MKT-01 or MKT-02 holding an AUTH-1 grant; API-002.EventIngestion answers inside the declared deadline.',
      expected_outcome:
        '`MKT-01`/`MKT-02` at `AUTH-1` → one `API-002.EventIngestion` read, schema-valid output, `EV_MKT_SIGNAL_ANALYSIS` with latency',
      required: true,
    },
    {
      test_id: 'TC-SKILL-02',
      category: 'AUTHORITY',
      scenario:
        'A run whose caller is absent from `allowed_agents`, or which presents an `AUTH-0` grant against the `AUTH-1` requirement.',
      expected_outcome:
        'Unlisted agent → `UNAUTHORIZED_AGENT`; `AUTH-0` run → `INSUFFICIENT_AUTHORITY`; 0 adapter calls',
      required: true,
    },
    {
      test_id: 'TC-SKILL-03',
      category: 'SCHEMA_INVALIDATION',
      scenario:
        'Input missing a required field, or carrying an illegal extra property, against the declared `input_schema`.',
      expected_outcome:
        '`observation_window_days` out of range → `SCHEMA_VALIDATION_ERROR`; 0 calls',
      required: true,
    },
    {
      test_id: 'TC-SKILL-04',
      category: 'TIMEOUT',
      scenario: 'The bound `API-002.EventIngestion` read hangs past `timeout_ms` of 3000ms.',
      expected_outcome:
        'Read-only: `TIMEOUT` retried within ≤2; exhaustion → `SKILL_EXECUTION_FAILED`, one breaker failure',
      required: true,
    },
    {
      test_id: 'TC-SKILL-05',
      category: 'IDEMPOTENCY',
      scenario: 'The identical read request for the same tenant, region, category and window is submitted twice.',
      expected_outcome:
        'Repeat read yields the same signals; no duplicate signal row, no divergent payload',
      required: true,
    },
    {
      test_id: 'TC-SKILL-01-06',
      category: 'BOUNDARY',
      scenario: '`observation_window_days` = 0 or 91.',
      expected_outcome:
        '`SCHEMA_VALIDATION_ERROR` before any `API-002.EventIngestion` call; no signal and no `trend_velocity` output.',
      required: true,
    },
    {
      test_id: 'TC-SKILL-01-07',
      category: 'SECURITY',
      scenario:
        "`market_region` outside the tenant's authorized regions, or a `tenant_id` from another tenant.",
      expected_outcome:
        '`INVALID_REGION` (non-retryable) with zero rows; no cross-tenant signal is released (RLS, NFR-006).',
      required: true,
    },
  ],
};

/**
 * Builds the §4.1 skill 1 row.
 *
 * @param deps The injected tool port and clock; the row holds no ambient dependency.
 * @returns The `skill.mkt.analyze_market_signal` row, without an `enabled` flag — the gate owns that.
 */
export function createMktAnalyzeSignal(
  deps: PlatformSkillDependencies,
): PlatformSkillRow<InputMktAnalyzeSignal, OutputMktAnalyzeSignal> {
  return definePlatformRow<InputMktAnalyzeSignal, OutputMktAnalyzeSignal>(deps, {
    ...spec,
    skill_id: ANALYZE_MARKET_SIGNAL_SKILL_ID,
  });
}

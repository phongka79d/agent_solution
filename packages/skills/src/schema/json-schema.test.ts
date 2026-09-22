/**
 * @file Deterministic schema contract (implement/05 §2 "JSON Schema / Type Guard", §3 input/output
 * schemas stored as `input_schema` / `output_schema`, §8 scenarios 10-11).
 *
 * Two properties are under test: a construct the validator cannot enforce is refused at
 * REGISTRATION, so runtime validation can never silently skip a declared constraint; and
 * normalization — defaults applied, undeclared members stripped — never coerces a value.
 */

import { describe, expect, it } from 'vitest';

import { isSkillError } from '../contracts/index.js';
import { expectRefusal } from '../testing/refusal.js';
import {
  assertSupportedSchema,
  normalizeAgainstSchema,
  validateAgainstSchema,
} from './index.js';

const OBJECT_SCHEMA: Record<string, unknown> = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['sku_id', 'quantity'],
  properties: {
    sku_id: { type: 'string', minLength: 3, pattern: '^SKU-' },
    quantity: { type: 'integer', minimum: 1, maximum: 99 },
    currency: { type: 'string', enum: ['TWD', 'USD'] },
    note: { type: ['string', 'null'] },
  },
  additionalProperties: false,
});

describe('assertSupportedSchema', () => {
  it('accepts the keyword set the platform rows actually declare', () => {
    expect(() => assertSupportedSchema('skill.test.fixture', OBJECT_SCHEMA)).not.toThrow();
    expect(() =>
      assertSupportedSchema('skill.test.fixture', {
        type: 'object',
        required: ['signals'],
        properties: {
          signals: {
            type: 'array',
            items: {
              type: 'object',
              required: ['signal_id', 'search_volume_growth'],
              properties: {
                signal_id: { type: 'string' },
                search_volume_growth: { type: 'number' },
              },
            },
          },
          trend_velocity: { type: 'string', enum: ['SLOW', 'STABLE'] },
          analyzed_at: { type: 'string', format: 'date-time' },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ['an unknown keyword', { type: 'object', unevaluatedProperties: false }],
    ['an unsupported format', { type: 'string', format: 'hostname' }],
    ['an uncompilable pattern', { type: 'string', pattern: '(' }],
    ['an unknown type name', { type: 'date' }],
    ['a non-object schema node', { type: 'object', properties: { sku_id: 'string' } }],
  ])('refuses %s', (_label, schema) => {
    expectRefusal(
      () => assertSupportedSchema('skill.test.fixture', schema as Record<string, unknown>),
      'INVALID_SCHEMA',
    );
  });

  it('refuses an unsupported construct nested below a property', () => {
    expectRefusal(
      () =>
        assertSupportedSchema('skill.test.fixture', {
          type: 'object',
          properties: { inner: { type: 'object', dependentRequired: {} } },
        }),
      'INVALID_SCHEMA',
    );
  });
});

describe('normalizeAgainstSchema', () => {
  it('applies a declared default and strips undeclared members when additionalProperties is false', () => {
    const normalized = normalizeAgainstSchema<Record<string, unknown>>(
      'skill.test.fixture',
      OBJECT_SCHEMA,
      { sku_id: 'SKU-1', quantity: 2, note: null, smuggled: 'value' },
    );

    expect(normalized).toEqual({ sku_id: 'SKU-1', quantity: 2, note: null });
  });

  it('does not invent a member that is absent and has no default', () => {
    const normalized = normalizeAgainstSchema<Record<string, unknown>>(
      'skill.test.fixture',
      OBJECT_SCHEMA,
      { sku_id: 'SKU-1', quantity: 2 },
    );

    expect(Object.hasOwn(normalized, 'currency')).toBe(false);
    expect(Object.hasOwn(normalized, 'note')).toBe(false);
  });

  it('never coerces a value', () => {
    expectRefusal(
      () =>
        normalizeAgainstSchema('skill.test.fixture', OBJECT_SCHEMA, {
          sku_id: 'SKU-1',
          quantity: '2',
        }),
      'SCHEMA_VALIDATION_ERROR',
    );
  });

  it.each([
    ['a missing required member', { quantity: 1 }],
    ['a range breach', { sku_id: 'SKU-1', quantity: 100 }],
    ['an enum miss', { sku_id: 'SKU-1', quantity: 1, currency: 'EUR' }],
    ['a pattern breach', { sku_id: 'AB-1', quantity: 1 }],
    ['a length breach', { sku_id: 'SK', quantity: 1 }],
    ['a null where a string is required', { sku_id: null, quantity: 1 }],
  ])('refuses %s', (_label, value) => {
    expectRefusal(
      () => normalizeAgainstSchema('skill.test.fixture', OBJECT_SCHEMA, value),
      'SCHEMA_VALIDATION_ERROR',
    );
  });

  it('reports every violation, with a path, in one refusal', () => {
    let message = '';
    try {
      normalizeAgainstSchema('skill.test.fixture', OBJECT_SCHEMA, { quantity: 100 });
    } catch (error) {
      message = isSkillError(error) ? error.message : '';
    }

    expect(message).toContain('sku_id');
    expect(message).toContain('quantity');
    expect(message).toContain('$.quantity');
  });
});

describe('validateAgainstSchema', () => {
  it('returns no violation for a conforming value and all violations otherwise', () => {
    expect(
      validateAgainstSchema(OBJECT_SCHEMA, { sku_id: 'SKU-1', quantity: 1 }),
    ).toEqual([]);

    const violations = validateAgainstSchema(OBJECT_SCHEMA, {
      sku_id: 'AB',
      quantity: 0,
      currency: 'EUR',
    });

    expect(violations.map((violation) => violation.keyword).sort()).toEqual([
      'enum',
      'minLength',
      'minimum',
      'pattern',
    ]);
  });

  it('validates arrays, uniqueness and composition keywords', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      required: ['codes'],
      properties: {
        codes: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } },
        mode: { oneOf: [{ const: 'A' }, { const: 'B' }] },
        tag: { allOf: [{ type: 'string' }, { minLength: 2 }] },
        blocked: { not: { const: 'forbidden' } },
      },
    };

    expect(
      validateAgainstSchema(schema, { codes: ['a', 'b'], mode: 'A', tag: 'xy', blocked: 'ok' }),
    ).toEqual([]);
    expect(
      validateAgainstSchema(schema, { codes: ['a', 'a', 'c'], mode: 'C', tag: 'x', blocked: 'forbidden' })
        .map((violation) => violation.keyword)
        .sort(),
    ).toEqual(['allOf', 'maxItems', 'not', 'oneOf', 'uniqueItems']);
  });

  it('validates declared formats without a clock or a locale', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        at: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
      },
    };

    expect(
      validateAgainstSchema(schema, { at: '2026-01-01T00:00:00Z', id: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
    ).toEqual([]);
    expect(
      validateAgainstSchema(schema, { at: '2026-01-01', id: 'not-a-uuid' }).map(
        (violation) => violation.keyword,
      ),
    ).toEqual(['format', 'format']);
  });
});

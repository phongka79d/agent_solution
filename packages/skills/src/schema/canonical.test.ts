/**
 * @file Byte contract of the schema layer's canonical form (T11.2, implement/04 §6.1).
 *
 * Schema comparisons and test-double digests consume the shared core-engine canonical serializer,
 * which delegates to the database leaf implementation. Literal fixtures keep the byte contract
 * independent of the implementation. Non-JSON values fail comparisons without throwing from the
 * validator or colliding with a JSON value that resembles a former type marker.
 */

import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '@agentos/core-engine/canonical-json';

import { testDigest } from '../testing/harness.js';
import { validateAgainstSchema } from './validate.js';

const FIXTURES: ReadonlyArray<{ name: string; value: unknown; bytes: string; digest: string }> = [
  {
    name: 'object with reordered members and non-ASCII text',
    value: { b: [1, { d: 4, c: 3 }], a: { z: 1, A: 2 }, s: 'é' },
    bytes: '{"a":{"A":2,"z":1},"b":[1,{"c":3,"d":4}],"s":"é"}',
    digest: '79a8c2e4a0ed129637f03da60f5f09477d0281df0bc1af30d0c6c7a403d818f1',
  },
  {
    name: 'BR-005 effect identity',
    value: {
      tenant_id: 'tenant-1',
      skill_id: 'skill-1',
      step_index: 2,
      action_revision: 0,
      request_id: 'request-1',
    },
    bytes:
      '{"action_revision":0,"request_id":"request-1","skill_id":"skill-1","step_index":2,' +
      '"tenant_id":"tenant-1"}',
    digest: 'b8ae20396d5b77d3ea803ff80946553eed5853e9de57b14f903d822b2556050f',
  },
  {
    name: 'number renderings',
    value: { neg_zero: -0, huge: 1e21, tiny: 1e-7, int: 3, frac: 0.5 },
    bytes: '{"frac":0.5,"huge":1e+21,"int":3,"neg_zero":0,"tiny":1e-7}',
    digest: '9502ce80a5919c62687ef9490c2db58e8213179ca0a2a289a60be1a33b1f6a8e',
  },
  {
    name: 'escapes and unicode keys',
    value: { 'a"b': 'line\nbreak\ttab', é: 1, A: true, '': null },
    bytes: '{"":null,"A":true,"a\\"b":"line\\nbreak\\ttab","é":1}',
    digest: 'e93eae38c946b52c7815ff22ab9f2a1f38bc2a5c23bc7216b5c260aeec23b3bb',
  },
  {
    name: 'empty containers',
    value: { list: [], map: {}, nested: [[]] },
    bytes: '{"list":[],"map":{},"nested":[[]]}',
    digest: '70d34af85b6fc5ad214999a4c7694b3cfa1d60e329b1b3d9de6b5968d881d95f',
  },
];

describe('canonical schema comparisons', () => {
  for (const { name, value, bytes, digest } of FIXTURES) {
    it(`writes the bytes the engine and database writers write for ${name}`, () => {
      expect(canonicalizeJson(value)).toBe(bytes);
      // The test double digests the same bytes, so a skill suite asserting an effect key cannot
      // disagree with the engine that produced it.
      expect(testDigest(value)).toBe(digest);
    });
  }

  it('compares const, enum and uniqueItems by content rather than member order', () => {
    const value = { a: 1, b: [2, 3] };
    const reordered = { b: [2, 3], a: 1 };

    expect(validateAgainstSchema({ const: value }, reordered)).toEqual([]);
    expect(validateAgainstSchema({ enum: [{ a: 2 }, value] }, reordered)).toEqual([]);
    expect(
      validateAgainstSchema({ uniqueItems: true }, [value, reordered])
        .map((violation) => violation.keyword),
    ).toEqual(['uniqueItems']);
    expect(
      validateAgainstSchema({ const: value }, { a: 2, b: [2, 3] })
        .map((violation) => violation.keyword),
    ).toEqual(['const']);
  });

  it('never matches unsupported values to JSON marker-shaped constants', () => {
    const value = { a: undefined };
    const marker = { a: ['<undefined>'] };

    expect(
      validateAgainstSchema({ const: marker }, value).map((violation) => violation.keyword),
    ).toEqual(['const']);
    expect(
      validateAgainstSchema({ const: value }, marker).map((violation) => violation.keyword),
    ).toEqual(['const']);
    expect(
      validateAgainstSchema({ const: value }, value).map((violation) => violation.keyword),
    ).toEqual(['const']);
  });

  it('refuses unsupported enum values while continuing past unsupported members', () => {
    const schema = { enum: [undefined, { a: 1 }] };

    expect(validateAgainstSchema(schema, { a: 1 })).toEqual([]);
    expect(
      validateAgainstSchema(schema, undefined).map((violation) => violation.keyword),
    ).toEqual(['enum']);
  });

  it('reports invalid uniqueItems members without throwing from validation', () => {
    expect(
      validateAgainstSchema({ uniqueItems: true }, [{ n: Number.NaN }, ['<non-finite number>']])
        .map(({ path, keyword }) => ({ path, keyword })),
    ).toEqual([{ path: '$', keyword: 'uniqueItems' }]);
  });
});

/**
 * @file One byte contract, every writer (implement/04 §6.1, implement/08 §4.2; T11.2).
 *
 * Four modules used to serialize canonical JSON: this package's durable helpers, the effect-layer
 * compatibility export, `@agentos/database`'s leaf copy (the implementation the other three now
 * delegate to) and the `effect_key` derivation. A digest disagreement between two of them is a
 * security defect — the writer and the verifier would hash different bytes for one payload — so the
 * fixtures below pin each call site to the SAME literal byte string and the SAME literal digest.
 *
 * The expectations are literals on purpose: a test that compared the call sites to each other would
 * stay green if they all drifted together.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeJson as databaseCanonicalizeJson,
  sha256CanonicalJson as databaseSha256CanonicalJson,
} from '@agentos/database/canonical-json';

import { canonicalizeJson as effectCanonicalizeJson } from '../effects/canonical-json.js';
import { computeEffectKey, computeRequestFingerprint } from '../effects/effect-key.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import {
  canonicalizeJson as durableCanonicalizeJson,
  sha256CanonicalJson as durableSha256CanonicalJson,
} from './canonical-json.js';

/** The BR-005 identity fixture, reused so `effect_key` is pinned to the same bytes as the payload. */
const IDENTITY = {
  tenant_id: 'tenant-1',
  skill_id: 'skill-1',
  step_index: 2,
  action_revision: 0,
  request_id: 'request-1',
} as const;

/**
 * Fixture values with the canonical bytes and SHA-256 digest every writer must agree on.
 *
 * `number renderings` covers `-0` (rendered `0`), `1e21` (rendered `1e+21`) and `1e-7`; `escapes and
 * unicode keys` covers the empty member name, surrogate-safe escaping and member order across ASCII
 * and non-ASCII keys.
 */
const FIXTURES: ReadonlyArray<{ name: string; value: unknown; bytes: string; digest: string }> = [
  {
    name: 'object with reordered members and non-ASCII text',
    value: { b: [1, { d: 4, c: 3 }], a: { z: 1, A: 2 }, s: 'é' },
    bytes: '{"a":{"A":2,"z":1},"b":[1,{"c":3,"d":4}],"s":"é"}',
    digest: '79a8c2e4a0ed129637f03da60f5f09477d0281df0bc1af30d0c6c7a403d818f1',
  },
  {
    name: 'BR-005 effect identity',
    value: IDENTITY,
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

describe('canonical JSON writers agree byte for byte', () => {
  for (const { name, value, bytes, digest } of FIXTURES) {
    it(`writes the pinned bytes and digest for ${name}`, () => {
      expect(durableCanonicalizeJson(value)).toBe(bytes);
      expect(databaseCanonicalizeJson(value)).toBe(bytes);
      expect(effectCanonicalizeJson(value)).toBe(bytes);

      expect(durableSha256CanonicalJson(value)).toBe(digest);
      expect(databaseSha256CanonicalJson(value)).toBe(digest);
    });
  }

  it('derives every digest through the same serializer', () => {
    const guard = new MemoryEffectGuard();

    expect(computeEffectKey(IDENTITY)).toBe(FIXTURES[1]!.digest);
    expect(guard.computeEffectKey(IDENTITY)).toBe(FIXTURES[1]!.digest);
    expect(computeRequestFingerprint(IDENTITY)).toBe(FIXTURES[1]!.digest);
    expect(guard.computeRequestFingerprint(IDENTITY)).toBe(FIXTURES[1]!.digest);
  });

  it('keeps the effect-layer refusal vocabulary while the bytes stay identical', () => {
    // Same bytes on the success path, different code on the refusal path: the effect layer names
    // its own refusal so callers keep the code they were written against.
    expect(() => effectCanonicalizeJson({ a: undefined })).toThrowError(
      /CANONICAL_JSON_UNSUPPORTED/,
    );
    expect(() => durableCanonicalizeJson({ a: undefined })).toThrowError(
      /CANONICAL_JSON_INVALID/,
    );
  });
});

/**
 * @file Byte contract of the leaf canonical-JSON implementation (T11.2, implement/04 §6.1).
 *
 * `packages/database` is a leaf of the package DAG, so it carries the serializer every other layer
 * re-exports: `@agentos/database/canonical-json`, `repositories/approvals.ts`, the durable-workflow
 * `canonicalizeEvent` replay comparison and `@agentos/core-engine`'s durability/effect helpers.
 * The literals below are the bytes and digests those call sites must all produce; a change here is a
 * change to every durable digest in the platform, which is exactly why the test states them rather
 * than recomputing them.
 */

import { describe, expect, it } from 'vitest';

import { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js';
import { canonicalizeJson as approvalCanonicalizeJson } from './approvals.js';
import { canonicalizeEvent } from './durable-workflows.guards.js';

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

describe('canonicalizeJson', () => {
  for (const { name, value, bytes, digest } of FIXTURES) {
    it(`writes the pinned bytes and digest for ${name}`, () => {
      expect(canonicalizeJson(value)).toBe(bytes);
      expect(sha256CanonicalJson(value)).toBe(digest);
      // The approval repository re-exports this serializer rather than carrying its own copy.
      expect(approvalCanonicalizeJson(value)).toBe(bytes);
    });
  }
});

describe('canonicalizeEvent', () => {
  it('compares replayed resume events by the shared canonical bytes', () => {
    for (const { name, value, bytes } of FIXTURES) {
      expect(canonicalizeEvent(value), name).toBe(bytes);
    }

    const stored = { step: 3, sku: 'SKU-1', meta: { b: 2, a: 1 } };
    const replayed = JSON.parse(JSON.stringify({ meta: { a: 1, b: 2 }, sku: 'SKU-1', step: 3 }));

    expect(canonicalizeEvent(replayed)).toBe(canonicalizeEvent(stored));
  });

  it('keeps its repository refusal code for a payload the serializer cannot represent', () => {
    expect(() => canonicalizeEvent({ step: undefined })).toThrowError(/TASK_PAYLOAD_UNSERIALIZABLE/);
    expect(() => canonicalizeEvent(new Date('2026-10-01T00:00:00.000Z'))).toThrowError(
      /TASK_PAYLOAD_UNSERIALIZABLE/,
    );
  });
});

/**
 * @file Effect identity tests (implement/04 §3.2.3, BR-005). The key must be a pure function of the
 * five immutable inbound fields, so a replaying run recomputes it byte for byte and cannot mint a
 * second external effect; and canonicalization must fail closed rather than collide two payloads.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OrchestratorError } from '../contracts/types.js';
import { canonicalizeJson } from './canonical-json.js';
import { computeEffectKey, computeRequestFingerprint, type EffectKeyInput } from './effect-key.js';

const IDENTITY: EffectKeyInput = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  skill_id: 'skill.pricing.quote',
  step_index: 2,
  action_revision: 0,
  request_id: 'signal-9f2c',
};

/**
 * The exact canonical bytes of {@link IDENTITY}: keys sorted by code unit, JSON literals, no
 * insignificant whitespace. Pinned as a literal so the digest stays a known quantity.
 */
const CANONICAL_IDENTITY =
  '{"action_revision":0,"request_id":"signal-9f2c","skill_id":"skill.pricing.quote","step_index":2,"tenant_id":"11111111-1111-4111-8111-111111111111"}';

function canonicalizationFailure(value: unknown): string {
  try {
    canonicalizeJson(value);
  } catch (error) {
    return error instanceof OrchestratorError ? error.code : `NOT_ORCHESTRATOR_ERROR:${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('computeEffectKey', () => {
  it('hashes the canonical identity of the inbound request', () => {
    expect(canonicalizeJson(IDENTITY)).toBe(CANONICAL_IDENTITY);
    expect(computeEffectKey(IDENTITY)).toBe(
      createHash('sha256').update(CANONICAL_IDENTITY, 'utf8').digest('hex'),
    );
    expect(computeEffectKey(IDENTITY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is reproducible across the runs that replay the same request', () => {
    // `run_id`, retry counters and timestamps are not inputs: two runs of the same inbound request
    // derive one key, whatever run metadata the caller happens to carry.
    const firstRun = { ...IDENTITY, run_id: 'run-a', attempted_at: '2026-01-01T00:00:00.000Z' } as EffectKeyInput;
    const secondRun = { ...IDENTITY, run_id: 'run-b', attempted_at: '2026-02-02T00:00:00.000Z' } as EffectKeyInput;
    expect(computeEffectKey(firstRun)).toBe(computeEffectKey(secondRun));
    expect(computeEffectKey(secondRun)).toBe(computeEffectKey(IDENTITY));

    expect(Object.keys(JSON.parse(canonicalizeJson(IDENTITY)) as Record<string, unknown>)).toEqual([
      'action_revision',
      'request_id',
      'skill_id',
      'step_index',
      'tenant_id',
    ]);
  });

  it('is independent of the input object key order', () => {
    const reordered: EffectKeyInput = {
      request_id: IDENTITY.request_id,
      tenant_id: IDENTITY.tenant_id,
      step_index: IDENTITY.step_index,
      skill_id: IDENTITY.skill_id,
      action_revision: IDENTITY.action_revision,
    };
    expect(canonicalizeJson(reordered)).toBe(CANONICAL_IDENTITY);
    expect(computeEffectKey(reordered)).toBe(computeEffectKey(IDENTITY));
  });

  it('changes when any bound identity field changes', () => {
    const baseline = computeEffectKey(IDENTITY);
    const variations: readonly EffectKeyInput[] = [
      { ...IDENTITY, tenant_id: '22222222-2222-4222-8222-222222222222' },
      { ...IDENTITY, skill_id: 'skill.pricing.apply_discount' },
      { ...IDENTITY, step_index: 3 },
      { ...IDENTITY, action_revision: 1 },
      { ...IDENTITY, request_id: 'signal-9f2d' },
    ];

    for (const variation of variations) {
      expect(computeEffectKey(variation)).not.toBe(baseline);
    }
    expect(new Set(variations.map((variation) => computeEffectKey(variation))).size).toBe(variations.length);
  });
});

describe('computeRequestFingerprint', () => {
  it('fingerprints the canonical payload, not its serialization order', () => {
    const canonical = computeRequestFingerprint({ message: 'hello', tags: ['a', 'b'] });
    expect(canonical).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestFingerprint({ tags: ['a', 'b'], message: 'hello' })).toBe(canonical);
  });

  it('separates payloads that differ in a value or in array order', () => {
    const baseline = computeRequestFingerprint({ message: 'hello', tags: ['a', 'b'] });
    expect(computeRequestFingerprint({ message: 'hello!', tags: ['a', 'b'] })).not.toBe(baseline);
    expect(computeRequestFingerprint({ message: 'hello', tags: ['b', 'a'] })).not.toBe(baseline);
    expect(computeRequestFingerprint({ message: 'hello' })).not.toBe(baseline);
  });
});

describe('canonicalizeJson', () => {
  it('sorts keys at every level and emits no insignificant whitespace', () => {
    expect(canonicalizeJson({ b: [{ d: 1, c: [2, 3] }], a: 'x' })).toBe(
      '{"a":"x","b":[{"c":[2,3],"d":1}]}',
    );
    expect(canonicalizeJson({ space: '  ', empty: {}, list: [] })).toBe(
      '{"empty":{},"list":[],"space":"  "}',
    );
  });

  it('preserves array order and writes JSON literals for primitives', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalizeJson(null)).toBe('null');
    expect(canonicalizeJson(true)).toBe('true');
    expect(canonicalizeJson(0)).toBe('0');
    expect(canonicalizeJson(1.5)).toBe('1.5');
    expect(canonicalizeJson(-0)).toBe('0');
    expect(canonicalizeJson('a"b')).toBe('"a\\"b"');
  });

  it('treats a null-prototype object as a plain object', () => {
    expect(canonicalizeJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('fails closed on every value that has no canonical form', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const unsupported: readonly unknown[] = [
      undefined,
      () => 'ignored',
      Symbol('effect'),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date('2026-01-01T00:00:00.000Z'),
      new Map([['k', 'v']]),
      new Set([1]),
      { nested: undefined },
      [1, undefined],
      circular,
    ];

    for (const value of unsupported) {
      expect(canonicalizationFailure(value)).toBe('CANONICAL_JSON_UNSUPPORTED');
    }
  });
});

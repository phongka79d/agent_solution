/**
 * @file Byte contract of the canonical JSON and digest primitives (implement/04 §6.1, implement/08
 * §4.2).
 *
 * Every durable digest the platform stores — `effect_key`, `request_fingerprint`,
 * `evidence_records.payload_sha256`, both `chain_hash` chains, every HMAC signature — is computed
 * over the bytes these helpers produce, so the expectations below are written as fixed byte strings
 * and fixed digests rather than as calls back into the module: a writer and a verifier running in
 * different processes must agree on them without sharing an implementation. Values that have no
 * canonical form are asserted to be refused, never silently converted, because a dropped member
 * would let two writers claim to have hashed the same payload while hashing different bytes.
 */

import { describe, expect, it } from 'vitest';

import { OrchestratorError } from '../contracts/index.js';
import {
  canonicalizeJson,
  hmacSha256Hex,
  isSha256Hex,
  sha256CanonicalJson,
  sha256Hex,
} from './canonical-json.js';

/** A class instance: a real object that is not a plain one. */
class Money {
  constructor(readonly amount_thb: number) {}
}

/**
 * The refusal code of a value with no canonical JSON form.
 *
 * @param value - Candidate value.
 * @returns `CANONICAL_JSON_INVALID` when the value was refused, `undefined` when it was accepted.
 * @throws The original error when the failure did not come from the contract, so a broken runtime
 *   is never mistaken for a refusal.
 */
function refusalCode(value: unknown): string | undefined {
  try {
    canonicalizeJson(value);
    return undefined;
  } catch (error) {
    if (error instanceof OrchestratorError) {
      return error.code;
    }

    throw error;
  }
}

describe('canonicalizeJson', () => {
  it('emits one byte sequence for the same value regardless of member order', () => {
    const declaredFirst = { z: 1, a: { d: 4, c: 3 }, list: [2, 1] };
    const declaredLast = { list: [2, 1], a: { c: 3, d: 4 }, z: 1 };

    expect(canonicalizeJson(declaredFirst)).toBe(canonicalizeJson(declaredLast));
    expect(canonicalizeJson(declaredLast)).toBe('{"a":{"c":3,"d":4},"list":[2,1],"z":1}');
  });

  it('sorts members by UTF-16 code unit, never by locale', () => {
    // A locale collator orders 'a' before 'B' and may place 'é' before 'Z'; code units do not.
    expect(canonicalizeJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(canonicalizeJson({ 'é': 3, Z: 2, a: 1, A: 4 })).toBe('{"A":4,"Z":2,"a":1,"é":3}');
  });

  it('preserves array order and writes no insignificant whitespace', () => {
    expect(canonicalizeJson([1, [2, 3], { b: 1, a: 2 }])).toBe('[1,[2,3],{"a":2,"b":1}]');
    expect(canonicalizeJson({ s: 'a\nb"c', n: -0, big: 1e21, t: true, u: null }))
      .toBe('{"big":1e+21,"n":0,"s":"a\\nb\\"c","t":true,"u":null}');
  });

  it('renders numbers exactly as the stored column will render them', () => {
    expect(canonicalizeJson([1e-7, 1e21, -0, 0.1, Number.MAX_SAFE_INTEGER]))
      .toBe('[1e-7,1e+21,0,0.1,9007199254740991]');
  });

  it('digests strings as UTF-8, escaping them minimally', () => {
    expect(canonicalizeJson({ s: 'é' })).toBe('{"s":"é"}');
    expect(canonicalizeJson({ s: '😀' })).toBe('{"s":"😀"}');
    // The byte contract of §04 §6.1 step 1-2: the two-byte UTF-8 sequence of 'é', not an escape.
    expect(sha256Hex('{"s":"é"}')).toBe('86028b41ba792eaf82aa26a45b218f6734f7f1096a86f1746c8296e088a0ccb4');
  });

  it('accepts a null-prototype object, which carries no prototype chain to refuse', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 2;
    bare.a = 1;

    expect(canonicalizeJson(bare)).toBe('{"a":1,"b":2}');
    expect(canonicalizeJson(Object.create(null))).toBe('{}');
  });

  it('reproduces the same bytes for a value read back from JSON text', () => {
    const value = { b: [1, { d: 4, c: 3 }], a: { z: 1, A: 2 }, s: 'é' };
    const canonical = canonicalizeJson(value);
    const reread: unknown = JSON.parse(canonical);

    expect(canonicalizeJson(reread)).toBe(canonical);
    expect(sha256CanonicalJson(reread)).toBe(sha256CanonicalJson(value));
  });
});

describe('canonicalizeJson refusals', () => {
  it('refuses a value JSON.stringify would silently drop', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'x';
    const notDroppable: Array<[label: string, value: unknown]> = [
      ['an undefined member', { a: undefined }],
      ['an undefined array element', [undefined]],
      ['a sparse array hole', sparse],
      ['a function member', { f: () => 1 }],
      ['a symbol member', { s: Symbol('s') }],
      ['a top-level undefined', undefined],
    ];

    for (const [label, value] of notDroppable) {
      expect(refusalCode(value), label).toBe('CANONICAL_JSON_INVALID');
    }
  });

  it('refuses a number that has no JSON form', () => {
    expect(refusalCode({ n: Number.NaN })).toBe('CANONICAL_JSON_INVALID');
    expect(refusalCode({ n: Number.POSITIVE_INFINITY })).toBe('CANONICAL_JSON_INVALID');
    expect(refusalCode({ n: Number.NEGATIVE_INFINITY })).toBe('CANONICAL_JSON_INVALID');
  });

  it('refuses a value outside the JSON data model', () => {
    const notPlain: Array<[label: string, value: unknown]> = [
      ['a BigInt', 1n],
      ['a Date', new Date('2026-09-22T00:00:00.000Z')],
      ['a Map', new Map([['a', 1]])],
      ['a Set', new Set([1])],
      ['a class instance', new Money(1490)],
    ];

    for (const [label, value] of notPlain) {
      expect(refusalCode(value), label).toBe('CANONICAL_JSON_INVALID');
    }
  });

  it('refuses ill-formed Unicode instead of hashing a replacement character', () => {
    expect(refusalCode({ s: '\ud800' })).toBe('CANONICAL_JSON_INVALID');
    expect(refusalCode({ s: '\udc00' })).toBe('CANONICAL_JSON_INVALID');
    expect(refusalCode({ s: 'α\ud800ω' })).toBe('CANONICAL_JSON_INVALID');
    expect(refusalCode({ '\ud800': 1 })).toBe('CANONICAL_JSON_INVALID');
  });
});

describe('sha256CanonicalJson', () => {
  it('digests the canonical bytes of a payload, not its declared member order', () => {
    expect(sha256CanonicalJson({ message: 'hi', to: '+6680000000000', amount_thb: 1490 }))
      .toBe('b0df79f6534ae4a8478a62fc84809fd5aea5250e6e70b5e57534cdd80d586bec');
  });
});

describe('isSha256Hex', () => {
  it('accepts exactly 64 lower-case hexadecimal characters', () => {
    expect(isSha256Hex(sha256Hex(''))).toBe(true);
    expect(isSha256Hex('0'.repeat(64))).toBe(true);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex('a'.repeat(65))).toBe(false);
  });

  it('rejects a digest that is prefixed, upper-cased or not hexadecimal', () => {
    expect(isSha256Hex('sha256:abc')).toBe(false);
    expect(isSha256Hex(sha256Hex('abc').toUpperCase())).toBe(false);
    expect(isSha256Hex(`${'a'.repeat(63)}g`)).toBe(false);
    expect(isSha256Hex('')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('digests the UTF-8 bytes of the message', () => {
    // The empty string and 'abc' as published SHA-256 vectors: a padding or encoding regression
    // would change the digest of every chain in the platform.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('hmacSha256Hex', () => {
  it('keys the digest with the secret (RFC 4231 test case 2)', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

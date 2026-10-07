/**
 * @file Deterministic canonical JSON and digest helpers (implement/04 §6.1, implement/08 §4.2).
 *
 * Every durable digest the platform writes — `effect_key`, `request_fingerprint`,
 * `evidence_records.payload_sha256`, `evidence_records.chain_hash`, `audit_records.chain_hash` —
 * is computed over the output of this module, so the bytes of a value must never depend on
 * property insertion order, on the writer's locale, or on which process is doing the writing.
 *
 * The canonical form is RFC 8785 (JCS) restricted to I-JSON values:
 *   * object members are sorted by UTF-16 code unit and emitted with no insignificant whitespace;
 *   * arrays preserve their order;
 *   * strings are escaped minimally and digested as UTF-8;
 *   * numbers serialize with ECMAScript `Number::toString` semantics (exactly `JSON.stringify`,
 *     so `-0` becomes `0` and `1e21` becomes `1e+21`).
 *
 * Values RFC 8785 cannot represent are rejected instead of being silently converted (§08 §4.2):
 * `undefined`, functions, symbols, `BigInt`, `NaN`, `±Infinity`, lone surrogates, and non-plain
 * objects (`Date`, `Map`, `Set`, class instances). `JSON.stringify` would drop an `undefined`
 * member or emit `null` for it, which would let two writers claim to have hashed the same payload
 * while hashing different bytes.
 */

import { createHash, createHmac } from 'node:crypto';

import { canonicalizeJson as databaseCanonicalizeJson } from '@agentos/database/canonical-json';

import { OrchestratorError } from '../contracts/types.js';

/**
 * A SHA-256 digest as this platform stores it: lowercase hex, 64 characters, no prefix. Every
 * `CHAR(64)` column (`request_fingerprint`, `payload_sha256`, `chain_hash`, `prev_hash`) and every
 * derived key (`effect_key`) must satisfy this, so the check is shared by the guard and the
 * evidence chain rather than re-derived per call site.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reports whether a string is a well-formed lower-case SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns `true` for exactly 64 lower-case hexadecimal characters.
 */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Serializes a value to its canonical JSON form (RFC 8785 over I-JSON values).
 *
 * @param value - Value to canonicalize. Must contain only JSON-representable data.
 * @returns The canonical JSON text; UTF-8 encode it before digesting.
 * @throws OrchestratorError `CANONICAL_JSON_INVALID` when the value cannot be represented as
 *   canonical JSON; the message carries the path of the offending value.
 */
export function canonicalizeJson(value: unknown): string {
  try {
    return databaseCanonicalizeJson(value);
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.replace(/^CANONICAL_JSON_INVALID:\s*/, '')
      : String(error);
    throw new OrchestratorError('CANONICAL_JSON_INVALID', detail);
  }
}

/**
 * Digests a UTF-8 string with SHA-256.
 *
 * @param input - Text hashed as UTF-8, the byte contract of every chain formula.
 * @returns 64 lower-case hexadecimal characters.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Digests a value with SHA-256 over its canonical JSON form (§04 §6.1 step 1-2, §08 §4.2).
 *
 * @param value - Value to canonicalize and digest.
 * @returns 64 lower-case hexadecimal characters.
 * @throws OrchestratorError `CANONICAL_JSON_INVALID` when the value is not canonicalizable.
 */
export function sha256CanonicalJson(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}

/**
 * Signs a message with HMAC-SHA256 (§04 §6.1 step 3). The secret is used as UTF-8 key material and
 * is never included in an error message.
 *
 * @param secret - Signing secret (`AUDIT_HMAC_SECRET`).
 * @param message - Message hashed as UTF-8.
 * @returns 64 lower-case hexadecimal characters.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}


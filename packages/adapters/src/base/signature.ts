/**
 * @file The one signing primitive the connector layer needs (implement/06 §4.1).
 *
 * `packages/adapters` holds no `node:` dependency and no provider SDK (`02` §2 dependency DAG), so
 * HMAC is injected rather than imported: the host supplies the digest, this package owns the byte
 * contract — which header carries it, what is concatenated to form the material, and whether the
 * value is prefixed. Declared once so every connector and channel scheme takes the same type.
 */

/**
 * Hex-encoded HMAC-SHA256 of `message` under `secret`.
 *
 * @param secret The HMAC key.
 * @param message The exact bytes to sign, already assembled by the scheme.
 * @returns The lower-case hex digest.
 */
export type HmacSha256Hex = (secret: string, message: string) => string;

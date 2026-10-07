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

/**
 * Signs a mock-ERP request over the provider's canonical request material:
 * `METHOD path\nraw body`.
 *
 * The HMAC implementation remains host-supplied so this package stays runtime-agnostic. Callers
 * must pass the exact raw body bytes represented as a UTF-8 string; an empty string is the body of
 * a bodyless request.
 */
export function signMockRequest(
  secret: string,
  method: string,
  path: string,
  rawBody: string,
  hmac: HmacSha256Hex,
): string {
  return hmac(secret, `${method.toUpperCase()} ${path}\n${rawBody}`);
}

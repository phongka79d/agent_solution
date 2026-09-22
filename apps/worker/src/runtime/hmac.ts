import { createHmac } from 'node:crypto';

import type { HmacSha256Hex } from '@agentos/adapters';

/**
 * The host's HMAC-SHA256 primitive, in lower-case hex.
 *
 * `@agentos/adapters` is deliberately crypto-free: it declares the signature dependency
 * (`HmacSha256Hex`) and refuses to assume an algorithm or a runtime. The process that owns
 * `node:crypto` supplies the implementation, so a host with a different crypto provider can inject
 * one without a change to any connector.
 *
 * @param secret Shared secret; never logged by this module or any caller.
 * @param message Exact bytes being signed, as a UTF-8 string.
 * @returns The signature in lower-case hex.
 */
export const nodeHmacSha256Hex: HmacSha256Hex = (secret, message) =>
  createHmac('sha256', secret).update(message).digest('hex');

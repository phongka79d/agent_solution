import { createHmac, timingSafeEqual } from 'node:crypto';

/** Canonical request material binds the signature to method, path, and exact raw body bytes. */
export function signRequest(secret, method, path, rawBody) {
  if (typeof method !== 'string' || typeof path !== 'string' || !(typeof rawBody === 'string' || Buffer.isBuffer(rawBody))) {
    throw new TypeError('method, path and rawBody are required for request signing');
  }
  return createHmac('sha256', secret)
    .update(`${method.toUpperCase()} ${path}\n`)
    .update(rawBody)
    .digest('hex');
}


export function signaturesMatch(expectedHex, providedHex) {
  if (typeof expectedHex !== 'string' || typeof providedHex !== 'string') return false;
  if (expectedHex.length !== 64 || providedHex.length !== 64 || !/^[0-9a-f]+$/i.test(expectedHex) || !/^[0-9a-f]+$/i.test(providedHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  return timingSafeEqual(expected, provided);
}

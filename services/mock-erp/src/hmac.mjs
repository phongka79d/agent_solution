import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function signaturesMatch(expectedHex, providedHex) {
  if (typeof expectedHex !== 'string' || typeof providedHex !== 'string') return false;
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(providedHex, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

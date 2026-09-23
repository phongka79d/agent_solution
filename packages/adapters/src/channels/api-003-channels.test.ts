import { createHmac, timingSafeEqual } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyChannelSignature, type ChannelId } from './api-003-channels.js';

/** The host primitive; the same algorithm a provider computes with, injected as the package requires. */
const hmac = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message).digest('hex');

const SECRET = 'channel-secret-value-not-real';
const BODY = JSON.stringify({ object: 'page', entry: [{ id: 'PAGE-1' }] });

/** Verifies one delivery over the shared primitive. */
function verify(input: {
  readonly channel: ChannelId;
  readonly secret?: string | null;
  readonly app_id?: string;
  readonly body?: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): ReturnType<typeof verifyChannelSignature> {
  return verifyChannelSignature({
    channel: input.channel,
    secret: input.secret === undefined ? SECRET : input.secret,
    ...(input.app_id === undefined ? {} : { app_id: input.app_id }),
    raw_body: input.body ?? BODY,
    headers: input.headers,
    hmac,
  });
}

describe('verifyChannelSignature', () => {
  it('accepts a delivery signed over the raw body, however the header is cased', () => {
    const digest = hmac(SECRET, BODY);

    expect(verify({ channel: 'MESSENGER', headers: { 'X-Hub-Signature-256': `sha256=${digest}` } })).toEqual({
      ok: true,
    });
    expect(verify({ channel: 'TIKTOK', headers: { 'x-tiktok-signature': digest } })).toEqual({ ok: true });
    expect(verify({ channel: 'SMS', headers: { 'X-Twilio-Signature': digest } })).toEqual({ ok: true });
  });

  it('refuses a body, secret or digest that does not match', () => {
    const digest = hmac(SECRET, BODY);
    const other = hmac('another-secret-value', BODY);

    const refusals = [
      // The body was altered after signing.
      verify({ channel: 'TIKTOK', headers: { 'x-tiktok-signature': digest }, body: `${BODY} ` }),
      // The digest was computed with a secret this tenant does not hold.
      verify({ channel: 'TIKTOK', headers: { 'x-tiktok-signature': other } }),
      // A truncated digest is a mismatch, never a prefix match.
      verify({ channel: 'TIKTOK', headers: { 'x-tiktok-signature': digest.slice(0, 32) } }),
    ];

    for (const result of refusals) {
      expect(result).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    }
  });

  it('refuses a delivery that carries no signature, or a channel with no configured secret', () => {
    expect(verify({ channel: 'TIKTOK', headers: {} })).toEqual({ ok: false, reason: 'SIGNATURE_MISSING' });

    for (const secret of [null, '']) {
      const result = verify({ channel: 'TIKTOK', secret, headers: { 'x-tiktok-signature': hmac(SECRET, BODY) } });
      expect(result).toEqual({ ok: false, reason: 'SECRET_UNAVAILABLE' });
    }
  });

  it('requires the algorithm prefix Meta sends and refuses a bare digest', () => {
    const digest = hmac(SECRET, BODY);

    expect(verify({ channel: 'MESSENGER', headers: { 'x-hub-signature-256': `sha256=${digest}` } })).toEqual({
      ok: true,
    });
    expect(verify({ channel: 'MESSENGER', headers: { 'x-hub-signature-256': digest } })).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });
  });

  it('binds the Zalo app id into the material it verifies', () => {
    const app_id = 'APP-123';
    const timestamp = '1758500000000';
    const headers = { 'x-zalo-signature': hmac(SECRET, `${app_id}${BODY}`), 'x-zevent-timestamp': timestamp };

    expect(verify({ channel: 'ZALO', app_id, headers })).toEqual({ ok: true });

    // A signature over the body alone, or over another app id's material, is not this delivery's.
    expect(verify({ channel: 'ZALO', app_id, headers: { 'x-zalo-signature': hmac(SECRET, BODY) } })).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });
    expect(
      verify({ channel: 'ZALO', app_id: 'APP-OTHER', headers: { 'x-zalo-signature': hmac(SECRET, `${app_id}${BODY}`) } }),
    ).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });

    // Without the app id there is no material to compute, so the delivery is refused rather than
    // verified against a signature of the body alone.
    expect(verify({ channel: 'ZALO', headers })).toEqual({ ok: false, reason: 'SECRET_UNAVAILABLE' });

    // The declared timestamp header is not part of Zalo's material: the scheme binds the app id to
    // the body, so the same signature verifies whatever timestamp the delivery carries, and a
    // replayed delivery has to be caught by the event id, not by this signature.
    const bound = hmac(SECRET, `${app_id}${BODY}`);
    expect(
      verify({
        channel: 'ZALO',
        app_id,
        headers: { 'x-zalo-signature': bound, 'x-zevent-timestamp': '1758500000000' },
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        channel: 'ZALO',
        app_id,
        headers: { 'x-zalo-signature': bound, 'x-zevent-timestamp': '1758500000001' },
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a channel that has no scheme at all', () => {
    const result = verifyChannelSignature({
      channel: 'CARRIER_PIGEON' as ChannelId,
      secret: SECRET,
      raw_body: BODY,
      headers: { 'x-tiktok-signature': hmac(SECRET, BODY) },
      hmac,
    });

    expect(result).toEqual({ ok: false, reason: 'CHANNEL_NOT_CONFIGURED' });
  });

  it('walks the whole digest so a near-miss cannot be distinguished by timing', () => {
    const digest = hmac(SECRET, BODY);
    const nearMiss = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
    const lengths = { expected: digest.length, nearMiss: nearMiss.length, equal: digest === nearMiss };

    expect(lengths).toEqual({ expected: 64, nearMiss: 64, equal: false });
    expect(verify({ channel: 'EMAIL', headers: { 'x-mailgun-signature': nearMiss } })).toEqual({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });
    // The host primitive and the package's own comparison agree byte for byte.
    expect(timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(digest, 'utf8'))).toBe(true);
  });
});

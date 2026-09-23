/**
 * @file API-003 communication-connector boundary: inbound signature verification and payload
 * extraction (implement/06 §4.0–§4.2, §8.1.2 R04, `TC-CON-004`).
 *
 * Two decisions shape this module.
 *
 * 1. **The provider is a choice; the requirement is not.** SRS API-003 fixes the six baseline
 *    channel identities and requires the connector architecture. The concrete provider and its
 *    signature scheme remain `[UNCONFIRMED][ASM-001]`, so every scheme is declared as data — the
 *    header it uses, the bytes it signs, and whether the digest is prefixed — and is marked with
 *    its confirmation status. A provider audit changes a table row, not a code path.
 * 2. **Verification happens before anything is routed.** `verifyChannelSignature` is the only
 *    gate: an absent header, an unknown channel, a missing secret or a mismatched digest are all
 *    refusals, and a refusal is reached before any canonical derivation or durable append
 *    (`TC-CON-004` — a tampered delivery is rejected `401` and no agent is invoked).
 *
 * HMAC is injected rather than imported: `packages/adapters` holds no `node:` dependency, so the
 * host supplies the digest primitive and this package owns the scheme logic. That keeps the byte
 * contract here, in tests, and out of the transport.
 */

import type { HmacSha256Hex } from '../base/signature.js';

/** Baseline API-003 channel identities plus the `[OPTIONAL-EXTENSION][ASM-001]` channels. */
export type ChannelId =
  | 'WEB_CHAT'
  | 'APP_CHAT'
  | 'MESSENGER'
  | 'INSTAGRAM'
  | 'TIKTOK'
  | 'ZALO'
  | 'EMAIL'
  | 'SMS'
  | 'LINE'
  | 'WHATSAPP';

/** The bytes a channel's digest is computed over. */
export type SignedMaterial =
  /** The raw, unparsed request body alone (`LINE`, `Messenger`, `TikTok`). */
  | 'RAW_BODY'
  /** `app_id` concatenated with the body and the secret (`Zalo OA`). */
  | 'APP_ID_BODY_SECRET'
  /** The timestamp header concatenated with the body, so a stale delivery cannot be re-signed. */
  | 'TIMESTAMP_BODY';

/** One channel's verification scheme. */
export interface ChannelSignatureScheme {
  readonly channel: ChannelId;
  /** Provider choice, `[UNCONFIRMED][ASM-001]` until the connector audit locks it. */
  readonly provider: string;
  /** Lower-case header name carrying the digest. */
  readonly header: string;
  /** `true` when the header value is `<algorithm>=<hex>`, as Meta's `X-Hub-Signature-256` is. */
  readonly prefixed: boolean;
  readonly material: SignedMaterial;
  /** Required for `TIMESTAMP_BODY`; the header that carries the signed instant. */
  readonly timestamp_header: string | null;
  /** Whether this scheme is required by the six baseline channels or is an extension. */
  readonly status: 'BASELINE' | 'EXTENSION';
}

/**
 * Per-channel schemes (`06` §4.1). `LINE` and `WHATSAPP` are declared but are extensions: the
 * baseline set is `WEB_CHAT`, `APP_CHAT`, `MESSENGER`, `TIKTOK`, `ZALO`, `EMAIL` and `SMS`.
 */
export const CHANNEL_SIGNATURE_SCHEMES: Readonly<Record<ChannelId, ChannelSignatureScheme>> = Object.freeze({
  WEB_CHAT: {
    channel: 'WEB_CHAT',
    provider: 'first-party widget token',
    header: 'x-widget-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  APP_CHAT: {
    channel: 'APP_CHAT',
    provider: 'first-party app token',
    header: 'x-widget-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  MESSENGER: {
    channel: 'MESSENGER',
    provider: 'Meta Send API v19.0',
    header: 'x-hub-signature-256',
    prefixed: true,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  TIKTOK: {
    channel: 'TIKTOK',
    provider: 'TikTok Open Platform Messaging API',
    header: 'x-tiktok-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  ZALO: {
    channel: 'ZALO',
    provider: 'Zalo OA OpenAPI',
    header: 'x-zalo-signature',
    prefixed: false,
    material: 'APP_ID_BODY_SECRET',
    timestamp_header: 'x-zevent-timestamp',
    status: 'BASELINE',
  },
  EMAIL: {
    channel: 'EMAIL',
    provider: 'SendGrid / Mailgun transactional webhook',
    header: 'x-mailgun-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  SMS: {
    channel: 'SMS',
    provider: 'Chunghwa Telecom / Twilio-compatible SMS gateway',
    header: 'x-twilio-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'BASELINE',
  },
  INSTAGRAM: {
    channel: 'INSTAGRAM',
    provider: 'Meta Send API v19.0',
    header: 'x-hub-signature-256',
    prefixed: true,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'EXTENSION',
  },
  LINE: {
    channel: 'LINE',
    provider: 'LINE Messaging API',
    header: 'x-line-signature',
    prefixed: false,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'EXTENSION',
  },
  WHATSAPP: {
    channel: 'WHATSAPP',
    provider: 'WhatsApp Business Cloud API',
    header: 'x-hub-signature-256',
    prefixed: true,
    material: 'RAW_BODY',
    timestamp_header: null,
    status: 'EXTENSION',
  },
});

/** Why a delivery was refused. Every member maps to the gateway's signature failure vocabulary. */
export type ChannelVerificationFailure =
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_INVALID'
  | 'CHANNEL_NOT_CONFIGURED'
  | 'SECRET_UNAVAILABLE'
  | 'TIMESTAMP_MISSING';

export type ChannelVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ChannelVerificationFailure };

/**
 * Constant-time comparison of two lower-case hex digests.
 *
 * Written without `node:crypto` because this package holds no runtime dependency: the loop always
 * walks the full expected length and accumulates differences, so the comparison time does not
 * depend on the position of the first mismatch. A length difference is recorded as the initial
 * difference rather than short-circuiting, so an empty or truncated header is still rejected
 * without an early return.
 */
export function hexDigestsMatch(expected: string, provided: string): boolean {
  let difference = expected.length === provided.length ? 0 : 1;
  const expectedCodes = expected.toLowerCase();
  const providedCodes = provided.toLowerCase();

  for (let index = 0; index < expectedCodes.length; index += 1) {
    const a = expectedCodes.charCodeAt(index);
    const b = index < providedCodes.length ? providedCodes.charCodeAt(index) : 0;
    difference |= a ^ b;
  }

  return difference === 0;
}

/** Reads a header case-insensitively from a plain header bag. */
function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Verifies one inbound delivery against its channel's scheme.
 *
 * @param input.channel The channel identity the delivery claims.
 * @param input.secret The channel secret, resolved by the host from the tenant's credential store.
 * @param input.app_id Required by `APP_ID_BODY_SECRET` schemes (`Zalo OA`).
 * @param input.raw_body The bytes as received; a re-serialised payload never verifies.
 * @param input.headers The delivered headers.
 * @param input.hmac The host's HMAC primitive.
 * @returns `{ok:true}`, or a typed refusal that the gateway maps to `401`.
 */
export function verifyChannelSignature(input: {
  readonly channel: ChannelId;
  readonly secret: string | null;
  readonly app_id?: string;
  readonly raw_body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly hmac: HmacSha256Hex;
}): ChannelVerificationResult {
  const scheme = CHANNEL_SIGNATURE_SCHEMES[input.channel];
  if (scheme === undefined) {
    return { ok: false, reason: 'CHANNEL_NOT_CONFIGURED' };
  }

  if (input.secret === null || input.secret.length === 0) {
    return { ok: false, reason: 'SECRET_UNAVAILABLE' };
  }

  const provided = headerValue(input.headers, scheme.header);
  if (provided === null) {
    return { ok: false, reason: 'SIGNATURE_MISSING' };
  }

  let material: string;
  if (scheme.material === 'APP_ID_BODY_SECRET') {
    const appId = input.app_id ?? '';
    if (appId.length === 0) {
      return { ok: false, reason: 'SECRET_UNAVAILABLE' };
    }
    // `HMAC-SHA256(app_id + body + secret)` per `06` §4.1: the secret is the HMAC key, so the
    // material is `app_id` followed by the body.
    material = `${appId}${input.raw_body}`;
  } else if (scheme.material === 'TIMESTAMP_BODY') {
    const timestampHeader = scheme.timestamp_header;
    if (timestampHeader === null) {
      return { ok: false, reason: 'TIMESTAMP_MISSING' };
    }
    const timestamp = headerValue(input.headers, timestampHeader);
    if (timestamp === null) {
      return { ok: false, reason: 'TIMESTAMP_MISSING' };
    }
    material = `${timestamp}${input.raw_body}`;
  } else {
    material = input.raw_body;
  }

  const expected = input.hmac(input.secret, material);
  const presented = scheme.prefixed ? stripPrefix(provided) : provided;

  if (presented === null || !hexDigestsMatch(expected, presented)) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  return { ok: true };
}

/** Removes a leading `<algorithm>=` from a digest header value, as Meta's scheme requires. */
function stripPrefix(value: string): string | null {
  const separator = value.indexOf('=');
  if (separator === -1) return null;
  const digest = value.slice(separator + 1).trim();
  return digest.length === 0 ? null : digest;
}

/** One inbound message extracted from a provider payload. */
export interface InboundChannelMessage {
  /** The provider's own message identity: the receipt key for replay deduplication. */
  readonly provider_message_id: string | null;
  readonly sender_handle: string | null;
  readonly text: string | null;
  readonly received_at: string | null;
}

/** Dotted paths a channel's payload exposes, kept as data because the provider is `[ASM-001]`. */
export interface ChannelPayloadPaths {
  readonly provider_message_id: readonly string[];
  readonly sender_handle: readonly string[];
  readonly text: readonly string[];
  readonly received_at: readonly string[];
}

/** Per-channel payload extracts (`06` §4.1 column "payload extract"). */
export const CHANNEL_PAYLOAD_PATHS: Readonly<Record<ChannelId, ChannelPayloadPaths>> = Object.freeze({
  WEB_CHAT: {
    provider_message_id: ['event_id', 'message_id'],
    sender_handle: ['session_id', 'sender_handle'],
    text: ['text', 'message'],
    received_at: ['occurred_at', 'received_at'],
  },
  APP_CHAT: {
    provider_message_id: ['event_id', 'message_id'],
    sender_handle: ['session_id', 'sender_handle'],
    text: ['text', 'message'],
    received_at: ['occurred_at', 'received_at'],
  },
  MESSENGER: {
    provider_message_id: ['entry.0.messaging.0.message.mid', 'entry.0.messaging.0.sender.id'],
    sender_handle: ['entry.0.messaging.0.sender.id'],
    text: ['entry.0.messaging.0.message.text'],
    received_at: ['entry.0.time'],
  },
  INSTAGRAM: {
    provider_message_id: ['entry.0.messaging.0.message.mid'],
    sender_handle: ['entry.0.messaging.0.sender.id'],
    text: ['entry.0.messaging.0.message.text'],
    received_at: ['entry.0.time'],
  },
  TIKTOK: {
    provider_message_id: ['message_id', 'event_id'],
    sender_handle: ['sender_open_id', 'from_user_id'],
    text: ['content', 'text'],
    received_at: ['create_time', 'received_at'],
  },
  ZALO: {
    provider_message_id: ['message_id', 'event_id'],
    sender_handle: ['sender.id', 'sender_handle'],
    text: ['message.text', 'text'],
    received_at: ['timestamp', 'received_at'],
  },
  EMAIL: {
    provider_message_id: ['Message-Id', 'message_id'],
    sender_handle: ['sender', 'from'],
    text: ['stripped-text', 'text'],
    received_at: ['timestamp', 'received_at'],
  },
  SMS: {
    provider_message_id: ['MessageSid', 'message_id'],
    sender_handle: ['From', 'sender_handle'],
    text: ['Body', 'text'],
    received_at: ['received_at', 'timestamp'],
  },
  LINE: {
    provider_message_id: ['events.0.webhookEventId', 'events.0.message.id'],
    sender_handle: ['events.0.source.userId'],
    text: ['events.0.message.text'],
    received_at: ['events.0.timestamp'],
  },
  WHATSAPP: {
    provider_message_id: ['entry.0.changes.0.value.messages.0.id'],
    sender_handle: ['entry.0.changes.0.value.messages.0.from'],
    text: ['entry.0.changes.0.value.messages.0.text.body'],
    received_at: ['entry.0.changes.0.value.messages.0.timestamp'],
  },
});

/** Narrows an object to a string-keyed record without copying it. */
function hasKey(value: object, key: string): value is Record<string, unknown> {
  return key in value;
}

/** Reads one dotted path, returning `null` for a missing segment rather than throwing. */
function readPath(body: unknown, path: string): string | null {
  let cursor: unknown = body;

  for (const segment of path.split('.')) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return null;
      cursor = cursor[index];
      continue;
    }

    if (typeof cursor !== 'object' || cursor === null) return null;
    if (!hasKey(cursor, segment)) return null;

    cursor = cursor[segment];
  }

  if (typeof cursor === 'string') return cursor.length > 0 ? cursor : null;
  if (typeof cursor === 'number') return String(cursor);

  return null;
}

/**
 * Extracts the fields the platform needs from a verified provider payload.
 *
 * Extraction never validates identity or authority: it reads the documented paths and returns
 * `null` for anything absent, so a caller can refuse an incomplete delivery instead of receiving a
 * default it might mistake for a fact.
 */
export function extractInboundMessage(input: {
  readonly channel: ChannelId;
  readonly body: unknown;
}): InboundChannelMessage {
  const paths = CHANNEL_PAYLOAD_PATHS[input.channel];

  const firstOf = (candidates: readonly string[]): string | null => {
    for (const path of candidates) {
      const value = readPath(input.body, path);
      if (value !== null) return value;
    }
    return null;
  };

  return {
    provider_message_id: firstOf(paths.provider_message_id),
    sender_handle: firstOf(paths.sender_handle),
    text: firstOf(paths.text),
    received_at: firstOf(paths.received_at),
  };
}

/**
 * @file Binding of the connector layer to the gateway and engine ports (implement/06 §4.2, §7).
 *
 * The gateway declares what it needs (`WebhookVerificationPort`, an event normaliser, an adapter
 * dispatcher); `packages/adapters` owns the channel schemes, the eight ERP resource groups and the
 * canonical alias table. This module is the only place where the two meet, and it is where the two
 * fail-closed rules live:
 *
 * - **An unknown connector is refused, never substituted.** `dispatch` resolves the action's
 *   `adapter_target` through the registry and raises `CONNECTOR_NOT_FOUND` when nothing is
 *   registered under that id — there is no default adapter and no silent no-op.
 * - **A verification failure precedes routing.** `webhooks.verify` is called before any canonical
 *   derivation or durable append, so a forged or replayed delivery reaches no agent (`TC-CON-004`).
 *
 * The HMAC primitive is constructed here because `apps/api` is the layer that holds `node:crypto`;
 * `@agentos/adapters` stays crypto-free and receives it as a parameter.
 */

import { createHmac } from 'node:crypto';

import {
  createEventAliasNormalizer,
  hexDigestsMatch,
  verifyChannelSignature,
  type CanonicalEvent,
  type ChannelId as ConnectorChannelId,
  type EventAliasNormalizer,
  type HmacSha256Hex,
} from '@agentos/adapters';
import type { ChannelId } from '../gateway/contracts.js';
import type { WebhookVerificationPort } from '../gateway/ports.js';

/**
 * Where a channel secret comes from. Resolved per tenant and per channel: there is no default
 * secret, no shared fallback and no environment read inside this module, so a tenant that has not
 * provisioned a channel secret cannot verify a delivery and is refused.
 */
export interface ChannelSecretStore {
  resolve(tenant_id: string, channel: ConnectorChannelId): Promise<string | null>;
  /**
   * The tenant's platform ingress secret (`06` §8.1.1 R04 `X-Signature-SHA256`). Separate from the
   * channel secrets because the platform ingress is not channel-bound and a channel secret is never
   * an acceptable substitute for it.
   */
  resolvePlatform(tenant_id: string): Promise<string | null>;
}

/** The digest the connector layer expects, backed by the platform's own HMAC implementation. */
export const nodeHmacSha256Hex: HmacSha256Hex = (secret, message) =>
  createHmac('sha256', secret).update(message, 'utf8').digest('hex');

/** The header the platform event ingress signs with (`06` §8.1.1 R04). */
export const PLATFORM_SIGNATURE_HEADER = 'x-signature-sha256';

/** Reads a header case-insensitively, returning `null` for an absent or empty value. */
function headerOf(headers: Readonly<Record<string, string | undefined>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Narrows the gateway's channel union onto the connector layer's identical union. */
function toConnectorChannel(channel: ChannelId): ConnectorChannelId {
  return channel;
}

/**
 * The gateway's inbound-verification port over the channel schemes of `06` §4.1.
 *
 * Every refusal — absent signature, unknown channel, unprovisioned secret, mismatched digest — is
 * reported as `SIGNATURE_INVALID` (`401`). The caller learns that the delivery was not accepted,
 * never which of its bytes were wrong.
 *
 * @param deps.channelSecrets The tenant-scoped secret store.
 * @param deps.hmac The HMAC primitive; defaults to the platform's `node:crypto` binding.
 */
export function createWebhookVerificationPort(deps: {
  readonly channelSecrets: ChannelSecretStore;
  readonly hmac?: HmacSha256Hex;
}): WebhookVerificationPort {
  const hmac = deps.hmac ?? nodeHmacSha256Hex;

  return {
    verify: async (input) => {
      // The platform event ingress (R04) is not channel-bound: it is authenticated by the tenant's
      // platform secret under `X-Signature-SHA256`, verified over the same raw bytes. A channel
      // scheme is never substituted for it and a channel secret never signs it.
      if (input.channel === null) {
        const platformSecret = await deps.channelSecrets.resolvePlatform(input.tenant_id);
        if (platformSecret === null || platformSecret.length === 0) {
          return { ok: false, error_code: 'SIGNATURE_INVALID' };
        }

        const presented = headerOf(input.headers, PLATFORM_SIGNATURE_HEADER);
        if (presented === null) {
          return { ok: false, error_code: 'SIGNATURE_INVALID' };
        }

        const expected = hmac(platformSecret, input.raw_body);
        return hexDigestsMatch(expected, presented)
          ? { ok: true }
          : { ok: false, error_code: 'SIGNATURE_INVALID' };
      }

      const channel = toConnectorChannel(input.channel);
      const secret = await deps.channelSecrets.resolve(input.tenant_id, channel);

      const result = verifyChannelSignature({
        channel,
        secret,
        raw_body: input.raw_body,
        headers: input.headers,
        hmac,
      });

      return result.ok ? { ok: true } : { ok: false, error_code: 'SIGNATURE_INVALID' };
    },
  };
}

/**
 * The canonical-event normaliser of API-002, bound once per process.
 *
 * @param options.extra_aliases Deployment-approved granular aliases; a re-pointing of a baseline
 *   alias throws at composition time rather than changing what stored history means.
 */
export function createCanonicalEventNormalizer(options?: {
  readonly extra_aliases?: Readonly<Record<string, CanonicalEvent>>;
}): EventAliasNormalizer {
  return options?.extra_aliases === undefined
    ? createEventAliasNormalizer()
    : createEventAliasNormalizer({ extra_aliases: options.extra_aliases });
}

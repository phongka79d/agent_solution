/**
 * Shopify GraphQL Admin API connector and installation boundary.
 * Provider routes, credential details and webhook contracts remain [UNCONFIRMED][ASM-001].
 * This module is mock-transport-only: it never performs network I/O or writes a system of record.
 */

import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import { hexDigestsMatch } from '../channels/api-003-channels.js';
import type {
  ConnectorReadResult,
  ConnectorRegistry,
  RegisteredConnector,
} from '../base/registry.js';
import type { HmacSha256Hex } from '../base/signature.js';

export const SHOPIFY_CONNECTOR_ID = 'SHOPIFY';

export interface SecretResolver {
  resolve(secret_ref: string): Promise<string | null> | string | null;
}

export interface SecretRef {
  readonly secret_ref: string;
}

export class ShopifyRefusalError extends Error {
  constructor(
    readonly refusal_code:
      | 'TENANT_UNSCOPED'
      | 'SHOP_UNSCOPED'
      | 'INVALID_SHOP_DOMAIN'
      | 'SECRET_UNAVAILABLE'
      | 'CREDENTIAL_EXPIRED'
      | 'SIGNATURE_MISSING'
      | 'SIGNATURE_INVALID'
      | 'STATE_INVALID'
      | 'STATE_REPLAYED'
      | 'SHOP_BINDING_MISMATCH'
      | 'INSTALLATION_CONFLICT'
      | 'DELIVERY_REPLAYED'
      | 'UNSUPPORTED_OPERATION'
      | 'PROVIDER_REJECTED'
      | 'UNKNOWN_OUTCOME'
      | 'OBSERVATION_UNAVAILABLE'
      | 'PRICE_SOURCE_FORBIDDEN',
    detail: string,
  ) {
    // Deliberately omit all secret material and provider payloads from errors.
    super(`SHOPIFY_${refusal_code}: ${detail}`);
    this.name = 'ShopifyRefusalError';
  }
}

export interface ShopifyInstallStateRecord {
  readonly tenant_id: string;
  readonly shop: string;
  /** Only this digest is persisted; the raw OAuth state is never logged or stored. */
  readonly state_hash: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface ShopifyInstallStateStore {
  put(record: ShopifyInstallStateRecord): Promise<void> | void;
  consume(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly state_hash: string;
    /** Store compares this to its persisted expires_at atomically before consuming. */
    readonly now?: string;
  }): Promise<boolean> | boolean;
}

export interface ShopifyInstallation {
  readonly tenant_id: string;
  readonly shop: string;
  readonly credential_ref: string;
  readonly installed_at: string;
  /** Provider credential expiry; absent only when the provider grants a non-expiring token. */
  readonly expires_at?: string | null;
  readonly revoked_at: string | null;
}

export interface ShopifyInstallationStore {
  find(input: {
    readonly tenant_id: string;
    readonly shop: string;
  }): Promise<ShopifyInstallation | null> | ShopifyInstallation | null;
  findByShop(shop: string): Promise<ShopifyInstallation | null> | ShopifyInstallation | null;
  save(installation: ShopifyInstallation): Promise<void> | void;
  revoke(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly revoked_at: string;
  }): Promise<void> | void;
}

export interface ShopifyDeliveryReplayStore {
  claim(input: {
    readonly tenant_id: string;
    readonly delivery_id: string;
  }): Promise<boolean> | boolean;
}

export type ShopifyOAuthExchangeResult =
  | {
      readonly ok: true;
      readonly access_token: string;
      readonly credential_ref: string;
      readonly expires_at?: string | null;
    }
  | { readonly ok: false; readonly reason: 'TIMEOUT' | 'PROVIDER_REJECTED' | 'UNKNOWN' };

export interface ShopifyOAuthTransport {
  exchangeAccessToken(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly code: string;
    readonly client_secret: string;
  }): Promise<ShopifyOAuthExchangeResult>;
}

export type ShopifyGraphqlTransportResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: Record<string, unknown>;
      /** Provider-observed time; local clocks must not be substituted. */
      readonly observed_at?: string;
    }
  | {
      readonly ok: false;
      readonly failure_class: 'TIMEOUT' | 'PROVIDER_REJECTED' | 'UNKNOWN';
      readonly status: number | null;
    };

export interface ShopifyGraphqlTransport {
  execute(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly access_token: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }): Promise<ShopifyGraphqlTransportResult>;
}

export interface ShopifyGraphqlAdminClient {
  query(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly query: string;
    readonly variables?: Readonly<Record<string, unknown>>;
  }): Promise<ShopifyGraphqlResult>;
}

export interface ShopifyGraphqlResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly observed_at: string;
}

function requireScope(value: string, code: 'TENANT_UNSCOPED' | 'SHOP_UNSCOPED'): void {
  if (value.trim().length === 0) {
    throw new ShopifyRefusalError(code, 'authenticated tenant and shop binding are required');
  }
}

function requireShop(shop: string): void {
  requireScope(shop, 'SHOP_UNSCOPED');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/i.test(shop)) {
    throw new ShopifyRefusalError('INVALID_SHOP_DOMAIN', 'shop must be a valid *.myshopify.com domain');
  }
}

function credentialExpired(installation: ShopifyInstallation, now: Date): boolean {
  if (installation.expires_at === undefined || installation.expires_at === null) return false;
  const expiresAt = Date.parse(installation.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function base64FromHex(value: string): string | null {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let offset = 0; offset < value.length; offset += 6) {
    const first = Number.parseInt(value.slice(offset, offset + 2), 16);
    const second = offset + 2 < value.length ? Number.parseInt(value.slice(offset + 2, offset + 4), 16) : 0;
    const third = offset + 4 < value.length ? Number.parseInt(value.slice(offset + 4, offset + 6), 16) : 0;
    const count = Math.min(3, (value.length - offset) / 2);
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | (second >> 4)];
    result += count > 1 ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
    result += count > 2 ? alphabet[third & 63] : '=';
  }
  return result;
}

function signatureMatches(expected: string, provided: string, encoding: 'HEX' | 'BASE64' = 'HEX'): boolean {
  const encoded = encoding === 'BASE64' ? base64FromHex(expected) : expected;
  if (encoded === null || encoded.length !== provided.length) return false;
  if (encoding === 'HEX') return hexDigestsMatch(encoded, provided);
  let difference = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    difference |= encoded.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return difference === 0;
}

function genericTransportRefusal(
  failure: 'TIMEOUT' | 'PROVIDER_REJECTED' | 'UNKNOWN',
): ShopifyRefusalError {
  return new ShopifyRefusalError(
    failure === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : 'UNKNOWN_OUTCOME',
    failure === 'PROVIDER_REJECTED'
      ? 'Shopify rejected the request'
      : 'Shopify outcome is unconfirmed and requires reconciliation',
  );
}
async function resolveSecret(
  resolver: SecretResolver,
  secret_ref: string,
): Promise<string> {
  let secret: string | null;
  try {
    secret = await resolver.resolve(secret_ref);
  } catch {
    throw new ShopifyRefusalError('SECRET_UNAVAILABLE', 'required credential is unavailable');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ShopifyRefusalError('SECRET_UNAVAILABLE', 'required credential is unavailable');
  }
  return secret;
}

/** Issues a raw OAuth state to the caller while persisting only its injected one-way digest. */
export async function issueShopifyInstallState(input: {
  readonly tenant_id: string;
  readonly shop: string;
  readonly raw_state: string;
  readonly hash_state: (raw_state: string) => Promise<string> | string;
  readonly now: string;
  readonly expires_at: string;
  readonly store: ShopifyInstallStateStore;
}): Promise<string> {
  requireScope(input.tenant_id, 'TENANT_UNSCOPED');
  requireShop(input.shop);
  if (input.raw_state.length === 0) {
    throw new ShopifyRefusalError('STATE_INVALID', 'OAuth state is required');
  }
  let state_hash: string;
  try {
    state_hash = await input.hash_state(input.raw_state);
  } catch {
    throw new ShopifyRefusalError('STATE_INVALID', 'OAuth state digest is unavailable');
  }
  if (state_hash.length === 0) {
    throw new ShopifyRefusalError('STATE_INVALID', 'OAuth state digest is unavailable');
  }
  await input.store.put({
    tenant_id: input.tenant_id,
    shop: input.shop,
    state_hash,
    created_at: input.now,
    expires_at: input.expires_at,
  });
  return input.raw_state;
}

/** Signed callback verification input; raw state is never persisted by this contract. */
export interface ShopifyCallbackVerificationInput {
  readonly tenant_id: string;
  readonly shop: string;
  readonly state: string;
  readonly signed_material: string;
  readonly provided_signature: string | null;
  readonly client_secret_ref: string;
  readonly secret_resolver: SecretResolver;
  readonly hash_state: (raw_state: string) => Promise<string> | string;
  readonly hmac: HmacSha256Hex;
  readonly state_store: ShopifyInstallStateStore;
  /** The host's current instant; the store must reject expired states atomically. */
  readonly now?: string;
}

export async function verifyShopifyCallback(input: ShopifyCallbackVerificationInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: ShopifyRefusalError['refusal_code'] }> {
  try {
    requireScope(input.tenant_id, 'TENANT_UNSCOPED');
    requireShop(input.shop);
    if (input.state.length === 0) {
      return { ok: false, reason: 'STATE_INVALID' };
    }
    let state_hash: string;
    try {
      state_hash = await input.hash_state(input.state);
    } catch {
      return { ok: false, reason: 'STATE_INVALID' };
    }
    if (state_hash.length === 0) {
      return { ok: false, reason: 'STATE_INVALID' };
    }
    if (input.provided_signature === null || input.provided_signature.length === 0) {
      return { ok: false, reason: 'SIGNATURE_MISSING' };
    }
    const secret = await resolveSecret(input.secret_resolver, input.client_secret_ref);
    const expected = input.hmac(secret, input.signed_material);
    if (!signatureMatches(expected, input.provided_signature)) {
      return { ok: false, reason: 'SIGNATURE_INVALID' };
    }
    const consumed = await input.state_store.consume({
      tenant_id: input.tenant_id,
      shop: input.shop,
      state_hash,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return consumed ? { ok: true } : { ok: false, reason: 'STATE_REPLAYED' };
  } catch (error) {
    if (error instanceof ShopifyRefusalError) {
      return { ok: false, reason: error.refusal_code };
    }
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
}

/** Completes OAuth only after signed callback and one-use state verification. */
export async function completeShopifyInstallation(input: {
  readonly tenant_id: string;
  readonly shop: string;
  readonly code: string;
  readonly callback: ShopifyCallbackVerificationInput;
  readonly existing: ShopifyInstallationStore;
  readonly oauth: ShopifyOAuthTransport;
  readonly client_secret_ref: string;
  readonly secret_resolver: SecretResolver;
  readonly installed_at: string;
  readonly now?: () => Date;
}): Promise<{ readonly status: 'INSTALLED' | 'ALREADY_INSTALLED'; readonly installation: ShopifyInstallation }> {
  requireScope(input.tenant_id, 'TENANT_UNSCOPED');
  requireShop(input.shop);
  const callback = await verifyShopifyCallback({
    ...input.callback,
    tenant_id: input.tenant_id,
    shop: input.shop,
    ...(input.now === undefined ? {} : { now: input.now().toISOString() }),
  });
  if (!callback.ok) {
    throw new ShopifyRefusalError(callback.reason, 'signed callback or OAuth state was refused');
  }

  const sameTenant = await input.existing.find({ tenant_id: input.tenant_id, shop: input.shop });
  if (sameTenant?.revoked_at === null) {
    return { status: 'ALREADY_INSTALLED', installation: sameTenant };
  }
  const otherTenant = await input.existing.findByShop(input.shop);
  if (otherTenant !== null && otherTenant.tenant_id !== input.tenant_id && otherTenant.revoked_at === null) {
    throw new ShopifyRefusalError('INSTALLATION_CONFLICT', 'shop is already bound to another tenant');
  }

  const client_secret = await resolveSecret(input.secret_resolver, input.client_secret_ref);
  let exchanged: ShopifyOAuthExchangeResult;
  try {
    exchanged = await input.oauth.exchangeAccessToken({
      tenant_id: input.tenant_id,
      shop: input.shop,
      code: input.code,
      client_secret,
    });
  } catch {
    throw genericTransportRefusal('UNKNOWN');
  }
  if (!exchanged.ok) throw genericTransportRefusal(exchanged.reason);
  if (exchanged.access_token.length === 0 || exchanged.credential_ref.length === 0) {
    throw new ShopifyRefusalError('SECRET_UNAVAILABLE', 'OAuth exchange returned no credential reference');
  }
  const installation: ShopifyInstallation = {
    tenant_id: input.tenant_id,
    shop: input.shop,
    credential_ref: exchanged.credential_ref,
    installed_at: input.installed_at,
    ...(exchanged.expires_at === undefined ? {} : { expires_at: exchanged.expires_at }),
    revoked_at: null,
  };
  if (credentialExpired(installation, input.now?.() ?? new Date())) {
    throw new ShopifyRefusalError('CREDENTIAL_EXPIRED', 'OAuth exchange returned an expired credential');
  }
  await input.existing.save(installation);
  return { status: 'INSTALLED', installation };
}

/** HMAC verification and delivery-id replay protection for signed Shopify webhooks. */
export async function verifyShopifyWebhook(input: {
  readonly tenant_id: string;
  readonly shop: string;
  readonly delivery_id: string;
  readonly raw_body: string;
  readonly provided_signature: string | null;
  readonly webhook_secret_ref: string;
  readonly secret_resolver: SecretResolver;
  readonly hmac: HmacSha256Hex;
  readonly installations: ShopifyInstallationStore;
  readonly replay: ShopifyDeliveryReplayStore;
}): Promise<{ readonly ok: true; readonly replayed: false } | { readonly ok: false; readonly reason: ShopifyRefusalError['refusal_code'] } | { readonly ok: true; readonly replayed: true }> {
  try {
    requireScope(input.tenant_id, 'TENANT_UNSCOPED');
    requireShop(input.shop);
    if (input.delivery_id.length === 0) return { ok: false, reason: 'DELIVERY_REPLAYED' };
    const installation = await input.installations.find({ tenant_id: input.tenant_id, shop: input.shop });
    if (installation === null || installation.revoked_at !== null) {
      return { ok: false, reason: 'SHOP_BINDING_MISMATCH' };
    }
    if (input.provided_signature === null || input.provided_signature.length === 0) {
      return { ok: false, reason: 'SIGNATURE_MISSING' };
    }
    const secret = await resolveSecret(input.secret_resolver, input.webhook_secret_ref);
    const expected = input.hmac(secret, input.raw_body);
    if (!signatureMatches(expected, input.provided_signature, 'BASE64')) {
      return { ok: false, reason: 'SIGNATURE_INVALID' };
    }
    const claimed = await input.replay.claim({ tenant_id: input.tenant_id, delivery_id: input.delivery_id });
    return claimed ? { ok: true, replayed: false } : { ok: true, replayed: true };
  } catch (error) {
    if (error instanceof ShopifyRefusalError) return { ok: false, reason: error.refusal_code };
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
}

export async function revokeShopifyInstallation(input: {
  readonly tenant_id: string;
  readonly shop: string;
  readonly revoked_at: string;
  readonly delivery_id: string;
  readonly raw_body: string;
  readonly provided_signature: string | null;
  readonly webhook_secret_ref: string;
  readonly secret_resolver: SecretResolver;
  readonly hmac: HmacSha256Hex;
  readonly installations: ShopifyInstallationStore;
  readonly replay: ShopifyDeliveryReplayStore;
}): Promise<{ readonly revoked: boolean; readonly replayed: boolean }> {
  const verified = await verifyShopifyWebhook(input);
  if (!verified.ok) throw new ShopifyRefusalError(verified.reason, 'uninstall webhook was refused');
  if (verified.replayed) return { revoked: false, replayed: true };
  await input.installations.revoke({
    tenant_id: input.tenant_id,
    shop: input.shop,
    revoked_at: input.revoked_at,
  });
  return { revoked: true, replayed: false };
}

function hasForbiddenPriceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenPriceField);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase() === 'floor_price' || key.toLowerCase() === 'floorprice' || hasForbiddenPriceField(nested),
  );
}

function observationTime(body: Record<string, unknown>, observed_at?: string): string {
  if (typeof observed_at === 'string' && observed_at.length > 0) return observed_at;
  for (const field of ['observed_at', 'updated_at', 'snapshot_at']) {
    const candidate = body[field];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  throw new ShopifyRefusalError('OBSERVATION_UNAVAILABLE', 'provider observation time is required');
}

/** GraphQL Admin client over an injected transport; no SDK, fetch, or provider default is used. */
export class ShopifyAdminClient implements ShopifyGraphqlAdminClient {
  constructor(
    private readonly deps: {
      readonly transport: ShopifyGraphqlTransport;
      readonly installations: ShopifyInstallationStore;
      readonly secret_resolver: SecretResolver;
      readonly now?: () => Date;
    },
  ) {}

  async query(input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly query: string;
    readonly variables?: Readonly<Record<string, unknown>>;
  }): Promise<ShopifyGraphqlResult> {
    requireScope(input.tenant_id, 'TENANT_UNSCOPED');
    requireShop(input.shop);
    const installation = await this.deps.installations.find({ tenant_id: input.tenant_id, shop: input.shop });
    if (installation === null || installation.revoked_at !== null) {
      throw new ShopifyRefusalError('SHOP_BINDING_MISMATCH', 'shop is not installed for this tenant');
    }
    if (credentialExpired(installation, this.deps.now?.() ?? new Date())) {
      throw new ShopifyRefusalError('CREDENTIAL_EXPIRED', 'Shopify access credential has expired');
    }
    const access_token = await resolveSecret(this.deps.secret_resolver, installation.credential_ref);
    let result: ShopifyGraphqlTransportResult;
    try {
      result = await this.deps.transport.execute({
        tenant_id: input.tenant_id,
        shop: input.shop,
        access_token,
        query: input.query,
        variables: input.variables ?? {},
      });
    } catch {
      throw genericTransportRefusal('UNKNOWN');
    }
    if (!result.ok) throw genericTransportRefusal(result.failure_class);
    if (hasForbiddenPriceField(result.body)) {
      throw new ShopifyRefusalError('PRICE_SOURCE_FORBIDDEN', 'Shopify observations cannot contain floor_price');
    }
    return {
      status: result.status,
      body: result.body,
      observed_at: observationTime(result.body, result.observed_at),
    };
  }
}

export const SHOPIFY_CATALOG_QUERY = 'query CatalogObservation { products { nodes { id title handle } } }';
export const SHOPIFY_INVENTORY_QUERY = 'query InventoryObservation { inventoryLevels(first: 100) { nodes { id available } } }';
export const SHOPIFY_ORDER_QUERY = 'query OrderObservation { orders(first: 100) { nodes { id createdAt } } }';

export interface ShopifyObservation {
  readonly tenant_id: string;
  readonly shop: string;
  readonly resource: 'catalog' | 'inventory' | 'orders';
  readonly observed_at: string;
  readonly value: Record<string, unknown>;
}

async function syncObservation(
  client: ShopifyGraphqlAdminClient,
  input: {
    readonly tenant_id: string;
    readonly shop: string;
    readonly query: string;
    readonly resource: ShopifyObservation['resource'];
    readonly variables?: Readonly<Record<string, unknown>>;
  },
): Promise<ShopifyObservation> {
  const result = await client.query(input);
  if (hasForbiddenPriceField(result.body)) {
    throw new ShopifyRefusalError('PRICE_SOURCE_FORBIDDEN', 'Shopify observations cannot contain floor_price');
  }
  return {
    tenant_id: input.tenant_id,
    shop: input.shop,
    resource: input.resource,
    observed_at: result.observed_at,
    value: result.body,
  };
}

export function syncShopifyCatalog(client: ShopifyGraphqlAdminClient, input: { readonly tenant_id: string; readonly shop: string }): Promise<ShopifyObservation> {
  return syncObservation(client, { ...input, query: SHOPIFY_CATALOG_QUERY, resource: 'catalog' });
}

export function syncShopifyInventory(client: ShopifyGraphqlAdminClient, input: { readonly tenant_id: string; readonly shop: string }): Promise<ShopifyObservation> {
  return syncObservation(client, { ...input, query: SHOPIFY_INVENTORY_QUERY, resource: 'inventory' });
}

export function syncShopifyOrders(client: ShopifyGraphqlAdminClient, input: { readonly tenant_id: string; readonly shop: string }): Promise<ShopifyObservation> {
  return syncObservation(client, { ...input, query: SHOPIFY_ORDER_QUERY, resource: 'orders' });
}

export interface ShopifyConnectorDeps {
  readonly client: ShopifyGraphqlAdminClient;
  /** Server-resolved tenant binding; a caller's payload can never establish a shop. */
  readonly shopForTenant: (tenant_id: string) => string | null;
}
function unsupportedShopifyDispatch(): Promise<ExecutionReceipt> {
  return Promise.reject(new ShopifyRefusalError(
    'UNSUPPORTED_OPERATION',
    'Shopify adapter exposes observations only; it never writes a system of record',
  ));
}

/** Creates the registry entry; registration is explicit and never installs a default connector. */
export function createShopifyConnector(deps: ShopifyConnectorDeps): RegisteredConnector {
  const read = async (input: {
    readonly tenant_id: string;
    readonly resource: string;
    readonly key?: string;
  }): Promise<ConnectorReadResult> => {
    requireScope(input.tenant_id, 'TENANT_UNSCOPED');
    const shop = deps.shopForTenant(input.tenant_id);
    if (shop === null || shop.trim().length === 0) {
      throw new ShopifyRefusalError('SHOP_BINDING_MISMATCH', 'tenant has no server-resolved Shopify shop');
    }
    requireShop(shop);
    if (input.key !== undefined && input.key !== shop) {
      throw new ShopifyRefusalError('SHOP_BINDING_MISMATCH', 'requested shop is not bound to the tenant');
    }
    let observation: ShopifyObservation;
    if (input.resource === 'catalog' || input.resource === 'products') {
      observation = await syncShopifyCatalog(deps.client, { tenant_id: input.tenant_id, shop });
    } else if (input.resource === 'inventory') {
      observation = await syncShopifyInventory(deps.client, { tenant_id: input.tenant_id, shop });
    } else if (input.resource === 'orders') {
      observation = await syncShopifyOrders(deps.client, { tenant_id: input.tenant_id, shop });
    } else {
      throw new ShopifyRefusalError('UNSUPPORTED_OPERATION', `resource '${input.resource}' is not supported`);
    }
    return {
      resource: input.resource,
      value: observation.value,
      observed_at: observation.observed_at,
      tenant_id: input.tenant_id,
    };
  };
  return {
    descriptor: {
      connector_id: SHOPIFY_CONNECTOR_ID,
      kind: 'SYSTEM_OF_RECORD',
      provider: 'Shopify GraphQL Admin API [UNCONFIRMED][ASM-001]',
      read_resources: ['catalog', 'products', 'inventory', 'orders'],
    },
    dispatch: unsupportedShopifyDispatch,
    read,
  };
}

export function registerShopifyConnector(registry: ConnectorRegistry, deps: ShopifyConnectorDeps): RegisteredConnector {
  const connector = createShopifyConnector(deps);
  registry.register(connector);
  return connector;
}

/** Keeps the action import in this module's public contract without accepting payload authority. */
export function rejectShopifyAction(_action: ActionDraft): never {
  throw new ShopifyRefusalError('UNSUPPORTED_OPERATION', 'Shopify adapter does not dispatch actions');
}

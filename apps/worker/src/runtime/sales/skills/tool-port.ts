import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Customer360Fact } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';
import type {
  SalesCartInput,
  SalesCartOutput,
  SalesCartPort,
  SalesCommunicationInput,
  SalesCommunicationOutput,
  SalesCommunicationPort,
  SalesConsentDecision,
  SalesConsentPort,
  SalesCustomer360Fact,
  SalesFrequencyCapPort,
  SalesOrderInput,
  SalesOrderOutput,
  SalesOrderPort,
  SalesPaymentPolicy,
  SalesPaymentPolicyPort,
  SalesPaymentPolicyQuery,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
  SalesQuote,
  SalesQuotePort,
  SalesQuoteQuery,
  SalesReplenishmentPolicyPort,
} from './types.js';

export interface SalesContextAggregatorLike {
  verifiedCustomerFor(
    tenant_id: string,
    correlation_id: string,
  ): Customer360Fact | SalesCustomer360Fact | Promise<Customer360Fact | SalesCustomer360Fact | null> | null;
  verifiedTimelineFor(
    tenant_id: string,
    correlation_id: string,
  ): CustomerEventTimeline | Promise<CustomerEventTimeline | null> | null;
  takeoverActiveFor?(tenant_id: string, correlation_id: string): Promise<boolean> | boolean;
}

/** Owner-approved revenue evidence required before recommendation execution can succeed. */
export interface SalesRecommendationRevenueEvidence {
  readonly conversion_probability: number;
  readonly expected_revenue: number;
  readonly currency: string;
  readonly model_id: string;
  readonly provenance_reference: string;
}

/**
 * Host-provided boundary for the recommendation contract's economic outcome.
 * No default implementation exists: without this owner-approved source, recommendations refuse.
 */
export interface SalesRecommendationRevenueEvidencePort {
  read(input: {
    readonly tenant_id: string;
    readonly customer_id: string;
    readonly sku: string;
    readonly recommendation_type: string;
    readonly confidence: number;
    readonly list_price: number;
    readonly currency: string;
  }): Promise<SalesRecommendationRevenueEvidence>;
}

export interface SalesSkillToolPortOptions {
  readonly erp_read: ErpReadPort | null;
  readonly context: Pick<SalesContextAggregatorLike, 'verifiedCustomerFor' | 'verifiedTimelineFor'> & Partial<SalesContextAggregatorLike>;
  /** Owner-approved revenue evidence source; absent means recommendation execution refuses. */
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  /** Retained as an injection seam for callers; this port never invents provider timestamps. */
  readonly now?: (() => Date) | undefined;

  readonly price_floor?: SalesPriceFloorPort | null | undefined;
  readonly cart?: SalesCartPort | null | undefined;
  readonly order?: SalesOrderPort | null | undefined;
  readonly communication?: SalesCommunicationPort | null | undefined;
  readonly consent?: SalesConsentPort | null | undefined;
  readonly frequency_cap?: SalesFrequencyCapPort | null | undefined;
  readonly replenishment_policy?: SalesReplenishmentPolicyPort | null | undefined;
  readonly quote?: SalesQuotePort | null | undefined;
  readonly payment_policy?: SalesPaymentPolicyPort | null | undefined;
  readonly is_takeover_active?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  readonly takeover_active?: boolean | undefined;
  readonly quote_signing_secret?: string | undefined;
}

export interface QuoteTokenPayload {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly customer_id: string;
  readonly final_price: number;
  readonly p_floor: number;
  readonly currency: string;
  readonly quote_expires_at: string;
}

export function buildCanonicalQuotePayload(payload: QuoteTokenPayload): string {
  return `${payload.tenant_id}:${payload.sku_id}:${payload.customer_id}:${payload.final_price}:${payload.p_floor}:${payload.currency}:${payload.quote_expires_at}`;
}

export function computeQuoteToken(secret: string, payload: QuoteTokenPayload): string {
  const canonical = buildCanonicalQuotePayload(payload);
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function hasQuoteSigningSecret(
  options: Pick<SalesSkillToolPortOptions, 'quote_signing_secret'>,
): boolean {
  return typeof options.quote_signing_secret === 'string' && options.quote_signing_secret.trim().length > 0;
}

export interface AuthoritativeQuoteResult {
  readonly total_amount: number;
  readonly currency: string;
  readonly cart_id?: string | undefined;
  readonly quote_token?: string | undefined;
  readonly quote_expires_at?: string | undefined;
  readonly sku_id?: string | undefined;
  readonly p_floor?: number | undefined;
  readonly final_price?: number | undefined;
  readonly customer_id?: string | undefined;
  readonly [key: string]: unknown;
}
export class SalesSkillToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SalesSkillToolError';
    this.code = code;
  }
}

export function hasAuthoritativeQuotePort(
  options: Pick<SalesSkillToolPortOptions, 'quote' | 'cart' | 'price_floor' | 'order'>,
): boolean {
  if (options.quote !== undefined && options.quote !== null) return true;
  if (options.order !== undefined && options.order !== null) {
    if (typeof options.order.validateQuote === 'function' || typeof options.order.authorizeOrder === 'function') {
      return true;
    }
  }
  if (options.cart !== undefined && options.cart !== null) {
    if (options.cart.quote !== undefined && options.cart.quote !== null) return true;
    const cartFn =
      options.cart.getCart ??
      options.cart.readCart ??
      options.cart.getQuote ??
      options.cart.readQuote ??
      options.cart.read;
    if (typeof cartFn === 'function') return true;
  }
  if (options.price_floor !== undefined && options.price_floor !== null && typeof options.price_floor.readQuote === 'function') {
    return true;
  }
  return false;
}

export function hasPaymentPolicyPort(
  options: Pick<SalesSkillToolPortOptions, 'payment_policy' | 'order'>,
): boolean {
  if (options.payment_policy !== undefined && options.payment_policy !== null) return true;
  if (options.order !== undefined && options.order !== null) {
    if (options.order.payment_policy !== undefined && options.order.payment_policy !== null) return true;
    if (typeof options.order.readSupportedPaymentMethods === 'function') return true;
  }
  return false;
}

async function readAuthoritativeQuote(
  options: SalesSkillToolPortOptions,
  query: SalesQuoteQuery,
): Promise<AuthoritativeQuoteResult> {
  if (options.order) {
    const fn = options.order.validateQuote ?? options.order.authorizeOrder;
    if (typeof fn === 'function') {
      try {
        const q = await fn.call(options.order, query);
        if (q) {
          const total = (q as SalesQuote).total_amount ?? (q as SalesCartOutput).subtotal;
          const currency = q.currency;
          if (typeof total === 'number' && typeof currency === 'string') {
            return { ...(q as Record<string, unknown>), total_amount: total, currency };
          }
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Order preflight quote is missing total or currency');
      } catch (err) {
        if (err instanceof SalesSkillToolError) throw err;
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Order preflight quote read failed');
      }
    }
  }

  if (options.quote) {
    const fn = options.quote.readQuote ?? options.quote.getQuote ?? options.quote.read;
    if (typeof fn === 'function') {
      try {
        const q = await fn.call(options.quote, query);
        if (q) {
          const total = (q as SalesQuote).total_amount ?? (q as SalesCartOutput).subtotal;
          const currency = q.currency;
          if (typeof total === 'number' && typeof currency === 'string') {
            return { ...(q as Record<string, unknown>), total_amount: total, currency };
          }
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Authoritative quote is missing total or currency');
      } catch (err) {
        if (err instanceof SalesSkillToolError) throw err;
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Authoritative quote read failed');
      }
    }
  }

  if (options.cart) {
    if (options.cart.quote) {
      const fn = options.cart.quote.readQuote ?? options.cart.quote.getQuote ?? options.cart.quote.read;
      if (typeof fn === 'function') {
        try {
          const q = await fn.call(options.cart.quote, query);
          if (q) {
            const total = (q as SalesQuote).total_amount ?? (q as SalesCartOutput).subtotal;
            const currency = q.currency;
            if (typeof total === 'number' && typeof currency === 'string') {
              return { ...(q as Record<string, unknown>), total_amount: total, currency };
            }
          }
          throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Authoritative cart quote is missing total or currency');
        } catch (err) {
          if (err instanceof SalesSkillToolError) throw err;
          throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Authoritative cart quote read failed');
        }
      }
    }
    const cartFn =
      options.cart.getCart ??
      options.cart.readCart ??
      options.cart.getQuote ??
      options.cart.readQuote ??
      options.cart.read;
    if (typeof cartFn === 'function') {
      try {
        const c = await cartFn.call(options.cart, query);
        if (c) {
          const total = (c as SalesQuote).total_amount ?? (c as SalesCartOutput).subtotal;
          const currency = c.currency;
          if (typeof total === 'number' && typeof currency === 'string') {
            return { ...(c as Record<string, unknown>), total_amount: total, currency };
          }
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', `Authoritative quote for cart ${query.cart_id} was not found`);
      } catch (err) {
        if (err instanceof SalesSkillToolError) throw err;
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Authoritative cart read failed');
      }
    }
  }

  if (options.price_floor && typeof options.price_floor.readQuote === 'function') {
    try {
      const q = await options.price_floor.readQuote(query);
      if (q) {
        const total = q.total_amount ?? q.subtotal;
        const currency = q.currency;
        if (typeof total === 'number' && typeof currency === 'string') {
          return { ...(q as Record<string, unknown>), total_amount: total, currency };
        }
      }
      throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', `Authoritative price quote for cart ${query.cart_id} was not found`);
    } catch (err) {
      if (err instanceof SalesSkillToolError) throw err;
      throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Authoritative price quote read failed');
    }
  }

  throw new SalesSkillToolError(
    'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    'No authoritative quote source is available for cart verification',
  );
}

async function readSupportedPaymentMethods(
  options: SalesSkillToolPortOptions,
  query: SalesPaymentPolicyQuery,
): Promise<readonly string[]> {
  if (options.payment_policy) {
    const fn = options.payment_policy.readSupportedPaymentMethods ?? options.payment_policy.read;
    if (typeof fn === 'function') {
      try {
        const result = await fn.call(options.payment_policy, query);
        if (result) {
          if (Array.isArray(result)) {
            return result;
          }
          if (typeof result === 'object' && 'supported_payment_methods' in result && Array.isArray((result as SalesPaymentPolicy).supported_payment_methods)) {
            return (result as SalesPaymentPolicy).supported_payment_methods;
          }
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Payment policy returned no supported payment methods');
      } catch (err) {
        if (err instanceof SalesSkillToolError) throw err;
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Failed to read payment policy');
      }
    }
  }

  if (options.order) {
    if (options.order.payment_policy) {
      const fn = options.order.payment_policy.readSupportedPaymentMethods ?? options.order.payment_policy.read;
      if (typeof fn === 'function') {
        try {
          const result = await fn.call(options.order.payment_policy, query);
          if (result) {
            if (Array.isArray(result)) {
              return result;
            }
            if (typeof result === 'object' && 'supported_payment_methods' in result && Array.isArray((result as SalesPaymentPolicy).supported_payment_methods)) {
              return (result as SalesPaymentPolicy).supported_payment_methods;
            }
          }
          throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Order payment policy returned no supported payment methods');
        } catch (err) {
          if (err instanceof SalesSkillToolError) throw err;
          throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Failed to read order payment policy');
        }
      }
    }
    if (typeof options.order.readSupportedPaymentMethods === 'function') {
      try {
        const result = await options.order.readSupportedPaymentMethods(query);
        if (Array.isArray(result)) {
          return result;
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'Order supported payment methods query returned invalid result');
      } catch (err) {
        if (err instanceof SalesSkillToolError) throw err;
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', err instanceof Error ? err.message : 'Failed to read supported payment methods');
      }
    }
  }

  throw new SalesSkillToolError(
    'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    'No payment policy port is bound; tenant supported payment methods are unavailable',
  );
}


interface ProductItem {
  readonly product_id?: string;
  readonly id?: string;
  readonly sku?: string;
  readonly sku_id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly original_list_price?: number;
  readonly list_price?: number;
  readonly price?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly is_active?: boolean;
  readonly active?: boolean;
  readonly tenant_id?: string;
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
  readonly category_path?: string;
}

interface InventoryItem {
  readonly tenant_id?: string;
  readonly sku_id?: string;
  readonly sku?: string;
  readonly total_available_to_promise?: number;
}

interface ProviderEnvelope<T> {
  readonly snapshot_at?: string;
  readonly updated_at?: string;
  readonly observed_at?: string;
  readonly tenant_id?: string;
  readonly items?: readonly T[];
}

interface ErpReadResultRecord {
  readonly value: unknown;
  readonly observed_at: string;
  readonly tenant_id: string;
}

interface CatalogRead {
  readonly snapshot_at: string;
  readonly observed_at: string;
  readonly tenant_id: string;
  readonly items: readonly ProductItem[];
}

interface InventoryRead {
  readonly snapshot_at: string;
  readonly observed_at: string;
  readonly tenant_id: string;
  readonly item: InventoryItem;
}

interface SearchProductInput {
  readonly tenant_id: string;
  readonly query: string;
  readonly category_id?: string;
  readonly limit?: number;
}

interface CheckStockInput {
  readonly tenant_id: string;
  readonly sku_id: string;
}

interface RetrieveCustomerInput {
  readonly tenant_id: string;
  readonly customer_identifier: string;
}

interface RecommendProductInput {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly current_cart_skus: readonly string[];
  readonly recommendation_type?: string;
}

interface CheckPriceInput {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly customer_id: string;
  readonly requested_discount_percent?: number;
}

type CreateCartInput = SalesCartInput;
type CreateOrderInput = SalesOrderInput;
type SendMessageInput = SalesCommunicationInput;
const INJECTION_MARKERS = /(?:--|\/\*|\*\/|;|<script\b|ignore\s+previous|system\s*:|assistant\s*:|developer\s*:)/i;
const RECOMMENDATION_TYPES = ['CROSS_SELL', 'UPSELL', 'SUBSTITUTE', 'BUNDLE', 'REPLENISHMENT'] as const;
const RECOMMENDATION_THRESHOLD = 0.65;

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isActiveProduct(product: ProductItem): boolean {
  if (typeof product.is_active === 'boolean') return product.is_active;
  if (typeof product.active === 'boolean') return product.active;
  return typeof product.status === 'string' && product.status.toUpperCase() === 'ACTIVE';
}

function productSku(product: ProductItem): string | undefined {
  return product.sku ?? product.sku_id;
}

function productName(product: ProductItem): string | undefined {
  return product.name ?? product.title;
}

function productListPrice(product: ProductItem): number | undefined {
  const value = product.original_list_price ?? product.list_price ?? product.price;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function categoryMatches(product: ProductItem, category_id: string | undefined): boolean {
  if (category_id === undefined) return true;
  if (product.category_path?.split('/').includes(category_id)) return true;
  return product.categories?.includes(category_id) ?? false;
}

function eventText(event: CustomerEventTimeline['items'][number]): string {
  const payload = event.payload;
  const parts: string[] = [];
  for (const key of ['category', 'category_id', 'topic', 'product_category', 'sku']) {
    const value = payload[key];
    if (typeof value === 'string') parts.push(value);
  }
  const tags = payload.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string') parts.push(tag);
    }
  }
  return parts.join(' ').toLocaleLowerCase();
}

export function hasTakeoverAuthority(options: {
  readonly takeover_active?: boolean | undefined;
  readonly is_takeover_active?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  readonly context?: {
    readonly takeoverActiveFor?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  } | undefined;
}): boolean {
  return (
    typeof options.takeover_active === 'boolean'
    || typeof options.is_takeover_active === 'function'
    || typeof options.context?.takeoverActiveFor === 'function'
  );
}

export function createSalesSkillToolPort(options: SalesSkillToolPortOptions): SkillToolPort {
  async function readCatalogFromSor(tenant_id: string): Promise<CatalogRead> {
    if (options.erp_read === null) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP read connector is unavailable',
      );
    }

    let rawResult: unknown;
    try {
      rawResult = await options.erp_read.read({ tenant_id, resource: 'products' });
    } catch {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP catalog read failed',
      );
    }

    if (typeof rawResult !== 'object' || rawResult === null || Array.isArray(rawResult)) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP catalog response is invalid',
      );
    }

    const readResult = rawResult as ErpReadResultRecord;
    if (readResult.tenant_id !== tenant_id || !isValidIsoDate(readResult.observed_at)) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP catalog tenant or timestamp is invalid',
      );
    }

    if (
      typeof readResult.value !== 'object'
      || readResult.value === null
      || Array.isArray(readResult.value)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative catalog envelope is missing or invalid',
      );
    }

    const envelope = readResult.value as ProviderEnvelope<ProductItem>;
    const snapshot_at = envelope.snapshot_at ?? envelope.updated_at ?? envelope.observed_at;
    if (
      !isValidIsoDate(snapshot_at)
      || !Array.isArray(envelope.items)
      || (envelope.tenant_id !== undefined && envelope.tenant_id !== tenant_id)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative catalog envelope is missing or invalid',
      );
    }

    return {
      snapshot_at,
      observed_at: readResult.observed_at,
      tenant_id,
      items: envelope.items,
    };
  }

  async function readInventoryFromSor(tenant_id: string, sku_id: string): Promise<InventoryRead> {
    if (options.erp_read === null) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP read connector is unavailable',
      );
    }

    let rawResult: unknown;
    try {
      rawResult = await options.erp_read.read({ tenant_id, resource: 'inventory', key: sku_id });
    } catch {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP inventory read failed',
      );
    }

    if (typeof rawResult !== 'object' || rawResult === null || Array.isArray(rawResult)) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP inventory response is invalid',
      );
    }

    const readResult = rawResult as ErpReadResultRecord;
    if (readResult.tenant_id !== tenant_id || !isValidIsoDate(readResult.observed_at)) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative ERP inventory tenant or timestamp is invalid',
      );
    }

    if (
      typeof readResult.value !== 'object'
      || readResult.value === null
      || Array.isArray(readResult.value)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative inventory envelope is missing or invalid',
      );
    }

    const envelope = readResult.value as ProviderEnvelope<InventoryItem>;
    const snapshot_at = envelope.snapshot_at ?? envelope.updated_at ?? envelope.observed_at;
    if (
      !isValidIsoDate(snapshot_at)
      || !Array.isArray(envelope.items)
      || (envelope.tenant_id !== undefined && envelope.tenant_id !== tenant_id)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Authoritative inventory envelope is missing or invalid',
      );
    }

    const item = envelope.items.find((candidate) =>
      (candidate.sku_id === sku_id || candidate.sku === sku_id)
      && candidate.tenant_id === tenant_id
      && Number.isSafeInteger(candidate.total_available_to_promise)
      && candidate.total_available_to_promise >= 0,
    );
    if (item === undefined) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Requested SKU has no valid authoritative inventory record',
      );
    }

    return {
      snapshot_at,
      observed_at: readResult.observed_at,
      tenant_id,
      item,
    };
  }

  async function handleSearchProduct(
    invocation: SkillToolInvocation<SearchProductInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id } = invocation.context;
    const input = invocation.input;
    const query = input.query.trim().toLocaleLowerCase();
    const limit = input.limit ?? 5;

    if (
      input.tenant_id !== tenant_id
      || query.length === 0
      || INJECTION_MARKERS.test(input.query)
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 20
    ) {
      throw new SalesSkillToolError(
        'MALFORMED_QUERY',
        'Catalog search query or tenant scope is invalid',
      );
    }

    const catalog = await readCatalogFromSor(tenant_id);
    const matched = catalog.items
      .filter((product) => {
        if (
          !isActiveProduct(product)
          || product.tenant_id !== tenant_id
          || !categoryMatches(product, input.category_id)
        ) {
          return false;
        }
        const searchable = [
          productSku(product),
          productName(product),
          product.description,
          ...(product.categories ?? []),
          ...(product.tags ?? []),
        ]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
          .toLocaleLowerCase();
        return searchable.includes(query);
      })
      .sort((left, right) => (productSku(left) ?? '').localeCompare(productSku(right) ?? ''));

    const products: Array<Record<string, unknown>> = [];
    for (const product of matched.slice(0, limit)) {
      const product_id = product.product_id ?? product.id;
      const sku = productSku(product);
      const name = productName(product);
      const list_price = productListPrice(product);
      if (
        product_id === undefined
        || sku === undefined
        || name === undefined
        || list_price === undefined
        || list_price < 0
        || product.currency === undefined
        || product.currency.trim().length === 0
      ) {
        throw new SalesSkillToolError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          'Authoritative catalog record is incomplete or invalid',
        );
      }

      const inventory = await readInventoryFromSor(tenant_id, sku);
      products.push({
        product_id,
        sku,
        name,
        list_price,
        currency: product.currency,
        in_stock: inventory.item.total_available_to_promise! > 0,
      });
    }

    return {
      products,
      total_found: matched.length,
    };
  }

  async function handleCheckStock(
    invocation: SkillToolInvocation<CheckStockInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id } = invocation.context;
    const input = invocation.input;
    if (input.tenant_id !== tenant_id || input.sku_id.trim().length === 0) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Inventory request tenant or SKU is invalid',
      );
    }

    const inventory = await readInventoryFromSor(tenant_id, input.sku_id);
    const available_quantity = inventory.item.total_available_to_promise!;
    return {
      sku_id: input.sku_id,
      available_quantity,
      in_stock: available_quantity > 0,
      checked_at: inventory.snapshot_at,
    };
  }

  async function handleRetrieveCustomer(
    invocation: SkillToolInvocation<RetrieveCustomerInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id, correlation_id } = invocation.context;
    const input = invocation.input;
    if (input.tenant_id !== tenant_id) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Customer request tenant does not match the server-bound tenant',
      );
    }

    const customer = await options.context.verifiedCustomerFor(tenant_id, correlation_id);
    if (
      customer === null
      || customer.tenant_id !== tenant_id
      || customer.customer_id !== input.customer_identifier
    ) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Customer identity is not bound to this verified session',
      );
    }

    const extCustomer = customer as SalesCustomer360Fact;
    let lastOrderDate: string | null = null;
    if (typeof extCustomer.last_order_date === 'string' && isValidIsoDate(extCustomer.last_order_date)) {
      lastOrderDate = extCustomer.last_order_date;
    } else {
      const evidence = extCustomer.purchase_evidence
        ?? extCustomer.purchases
        ?? extCustomer.verified_purchases
        ?? extCustomer.order_events;
      if (Array.isArray(evidence) && evidence.length > 0) {
        const sorted = [...evidence]
          .map((e) => e.order_date)
          .filter(isValidIsoDate)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
        if (sorted.length > 0 && sorted[0] !== undefined) {
          lastOrderDate = sorted[0];
        }
      }
    }

    return {
      customer_id: customer.customer_id,
      total_orders: customer.order_count,
      lifetime_value: customer.total_spent,
      verified: true,
      rfm_segment: customer.rfm_segment_hypothesis,
      last_order_date: lastOrderDate,
    };
  }

  async function handleRecommendProduct(
    invocation: SkillToolInvocation<RecommendProductInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id, correlation_id } = invocation.context;
    const input = invocation.input;
    const recommendation_type = input.recommendation_type ?? 'CROSS_SELL';

    if (
      input.tenant_id !== tenant_id
      || !RECOMMENDATION_TYPES.includes(recommendation_type as (typeof RECOMMENDATION_TYPES)[number])
    ) {
      throw new SalesSkillToolError(
        'SCHEMA_VALIDATION_ERROR',
        'Recommendation tenant or type is invalid',
      );
    }

    const customer = await options.context.verifiedCustomerFor(tenant_id, correlation_id);
    if (
      customer === null
      || customer.tenant_id !== tenant_id
      || customer.customer_id !== input.customer_id
    ) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Recommendation customer is not verified for this session',
      );
    }
    if (!customer.consent_marketing || customer.suppression_active) {
      throw new SalesSkillToolError(
        'CONSENT_REQUIRED',
        'Recommendation is unavailable without current marketing consent',
      );
    }

    const timeline = await options.context.verifiedTimelineFor(tenant_id, correlation_id);
    const eventIds = timeline?.items
      .map((event) => event.event_id)
      .filter((event_id) => event_id.trim().length > 0) ?? [];
    if (eventIds.length === 0) {
      throw new SalesSkillToolError(
        'EVIDENCE_REQUIRED',
        'Recommendation requires a verified Customer360 timeline event',
      );
    }

    if (options.revenue_evidence === undefined) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Owner-approved revenue evidence is unavailable; recommendation execution is refused',
      );
    }

    const catalog = await readCatalogFromSor(tenant_id);
    const cartSkus = new Set(input.current_cart_skus);
    const eventTextValue = timeline?.items.map(eventText).join(' ') ?? '';
    const candidates = catalog.items
      .filter((product) => {
        const sku = productSku(product);
        return (
          isActiveProduct(product)
          && product.tenant_id === tenant_id
          && sku !== undefined
          && !cartSkus.has(sku)
        );
      })
      .sort((left, right) => (productSku(left) ?? '').localeCompare(productSku(right) ?? ''));

    for (const product of candidates) {
      const sku = productSku(product);
      const name = productName(product);
      const list_price = productListPrice(product);
      const currency = typeof product.currency === 'string' ? product.currency.trim() : undefined;
      if (
        sku === undefined
        || name === undefined
        || name.trim().length === 0
        || list_price === undefined
        || list_price < 0
        || currency === undefined
        || currency.length === 0
      ) {
        continue;
      }

      let inventory: InventoryRead;
      try {
        inventory = await readInventoryFromSor(tenant_id, sku);
      } catch {
        continue;
      }
      if (inventory.item.total_available_to_promise! <= 0) continue;

      const productTerms = [
        sku,
        name,
        ...(product.categories ?? []),
        ...(product.tags ?? []),
      ].join(' ').toLocaleLowerCase();
      const categoryAffinity = eventTextValue.length > 0 && productTerms.length > 0 && eventTextValue
        .split(/\s+/)
        .some((term) => term.length > 1 && productTerms.includes(term));
      const confidence = Math.min(
        0.95,
        RECOMMENDATION_THRESHOLD + (categoryAffinity ? 0.15 : 0),
      );

      let revenue: SalesRecommendationRevenueEvidence;
      try {
        revenue = await options.revenue_evidence.read({
          tenant_id,
          customer_id: customer.customer_id,
          sku,
          recommendation_type,
          confidence,
          list_price,
          currency,
        });
      } catch {
        continue;
      }

      if (
        !Number.isFinite(revenue.conversion_probability)
        || revenue.conversion_probability < 0
        || revenue.conversion_probability > 1
        || !Number.isFinite(revenue.expected_revenue)
        || revenue.expected_revenue < 0
        || revenue.currency !== currency
        || revenue.model_id.trim().length === 0
        || revenue.provenance_reference.trim().length === 0
      ) {
        continue;
      }

      return {
        customer: customer.customer_id,
        product: { sku, name, price: list_price },
        reason: `Available product selected from verified Customer360 event ${eventIds[0]}.`,
        evidence: {
          verified_timeline_event_ids: eventIds,
          verified_model: revenue.model_id,
          historical_spend: customer.total_spent,
          ...(categoryAffinity ? { category_affinity: 'verified timeline overlap' } : {}),
        },
        eligibility: {
          stock_available: true,
          consent_verified: true,
          suppression_cleared: true,
        },
        confidence,
        expected_outcome: {
          conversion_probability: revenue.conversion_probability,
          expected_revenue: revenue.expected_revenue,
          currency: revenue.currency,
        },
      };
    }

    throw new SalesSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'No candidate has complete authoritative inventory and revenue evidence',
    );
  }

  async function handleCheckPrice(
    invocation: SkillToolInvocation<CheckPriceInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id } = invocation.context;
    const input = invocation.input;

    if (input.tenant_id !== tenant_id) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Check price request tenant does not match the server-bound tenant',
      );
    }

    const priceFloorPort = options.price_floor;
    if (!priceFloorPort) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'API-001.PricingEngine port is not bound',
      );
    }

    let decision: SalesPriceFloorDecision;
    try {
      decision = await priceFloorPort.read({
        tenant_id: input.tenant_id,
        sku_id: input.sku_id,
      });
    } catch {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'API-001.PricingEngine read failed',
      );
    }

    if (!decision || typeof decision !== 'object') {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        'Authoritative floor decision is missing',
      );
    }

    if (decision.owner_approved !== true) {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        decision.reason ?? 'Floor decision is not owner-approved',
      );
    }

    if (
      typeof decision.floor_source !== 'string'
      || decision.floor_source.trim().length === 0
    ) {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        'Floor provenance is absent or empty',
      );
    }

    if (
      typeof decision.quote_ttl_seconds !== 'number'
      || !Number.isFinite(decision.quote_ttl_seconds)
      || decision.quote_ttl_seconds <= 0
    ) {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        'Quote TTL seconds is missing or non-positive',
      );
    }

    if (
      typeof decision.list_price !== 'number'
      || !Number.isFinite(decision.list_price)
      || decision.list_price < 0
      || typeof decision.p_floor !== 'number'
      || !Number.isFinite(decision.p_floor)
      || decision.p_floor < 0
      || decision.p_floor > decision.list_price
      || typeof decision.currency !== 'string'
      || decision.currency.trim().length === 0
    ) {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        'Pricing engine returned invalid list_price, p_floor, or currency',
      );
    }

    const clock = options.now ?? (() => new Date());
    const quote_expires_at = new Date(clock().getTime() + decision.quote_ttl_seconds * 1000).toISOString();

    let final_price = decision.list_price;
    let discount_allowed = true;

    if (
      typeof input.requested_discount_percent === 'number'
      && Number.isFinite(input.requested_discount_percent)
      && input.requested_discount_percent > 0
    ) {
      const discounted = Number((decision.list_price * (1 - input.requested_discount_percent / 100)).toFixed(2));
      if (discounted >= decision.p_floor) {
        final_price = discounted;
        discount_allowed = true;
      } else {
        final_price = decision.list_price;
        discount_allowed = false;
      }
    }

    if (!hasQuoteSigningSecret(options)) {
      throw new SalesSkillToolError(
        'P_FLOOR_UNAVAILABLE',
        'Quote signing secret is not bound',
      );
    }

    const quote_token = computeQuoteToken(options.quote_signing_secret!, {
      tenant_id,
      sku_id: input.sku_id,
      customer_id: input.customer_id,
      final_price,
      p_floor: decision.p_floor,
      currency: decision.currency,
      quote_expires_at,
    });
    return {
      sku_id: input.sku_id,
      list_price: decision.list_price,
      final_price,
      p_floor: decision.p_floor,
      discount_allowed,
      currency: decision.currency,
      quote_token,
      quote_expires_at,
    };
  }

  async function handleCreateCart(
    invocation: SkillToolInvocation<CreateCartInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id } = invocation.context;
    const input = invocation.input;

    const inputRecord = input as unknown as Record<string, unknown>;
    const effect_key = invocation.context?.effect_key ?? (typeof inputRecord['effect_key'] === 'string' ? inputRecord['effect_key'] : undefined);
    if (!effect_key || typeof effect_key !== 'string' || effect_key.trim().length === 0) {
      throw new SalesSkillToolError(
        'EFFECT_KEY_REQUIRED',
        'Cryptographic effect key is required for cart creation',
      );
    }

    if (input.tenant_id !== tenant_id) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Cart request tenant does not match the server-bound tenant',
      );
    }

    const cartPort = options.cart;
    if (!cartPort) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'API-002.CommerceCartAPI port is not bound',
      );
    }

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new SalesSkillToolError('INVALID_INPUT', 'Cart items must not be empty');
    }

    // Stock must be verified before a cart add
    for (const item of input.items) {
      const inventory = await readInventoryFromSor(tenant_id, item.sku_id);
      const available = inventory.item.total_available_to_promise ?? 0;
      if (available < item.quantity) {
        throw new SalesSkillToolError(
          'OUT_OF_STOCK',
          `Insufficient inventory for SKU ${item.sku_id}: requested ${item.quantity}, available ${available}`,
        );
      }
    }

    // A discount-sensitive payload without owner-approved floor provenance refuses P_FLOOR_UNAVAILABLE
    const isDiscountSensitive =
      Boolean(input.offer_id)
      || (typeof input.discount_amount === 'number' && input.discount_amount > 0)
      || (typeof input.discount_percent === 'number' && input.discount_percent > 0);

    if (isDiscountSensitive) {
      const floorPort = options.price_floor;
      if (!floorPort) {
        throw new SalesSkillToolError(
          'P_FLOOR_UNAVAILABLE',
          'Discount-sensitive cart payload requires bound SalesPriceFloorPort',
        );
      }

      for (const item of input.items) {
        let floorDecision: SalesPriceFloorDecision;
        try {
          floorDecision = await floorPort.read({ tenant_id, sku_id: item.sku_id });
        } catch {
          throw new SalesSkillToolError(
            'P_FLOOR_UNAVAILABLE',
            `Failed to read floor decision for discounted SKU ${item.sku_id}`,
          );
        }

        if (
          !floorDecision
          || floorDecision.owner_approved !== true
          || !floorDecision.floor_source
          || typeof floorDecision.floor_source !== 'string'
          || floorDecision.floor_source.trim().length === 0
        ) {
          throw new SalesSkillToolError(
            'P_FLOOR_UNAVAILABLE',
            `Owner-approved floor provenance is unavailable for discounted SKU ${item.sku_id}`,
          );
        }
      }
    }

    const mutateCart = cartPort.createCart ?? cartPort.create ?? cartPort.execute;
    if (typeof mutateCart !== 'function') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Cart port has no callable createCart method',
      );
    }

    let result: unknown;
    try {
      result = await mutateCart.call(cartPort, input);
    } catch (err) {
      if (err instanceof SalesSkillToolError) throw err;
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Commerce cart mutation failed',
      );
    }

    if (!result || typeof result !== 'object') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Commerce cart response is invalid',
      );
    }

    const out = result as Partial<SalesCartOutput>;
    if (
      typeof out.cart_id !== 'string'
      || typeof out.item_count !== 'number'
      || typeof out.subtotal !== 'number'
      || typeof out.currency !== 'string'
      || !isValidIsoDate(out.updated_at)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Commerce cart output failed schema validation',
      );
    }

    return {
      cart_id: out.cart_id,
      item_count: out.item_count,
      subtotal: out.subtotal,
      currency: out.currency,
      updated_at: out.updated_at,
    };
  }

  async function handleCreateOrder(
    invocation: SkillToolInvocation<CreateOrderInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id } = invocation.context;
    const input = invocation.input;

    const effect_key = input.effect_key ?? invocation.context?.effect_key;
    if (!effect_key || typeof effect_key !== 'string' || effect_key.trim().length === 0) {
      throw new SalesSkillToolError(
        'EFFECT_KEY_REQUIRED',
        'Cryptographic effect key is required for order creation',
      );
    }

    if (input.tenant_id !== tenant_id) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Order request tenant does not match the server-bound tenant',
      );
    }

    const orderPort = options.order;
    if (!orderPort) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'API-001.OrderConnector port is not bound',
      );
    }

    const createOrderFn = orderPort.createOrder ?? orderPort.create ?? orderPort.execute;
    if (typeof createOrderFn !== 'function') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Order port has no callable createOrder method',
      );
    }

    // 1. PRE-DISPATCH (the TC-SKILL-14-07 guard, must produce zero ERP calls):
    // 1.1 Verify payment_method is supported for the tenant BEFORE ERP dispatch
    const supportedMethods = await readSupportedPaymentMethods(options, { tenant_id });
    if (!supportedMethods.includes(input.payment_method)) {
      throw new SalesSkillToolError(
        'PAYMENT_METHOD_UNSUPPORTED',
        `Payment method '${input.payment_method}' is not supported for tenant '${tenant_id}'`,
      );
    }

    // 1.2 Read authoritative quote for cart_id BEFORE ERP dispatch (preflight)
    const quote = await readAuthoritativeQuote(options, { tenant_id, cart_id: input.cart_id });

    // Reject any caller-supplied total mismatch early before ERP dispatch
    const callerSuppliedTotal = (input as unknown as Record<string, unknown>)['total_amount'] ?? (input as unknown as Record<string, unknown>)['final_price'];
    if (callerSuppliedTotal !== undefined && callerSuppliedTotal !== quote.total_amount) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        `Caller-supplied total (${String(callerSuppliedTotal)}) differs from authoritative quote (${quote.total_amount} ${quote.currency})`,
      );
    }

    // 1.3 Require and verify genuine server-signed price quote token BEFORE ERP dispatch
    if (!hasQuoteSigningSecret(options)) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Quote signing secret is not bound; cannot verify price quote integrity',
      );
    }

    const inputRecord = input as unknown as Record<string, unknown>;
    const quoteRecord = quote as unknown as Record<string, unknown>;

    const quoteToken = (inputRecord['quote_token'] ?? quoteRecord['quote_token']) as string | undefined;
    if (!quoteToken || typeof quoteToken !== 'string' || quoteToken.trim().length === 0) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price quote token is required for order creation',
      );
    }

    // A valid SHA-256 HMAC digest in hex must be 64 hexadecimal characters
    if (!/^[0-9a-fA-F]{64}$/.test(quoteToken)) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price quote token is malformed',
      );
    }

    const quoteExpiresAt = (inputRecord['quote_expires_at'] ?? quoteRecord['quote_expires_at']) as string | undefined;
    if (!quoteExpiresAt || typeof quoteExpiresAt !== 'string' || !isValidIsoDate(quoteExpiresAt)) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price quote expiration timestamp is missing or malformed',
      );
    }

    const clock = options.now ?? (() => new Date());
    if (new Date(quoteExpiresAt).getTime() <= clock().getTime()) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price quote token has expired',
      );
    }

    const inputItems = Array.isArray(inputRecord['items']) ? (inputRecord['items'] as readonly Record<string, unknown>[]) : undefined;
    const quoteItems = Array.isArray(quoteRecord['items']) ? (quoteRecord['items'] as readonly Record<string, unknown>[]) : undefined;
    const skuId = (inputRecord['sku_id'] ?? quoteRecord['sku_id'] ?? inputItems?.[0]?.['sku_id'] ?? quoteItems?.[0]?.['sku_id']) as string | undefined;
    if (!skuId || typeof skuId !== 'string' || skuId.trim().length === 0) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'SKU identity for price quote verification is missing',
      );
    }

    const customerId = (inputRecord['customer_id'] ?? quoteRecord['customer_id']) as string | undefined;
    if (!customerId || typeof customerId !== 'string' || customerId.trim().length === 0) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Customer identity for price quote verification is missing',
      );
    }

    const pFloor = (inputRecord['p_floor'] ?? quoteRecord['p_floor'] ?? inputItems?.[0]?.['p_floor'] ?? quoteItems?.[0]?.['p_floor']) as number | undefined;
    if (typeof pFloor !== 'number' || !Number.isFinite(pFloor) || pFloor < 0) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price floor for quote verification is missing or invalid',
      );
    }

    const finalPrice = quote.total_amount;
    const currency = quote.currency;

    const expectedToken = computeQuoteToken(options.quote_signing_secret!, {
      tenant_id,
      sku_id: skuId,
      customer_id: customerId,
      final_price: finalPrice,
      p_floor: pFloor,
      currency,
      quote_expires_at: quoteExpiresAt,
    });

    if (!timingSafeCompare(quoteToken, expectedToken)) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        'Price quote token signature verification failed',
      );
    }

    // 2. Dispatch to ERP order connector
    let result: unknown;
    try {
      result = await createOrderFn.call(orderPort, input);
    } catch (err) {
      if (err instanceof SalesSkillToolError) throw err;
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Order creation connector failed',
      );
    }

    if (!result || typeof result !== 'object') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Order connector response is invalid',
      );
    }

    const out = result as Partial<SalesOrderOutput>;
    if (
      typeof out.order_id !== 'string'
      || typeof out.order_number !== 'string'
      || typeof out.total_amount !== 'number'
      || typeof out.currency !== 'string'
      || typeof out.status !== 'string'
      || !isValidIsoDate(out.created_at)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Order connector output failed schema validation',
      );
    }

    // 3. POST-DISPATCH (integrity/reconciliation, secondary defence in depth):
    // Verify returned total_amount and currency against the authoritative quote
    if (out.total_amount !== quote.total_amount || out.currency !== quote.currency) {
      throw new SalesSkillToolError(
        'PRICE_MISMATCH',
        `Order total (${out.total_amount} ${out.currency}) does not match authoritative quote (${quote.total_amount} ${quote.currency})`,
      );
    }
    return {
      order_id: out.order_id,
      order_number: out.order_number,
      total_amount: out.total_amount,
      currency: out.currency,
      status: out.status,
      ...(out.payment_url ? { payment_url: out.payment_url } : {}),
      created_at: out.created_at,
    };
  }

  async function handleSendMessage(
    invocation: SkillToolInvocation<SendMessageInput>,
  ): Promise<Record<string, unknown>> {
    const { tenant_id, correlation_id } = invocation.context;
    const input = invocation.input;

    const effect_key = input.effect_key ?? invocation.context?.effect_key;
    if (!effect_key || typeof effect_key !== 'string' || effect_key.trim().length === 0) {
      throw new SalesSkillToolError(
        'EFFECT_KEY_REQUIRED',
        'Cryptographic effect key is required for sending outbound messages',
      );
    }

    if (input.tenant_id !== tenant_id) {
      throw new SalesSkillToolError(
        'IDENTITY_UNVERIFIED',
        'Message request tenant does not match the server-bound tenant',
      );
    }

    const commPort = options.communication;
    if (!commPort) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'API-003.CommunicationConnector is not bound',
      );
    }

    // Enforce in strict order:
    // 1. Channel-specific consent (refuse CONSENT_REQUIRED)
    const consentPort = options.consent;
    if (!consentPort) {
      throw new SalesSkillToolError(
        'CONSENT_REQUIRED',
        'Channel-specific consent verification port is not bound',
      );
    }

    let consentResult: SalesConsentDecision;
    try {
      consentResult = await consentPort.read({
        tenant_id,
        customer_id: input.recipient_id,
        channel: input.channel,
      });
    } catch {
      throw new SalesSkillToolError(
        'CONSENT_REQUIRED',
        `Failed to verify consent for recipient ${input.recipient_id} on channel ${input.channel}`,
      );
    }

    if (!consentResult || !consentResult.consented) {
      throw new SalesSkillToolError(
        'CONSENT_REQUIRED',
        consentResult?.reason ?? `Recipient ${input.recipient_id} has not consented to communication on ${input.channel}`,
      );
    }

    // 2. Suppression (refuse CONSENT_REQUIRED carrying the suppression reason)
    if (consentResult.suppressed) {
      throw new SalesSkillToolError(
        'CONSENT_REQUIRED',
        consentResult.reason ?? `Communication to recipient ${input.recipient_id} on channel ${input.channel} is suppressed`,
      );
    }

    // 3. Human takeover (refuse HUMAN_TAKEOVER)
    let takeoverActive: boolean;
    if (typeof options.takeover_active === 'boolean') {
      takeoverActive = options.takeover_active;
    } else if (options.context && typeof options.context.takeoverActiveFor === 'function') {
      try {
        takeoverActive = Boolean(await options.context.takeoverActiveFor(tenant_id, correlation_id));
      } catch {
        takeoverActive = true;
      }
    } else if (typeof options.is_takeover_active === 'function') {
      try {
        takeoverActive = Boolean(await options.is_takeover_active(tenant_id, correlation_id));
      } catch {
        takeoverActive = true;
      }
    } else {
      throw new SalesSkillToolError(
        'HUMAN_TAKEOVER',
        'Takeover authority is unbound; refusing autonomous message dispatch.',
      );
    }
    if (takeoverActive) {
      throw new SalesSkillToolError(
        'HUMAN_TAKEOVER',
        'Human operator holds active session lock; autonomous actions denied.',
      );
    }

    // 4. Tenant frequency cap. When no cap configuration is bound, refuse with FREQUENCY_CAP_UNAVAILABLE - never substitute a platform constant.
    const freqCapPort = options.frequency_cap;
    if (!freqCapPort) {
      throw new SalesSkillToolError(
        'FREQUENCY_CAP_UNAVAILABLE',
        'No frequency cap configuration port is bound; platform default is prohibited',
      );
    }

    const readCap = freqCapPort.read ?? freqCapPort.getReminderCap;
    if (typeof readCap !== 'function') {
      throw new SalesSkillToolError(
        'FREQUENCY_CAP_UNAVAILABLE',
        'Frequency cap port has no callable read method',
      );
    }

    let capResult: unknown;
    try {
      capResult = await readCap.call(freqCapPort, {
        tenant_id,
        recipient_id: input.recipient_id,
        customer_id: input.recipient_id,
        channel: input.channel,
      });
    } catch {
      throw new SalesSkillToolError(
        'FREQUENCY_CAP_UNAVAILABLE',
        'Failed to read tenant frequency cap configuration',
      );
    }

    if (capResult === undefined || capResult === null) {
      throw new SalesSkillToolError(
        'FREQUENCY_CAP_UNAVAILABLE',
        'Tenant has no configured reminder frequency cap; refusing autonomous message dispatch',
      );
    }

    if (typeof capResult === 'number' && capResult <= 0) {
      throw new SalesSkillToolError(
        'FREQUENCY_CAP_EXCEEDED',
        'Tenant reminder frequency cap has been exceeded',
      );
    }

    if (typeof capResult === 'object' && capResult !== null) {
      const capObj = capResult as Record<string, unknown>;
      if (capObj.allowed === false || (typeof capObj.remaining === 'number' && capObj.remaining <= 0)) {
        throw new SalesSkillToolError(
          'FREQUENCY_CAP_EXCEEDED',
          'Tenant reminder frequency cap has been exceeded',
        );
      }
    }

    // Dispatch message to communication connector
    const sendMessageFn = commPort.sendMessage ?? commPort.send ?? commPort.execute;
    if (typeof sendMessageFn !== 'function') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Communication port has no callable sendMessage method',
      );
    }

    let result: unknown;
    try {
      result = await sendMessageFn.call(commPort, input);
    } catch (err) {
      if (err instanceof SalesSkillToolError) throw err;
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Communication connector send failed',
      );
    }

    if (!result || typeof result !== 'object') {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Communication connector response is invalid',
      );
    }

    const out = result as Partial<SalesCommunicationOutput>;
    if (
      typeof out.message_id !== 'string'
      || typeof out.provider_reference !== 'string'
      || !isValidIsoDate(out.delivered_at)
    ) {
      throw new SalesSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Communication connector output failed schema validation',
      );
    }

    return {
      message_id: out.message_id,
      provider_reference: out.provider_reference,
      delivered_at: out.delivered_at,
    };
  }

  return {
    async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      if (
        invocation.skill_id === 'skill.sales.search_product'
        && invocation.tool_binding === 'API-001.CatalogConnector'
      ) {
        return await handleSearchProduct(
          invocation as unknown as SkillToolInvocation<SearchProductInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.check_stock'
        && invocation.tool_binding === 'API-001.InventoryConnector'
      ) {
        return await handleCheckStock(
          invocation as unknown as SkillToolInvocation<CheckStockInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.retrieve_customer'
        && invocation.tool_binding === 'PostgreSQL.Customer360Store'
      ) {
        return await handleRetrieveCustomer(
          invocation as unknown as SkillToolInvocation<RetrieveCustomerInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.recommend_product'
        && invocation.tool_binding === 'Core.RecommendationEngine'
      ) {
        return await handleRecommendProduct(
          invocation as unknown as SkillToolInvocation<RecommendProductInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.check_price'
        && invocation.tool_binding === 'API-001.PricingEngine'
      ) {
        return await handleCheckPrice(
          invocation as unknown as SkillToolInvocation<CheckPriceInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.create_cart'
        && invocation.tool_binding === 'API-002.CommerceCartAPI'
      ) {
        return await handleCreateCart(
          invocation as unknown as SkillToolInvocation<CreateCartInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.create_order'
        && invocation.tool_binding === 'API-001.OrderConnector'
      ) {
        return await handleCreateOrder(
          invocation as unknown as SkillToolInvocation<CreateOrderInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.send_message'
        && invocation.tool_binding === 'API-003.CommunicationConnector'
      ) {
        return await handleSendMessage(
          invocation as unknown as SkillToolInvocation<SendMessageInput>,
        ) as TOutput;
      }

      throw new SalesSkillToolError(
        'UNKNOWN_CAPABILITY',
        `Sales tool binding is not enabled for ${invocation.skill_id}`,
      );
    },
  };
}

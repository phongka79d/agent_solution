import type { Customer360Fact } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';

export interface SalesContextAggregatorLike {
  verifiedCustomerFor(
    tenant_id: string,
    correlation_id: string,
  ): Customer360Fact | Promise<Customer360Fact | null> | null;
  verifiedTimelineFor(
    tenant_id: string,
    correlation_id: string,
  ): CustomerEventTimeline | Promise<CustomerEventTimeline | null> | null;
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
  readonly context: Pick<SalesContextAggregatorLike, 'verifiedCustomerFor' | 'verifiedTimelineFor'>;
  /** Owner-approved revenue evidence source; absent means recommendation execution refuses. */
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort;
  /** Retained as an injection seam for callers; this port never invents provider timestamps. */
  readonly now?: () => Date;
}

export class SalesSkillToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SalesSkillToolError';
    this.code = code;
  }
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

    return {
      customer_id: customer.customer_id,
      total_orders: customer.order_count,
      lifetime_value: customer.total_spent,
      verified: true,
      rfm_segment: customer.rfm_segment_hypothesis,
      last_order_date: null,
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

      throw new SalesSkillToolError(
        'UNKNOWN_CAPABILITY',
        `Sales tool binding is not enabled for ${invocation.skill_id}`,
      );
    },
  };
}

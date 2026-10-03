import type { ErpCartTransportResult, ErpReadPort } from '../connectors.js';
import { isValidIsoDate } from './skills/sor-readers.js';
import { computeQuoteToken, SalesSkillToolError } from './skills/quote-payment-guards.js';
import type {
  SalesCartInput,
  SalesCartOutput,
  SalesCartPort,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
  SalesQuote,
  SalesQuoteQuery,
} from './skills/types.js';

const CART_CREATE_PATH = '/api/v1/carts';

export interface ErpSalesCartPortOptions {
  readonly price_floor?: SalesPriceFloorPort | null | undefined;
  readonly quote_signing_secret?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

/** Binds cart creation and quote reads to the tenant's authenticated ERP transport. */
export function createErpSalesCartPort(
  erp: ErpReadPort | null | undefined,
  options: ErpSalesCartPortOptions = {},
): SalesCartPort | null {
  const transport = erp?.cart_transport;
  if (transport === undefined) return null;
  const now = options.now ?? (() => new Date());

  return {
    async createCart(input: SalesCartInput): Promise<SalesCartOutput> {
      if (
        input.tenant_id.trim().length === 0
        || input.session_id.trim().length === 0
        || input.idempotency_key.trim().length === 0
        || input.items.length === 0
        || input.items.some((item) => !item.sku_id.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
      ) {
        throw new SalesSkillToolError('INVALID_INPUT', 'Cart requires a tenant, session, idempotency key, and valid SKU quantities');
      }
      if (
        (typeof input.offer_id === 'string' && input.offer_id.trim().length > 0)
        || (typeof input.discount_amount === 'number' && input.discount_amount > 0)
        || (typeof input.discount_percent === 'number' && input.discount_percent > 0)
      ) {
        throw new SalesSkillToolError('P_FLOOR_UNAVAILABLE', 'The ERP cart connector does not support promotional discounts');
      }

      const body: Record<string, unknown> = {
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        ...(input.customer_id === undefined ? {} : { customer_id: input.customer_id }),
        items: input.items.map(({ sku_id, quantity }) => ({ sku_id, quantity })),
      };
      const result = await transport.request({
        method: 'POST',
        path: CART_CREATE_PATH,
        tenant_id: input.tenant_id,
        idempotency_key: input.idempotency_key,
        body,
      });
      const output = requireBody(result, 'cart creation');
      const cart = readCartOutput(output);
      if (cart === null) {
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'ERP cart response failed schema validation');
      }
      return cart;
    },

    async readCart(query: SalesQuoteQuery): Promise<SalesQuote> {
      if (query.tenant_id.trim().length === 0 || query.cart_id.trim().length === 0) {
        throw new SalesSkillToolError('INVALID_INPUT', 'Cart quote requires a tenant and cart id');
      }
      const result = await transport.request({
        method: 'GET',
        path: `${CART_CREATE_PATH}/${encodeURIComponent(query.cart_id)}`,
        tenant_id: query.tenant_id,
      });
      const body = requireBody(result, 'cart quote read');
      const cart = readCartQuote(body, query);
      if (cart === null) {
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'ERP cart quote response failed schema validation');
      }
      if (cart.items.length !== 1) {
        throw new SalesSkillToolError('PRICE_MISMATCH', 'Order quotes must contain exactly one server-priced cart line');
      }
      const line = cart.items[0];
      if (line === undefined) {
        throw new SalesSkillToolError('PRICE_MISMATCH', 'ERP cart quote contains no priced line');
      }
      const priceFloor = options.price_floor;
      if (priceFloor === undefined || priceFloor === null) {
        throw new SalesSkillToolError('P_FLOOR_UNAVAILABLE', 'The ERP price floor connector is not bound');
      }

      let decision: SalesPriceFloorDecision;
      try {
        decision = await priceFloor.read({ tenant_id: query.tenant_id, sku_id: line.sku_id });
      } catch {
        throw new SalesSkillToolError('P_FLOOR_UNAVAILABLE', 'The authoritative price floor could not be read');
      }
      if (
        decision.owner_approved !== true
        || decision.list_price !== line.unit_price
        || decision.currency !== cart.currency
        || typeof decision.p_floor !== 'number'
        || !Number.isFinite(decision.p_floor)
        || decision.p_floor < 0
        || decision.p_floor > decision.list_price
        || typeof decision.quote_ttl_seconds !== 'number'
        || !Number.isFinite(decision.quote_ttl_seconds)
        || decision.quote_ttl_seconds <= 0
      ) {
        throw new SalesSkillToolError('PRICE_MISMATCH', 'ERP cart pricing differs from the owner-approved price floor');
      }

      const quote_expires_at = new Date(now().getTime() + decision.quote_ttl_seconds * 1000).toISOString();
      const quote_token = options.quote_signing_secret?.trim()
        ? computeQuoteToken(options.quote_signing_secret, {
            tenant_id: query.tenant_id,
            sku_id: line.sku_id,
            customer_id: cart.customer_id,
            final_price: cart.total_amount,
            p_floor: decision.p_floor,
            currency: cart.currency,
            quote_expires_at,
          })
        : undefined;
      return {
        cart_id: cart.cart_id,
        total_amount: cart.total_amount,
        subtotal: cart.subtotal,
        currency: cart.currency,
        customer_id: cart.customer_id,
        sku_id: line.sku_id,
        p_floor: decision.p_floor,
        items: [{ sku_id: line.sku_id, quantity: line.quantity }],
        quote_expires_at,
        ...(quote_token === undefined ? {} : { quote_token }),
      };
    },
  };
}

function requireBody(
  result: ErpCartTransportResult,
  operation: string,
): Record<string, unknown> {
  if (!result.ok) {
    const code = result.failure_class === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : 'PROVIDER_INDETERMINATE';
    throw new SalesSkillToolError(code, `ERP ${operation} outcome is unconfirmed (${result.failure_class})`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new SalesSkillToolError('PROVIDER_REJECTED', `ERP ${operation} was rejected with status ${result.status}`);
  }
  return result.body;
}

function readCartOutput(value: Record<string, unknown>): SalesCartOutput | null {
  const { cart_id, item_count, subtotal, currency, updated_at } = value;
  if (
    typeof cart_id !== 'string'
    || cart_id.trim().length === 0
    || typeof item_count !== 'number'
    || !Number.isSafeInteger(item_count)
    || typeof subtotal !== 'number'
    || !Number.isFinite(subtotal)
    || typeof currency !== 'string'
    || currency.trim().length === 0
    || !isValidIsoDate(updated_at)
  ) {
    return null;
  }
  return { cart_id, item_count, subtotal, currency, updated_at };
}

function readCartQuote(value: Record<string, unknown>, query: SalesQuoteQuery): CartQuote | null {
  if (
    value.cart_id !== query.cart_id
    || value.tenant_id !== query.tenant_id
    || typeof value.customer_id !== 'string'
    || value.customer_id.trim().length === 0
    || typeof value.currency !== 'string'
    || typeof value.item_count !== 'number'
    || !Number.isSafeInteger(value.item_count)
    || typeof value.subtotal !== 'number'
    || !Number.isFinite(value.subtotal)
    || typeof value.total_amount !== 'number'
    || !Number.isFinite(value.total_amount)
    || !Array.isArray(value.items)
  ) {
    return null;
  }
  const items = value.items.map(readCartLine);
  if (items.some((item) => item === null)) return null;
  const lines = items.filter((item): item is CartLine => item !== null);
  const amount = lines.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const count = lines.reduce((sum, item) => sum + item.quantity, 0);
  if (
    !Number.isSafeInteger(count)
    || count !== value.item_count
    || amount !== value.subtotal
    || amount !== value.total_amount
    || lines.some((item) => item.currency !== value.currency)
  ) {
    return null;
  }
  return {
    cart_id: value.cart_id,
    customer_id: value.customer_id,
    items: lines,
    item_count: value.item_count,
    subtotal: value.subtotal,
    total_amount: value.total_amount,
    currency: value.currency,
  };
}

interface CartLine {
  readonly sku_id: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly currency: string;
}

interface CartQuote {
  readonly cart_id: string;
  readonly customer_id: string;
  readonly items: readonly CartLine[];
  readonly item_count: number;
  readonly subtotal: number;
  readonly total_amount: number;
  readonly currency: string;
}

function readCartLine(value: unknown): CartLine | null {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !('sku_id' in value)
    || !('quantity' in value)
    || !('unit_price' in value)
    || !('currency' in value)
  ) {
    return null;
  }
  const { sku_id, quantity, unit_price, currency } = value;
  if (
    typeof sku_id !== 'string'
    || sku_id.trim().length === 0
    || typeof quantity !== 'number'
    || !Number.isSafeInteger(quantity)
    || quantity < 1
    || typeof unit_price !== 'number'
    || !Number.isFinite(unit_price)
    || unit_price < 0
    || typeof currency !== 'string'
    || currency.trim().length === 0
  ) {
    return null;
  }
  return { sku_id, quantity, unit_price, currency };
}

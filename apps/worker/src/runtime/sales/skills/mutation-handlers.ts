import type { SkillToolInvocation } from '@agentos/skills';
import type {
  SalesCartInput,
  SalesCartOutput,
  SalesCommunicationInput,
  SalesCommunicationOutput,
  SalesConsentDecision,
  SalesOrderInput,
  SalesOrderOutput,
  SalesPriceFloorDecision,
} from './types.js';
import type { SalesSkillToolPortOptions } from './tool-port.js';
import {
  computeQuoteToken,
  hasQuoteSigningSecret,
  readAuthoritativeQuote,
  readSupportedPaymentMethods,
  SalesSkillToolError,
  timingSafeCompare,
} from './quote-payment-guards.js';
import { isValidIsoDate, readInventoryFromSor } from './sor-readers.js';

type CreateCartInput = SalesCartInput;
type CreateOrderInput = SalesOrderInput;
type SendMessageInput = SalesCommunicationInput;

function resolveServerEffectKey(
  input: unknown,
  serverEffectKey: string | undefined,
  operation: string,
): string {
  if (typeof serverEffectKey !== 'string' || serverEffectKey.trim().length === 0) {
    throw new SalesSkillToolError(
      'EFFECT_KEY_REQUIRED',
      `Cryptographic effect key is required for ${operation}`,
    );
  }
  const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (Object.hasOwn(inputRecord, 'effect_key') && inputRecord.effect_key !== serverEffectKey) {
    throw new SalesSkillToolError(
      'EFFECT_KEY_MISMATCH',
      `Caller-supplied effect key does not match the server-derived effect key for ${operation}`,
    );
  }
  return serverEffectKey;
}

export async function handleCreateCart(
  options: SalesSkillToolPortOptions,
  invocation: SkillToolInvocation<CreateCartInput>,
): Promise<Record<string, unknown>> {
  const { tenant_id } = invocation.context;
  const input = invocation.input;

  resolveServerEffectKey(input, invocation.context.effect_key, 'cart creation');

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
    if (
      !item
      || typeof item.sku_id !== 'string'
      || item.sku_id.trim().length === 0
      || typeof item.quantity !== 'number'
      || !Number.isInteger(item.quantity)
      || item.quantity <= 0
    ) {
      throw new SalesSkillToolError('INVALID_INPUT', 'Cart items must have a valid sku_id and positive integer quantity');
    }
    const inventory = await readInventoryFromSor(options, tenant_id, item.sku_id);
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

export async function handleCreateOrder(
  options: SalesSkillToolPortOptions,
  invocation: SkillToolInvocation<CreateOrderInput>,
): Promise<Record<string, unknown>> {
  const { tenant_id } = invocation.context;
  const input = invocation.input;

  const effect_key = resolveServerEffectKey(input, invocation.context.effect_key, 'order creation');

  if (input.tenant_id !== tenant_id) {
    throw new SalesSkillToolError(
      'IDENTITY_UNVERIFIED',
      'Order request tenant does not match the server-bound tenant',
    );
  }

  if (typeof input.cart_id !== 'string' || input.cart_id.trim().length === 0) {
    throw new SalesSkillToolError('INVALID_INPUT', 'Order request cart_id must be a non-empty string');
  }
  if (typeof input.payment_method !== 'string' || input.payment_method.trim().length === 0) {
    throw new SalesSkillToolError('INVALID_INPUT', 'Order request payment_method must be a non-empty string');
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

  // 2. Dispatch using only the server-derived effect identity.
  const authoritativeInput: SalesOrderInput = { ...input, effect_key };
  let result: unknown;
  try {
    result = await createOrderFn.call(orderPort, authoritativeInput);
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

export async function handleSendMessage(
  options: SalesSkillToolPortOptions,
  invocation: SkillToolInvocation<SendMessageInput>,
): Promise<Record<string, unknown>> {
  const { tenant_id, correlation_id } = invocation.context;
  const input = invocation.input;

  const effect_key = resolveServerEffectKey(input, invocation.context.effect_key, 'sending outbound messages');

  if (input.tenant_id !== tenant_id) {
    throw new SalesSkillToolError(
      'IDENTITY_UNVERIFIED',
      'Message request tenant does not match the server-bound tenant',
    );
  }

  if (
    typeof input.recipient_id !== 'string'
    || input.recipient_id.trim().length === 0
    || typeof input.channel !== 'string'
    || input.channel.trim().length === 0
    || !input.message_content
    || typeof input.message_content !== 'object'
    || typeof input.message_content.text !== 'string'
    || input.message_content.text.trim().length === 0
  ) {
    throw new SalesSkillToolError(
      'INVALID_INPUT',
      'Message recipient, channel, and non-empty content are required',
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

  const authoritativeInput: SalesCommunicationInput = { ...input, effect_key };
  let result: unknown;
  try {
    result = await sendMessageFn.call(commPort, authoritativeInput);
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

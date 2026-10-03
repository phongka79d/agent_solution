import {
  renderResponseTemplate,
  RESPONSE_KINDS,
  TEMPLATE_KEYS,
  TEMPLATE_SOURCE,
  type ResponseKind,
  type TemplateKey,
} from '@agentos/core-engine';
import { RunResponseRepository, type RunResponseRecord } from '@agentos/database';
import {
  OrchestratorError,
  type ExecutionReceipt,
  type FinalResponse,
  type IResponseFinalizer,
  type IRunResponseStore,
  type ResponseFinalizationInput,
  type ResponseOutcome,
  type RunResponseSource,
  type VerifiedStepReceipt,
} from '@agentos/core-engine/contracts';
import { computeQuoteToken, timingSafeCompare } from '../sales/skills/quote-payment-guards.js';

/** A domain that is allowed to expose a terminal response to a caller. */
export type ResponseDomain = 'support' | 'sales' | 'marketing';

const FAQ_SOURCE_FILE = 'customer-care/faq';
const FAQ_SOURCE_PREFIX = 'customer-care/';
const ORDER_SOURCE_FILE = 'API-001.OrderConnector';
const QUOTE_SOURCE_FILE = 'API-001.PricingEngine';
const INVENTORY_SOURCE_FILE = 'API-001.InventoryConnector';
const CATALOG_SOURCE_FILE = 'API-001.CatalogConnector';
const RECOMMENDATION_SOURCE_FILE = 'Core.RecommendationEngine';
const DRAFT_SOURCE_FILE = 'Marketing.DraftReceipt';
const SHA256 = /^[a-f0-9]{64}$/i;
const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Đang chờ xử lý',
  PROCESSING: 'Đang xử lý',
  SHIPPED: 'Đã gửi hàng',
  DELIVERED: 'Đã giao hàng',
  CANCELLED: 'Đã hủy',
  RETURNED: 'Đã hoàn trả',
};
const TEMPLATE_RESPONSE_KINDS: readonly ResponseKind[] = ['CLARIFICATION', 'REFUSAL', 'NO_ANSWER', 'HANDOFF_ACK'];
const EVIDENCE_SOURCE = 'Core.Evidence@1';
const RESPONSE_OUTCOME_BY_KIND: Record<ResponseKind, ResponseOutcome> = {
  ANSWER: 'ANSWERED',
  CLARIFICATION: 'CLARIFIED',
  REFUSAL: 'REFUSED',
  NO_ANSWER: 'NO_ANSWER',
  HANDOFF_ACK: 'HANDOFF_ACK',
};

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeRenderedText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

/**
 * Reads the cart total only from a verified cart receipt. A cart row must carry its cart identity
 * and a finite subtotal/total_amount; malformed or ambiguous cart evidence is not usable.
 */
function readCartTotal(
  receipts: readonly VerifiedStepReceipt[],
  cartId: string | undefined,
): number | null | undefined {
  const cartRows = receipts
    .map((item) => item.receipt.response_payload)
    .filter((payload) => nonEmpty(payload['cart_id']) !== undefined)
    .filter((payload) => cartId === undefined || nonEmpty(payload['cart_id']) === cartId);
  if (cartRows.length === 0) return undefined;
  if (cartRows.length !== 1) return null;
  const total = cartRows[0]!['total_amount'] ?? cartRows[0]!['subtotal'];
  return finiteNumber(total) && total >= 0 ? total : null;
}

function hasValidQuoteSignature(
  input: ResponseFinalizationInput,
  payload: Record<string, unknown>,
  token: string,
  finalPrice: number,
  floor: number,
  currency: string,
  expiry: string,
  quoteSigningSecret: string | undefined,
): boolean {
  const payloadCustomerId = nonEmpty(payload['customer_id']);
  const customerId = payloadCustomerId ?? input.context.customer?.customer_id;
  if (
    quoteSigningSecret === undefined
    || quoteSigningSecret.trim().length === 0
    || customerId === undefined
    || (payloadCustomerId !== undefined && payloadCustomerId !== input.context.customer?.customer_id)
    || !/^[a-f0-9]{64}$/i.test(token)
  ) return false;
  const expected = computeQuoteToken(quoteSigningSecret, {
    tenant_id: input.tenant_id,
    sku_id: nonEmpty(payload['sku_id']) ?? '',
    customer_id: customerId,
    final_price: finalPrice,
    p_floor: floor,
    currency,
    quote_expires_at: expiry,
  });
  return timingSafeCompare(token, expected);
}

function refusal(code: string, message: string): never {
  throw new OrchestratorError(code, message);
}

function payloadSource(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload['source']) ?? record(payload['source_metadata']) ?? {};
}

function sourceFile(payload: Record<string, unknown>, fallback?: string): string | undefined {
  const metadata = payloadSource(payload);
  return nonEmpty(payload['source_file'])
    ?? nonEmpty(payload['source_uri'])
    ?? nonEmpty(metadata['source_file'])
    ?? nonEmpty(metadata['file'])
    ?? fallback;
}

function sourceVersion(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt['evidence'],
): string {
  const metadata = payloadSource(payload);
  const version = nonEmpty(payload['source_version'])
    ?? nonEmpty(payload['approved_version'])
    ?? nonEmpty(payload['record_version'])
    ?? nonEmpty(payload['version'])
    ?? nonEmpty(metadata['source_version'])
    ?? nonEmpty(metadata['version']);
  // The immutable evidence payload digest is the trusted version when the connector did not expose
  // its own approved version. Never use a caller/model-provided arbitrary fallback.
  if (version !== undefined) return version;
  if (SHA256.test(evidence.payload_sha256)) return evidence.payload_sha256;
  refusal('RESPONSE_SOURCE_UNVERSIONED', 'Successful response evidence has no trusted source version.');
}

function sourceRecordId(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt['evidence'],
): string {
  const metadata = payloadSource(payload);
  const id = nonEmpty(payload['source_record_id'])
    ?? nonEmpty(payload['record_id'])
    ?? nonEmpty(metadata['source_record_id'])
    ?? nonEmpty(metadata['record_id'])
    ?? nonEmpty(payload['faq_id'])
    ?? nonEmpty(payload['order_id'])
    ?? nonEmpty(payload['draft_id'])
    ?? nonEmpty(payload['sku_id']);
  return id ?? evidence.evidence_id;
}

function citation(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt['evidence'],
  fallbackFile: string,
): RunResponseSource {
  const file = sourceFile(payload, fallbackFile);
  if (file === undefined) refusal('RESPONSE_SOURCE_UNIDENTIFIED', 'Successful response evidence has no source file.');
  return {
    source_record_id: sourceRecordId(payload, evidence),
    source_version: sourceVersion(payload, evidence),
    source_file: file,
  };
}

function canonicalReceiptShape(receipt: ExecutionReceipt): boolean {
  return receipt.adapter_status === 'SUCCESS'
    && record(receipt.response_payload) !== null
    && typeof receipt.execution_id === 'string'
    && receipt.execution_id.trim().length > 0;
}

function sameReceipt(left: ExecutionReceipt, right: ExecutionReceipt): boolean {
  return left.execution_id === right.execution_id
    && left.adapter_status === right.adapter_status
    && left.provider_reference === right.provider_reference
    && JSON.stringify(left.response_payload) === JSON.stringify(right.response_payload);
}

function assertTrustedContext(input: ResponseFinalizationInput): void {
  if (!['support', 'sales', 'marketing'].includes(input.domain)) {
    refusal('RESPONSE_DOMAIN_UNSUPPORTED', `Unsupported response domain '${input.domain}'.`);
  }
  if (typeof input.tenant_id !== 'string' || input.tenant_id.trim().length === 0) {
    refusal('RESPONSE_TENANT_REQUIRED', 'Response finalization requires a tenant-bound context.');
  }
  if (input.context.tenant_id !== input.tenant_id) {
    refusal('RESPONSE_TENANT_MISMATCH', 'Response context is not bound to the requested tenant.');
  }
}

function assertTrustedInput(input: ResponseFinalizationInput): readonly VerifiedStepReceipt[] {
  assertTrustedContext(input);
  if (input.successful_receipts.length === 0) {
    refusal('RESPONSE_EVIDENCE_MISSING', 'A response requires at least one successful immutable receipt.');
  }

  for (const verified of input.successful_receipts) {
    const evidence = verified.evidence;
    if (
      evidence.tenant_id !== input.tenant_id
      || evidence.run_id !== input.run_id
      || nonEmpty(evidence.evidence_id) === undefined
      || nonEmpty(evidence.effect_key) === undefined
      || !SHA256.test(evidence.payload_sha256)
      || evidence.receipt === undefined
    ) {
      refusal('RESPONSE_EVIDENCE_INVALID', 'Response evidence is not tenant/run bound, immutable, or receipt-backed.');
    }
    if (!canonicalReceiptShape(verified.receipt) || !sameReceipt(evidence.receipt, verified.receipt)) {
      refusal('RESPONSE_EVIDENCE_INVALID', 'Response receipt is not a successful projection of immutable evidence.');
    }
  }
  return input.successful_receipts;
}

function templateResponse(
  response_kind: Exclude<ResponseKind, 'ANSWER'>,
  template_key: Parameters<typeof renderResponseTemplate>[0],
  reason_code: string,
): FinalResponse {
  const rendered = renderResponseTemplate(template_key);
  return {
    response_kind,
    text: rendered.text,
    source: TEMPLATE_SOURCE,
    template_key: rendered.template_key,
    reason_code,
    sources: [],
  };
}

function assertTemplateResponse(response: FinalResponse): FinalResponse {
  const sources = response.sources ?? [];
  if (
    response.response_kind === 'ANSWER'
    || !TEMPLATE_RESPONSE_KINDS.includes(response.response_kind)
    || response.source !== TEMPLATE_SOURCE
    || response.template_key === undefined
    || !Array.isArray(sources)
    || sources.length !== 0
  ) {
    refusal('RESPONSE_TEMPLATE_INVALID', 'Template response is not an allowlisted non-answer terminal reply.');
  }
  const rendered = renderResponseTemplate(response.template_key);
  if (response.text !== rendered.text || response.source !== rendered.source) {
    refusal('RESPONSE_TEMPLATE_INVALID', 'Template response text does not match its approved template.');
  }
  return { ...response, sources };
}

function structuredText(payload: Record<string, unknown>): string | undefined {
  return nonEmpty(payload['answer']) ?? nonEmpty(payload['reply_text']);
}

function finalResponse(answer: string, sources: readonly RunResponseSource[]): FinalResponse {
  if (answer.trim().length === 0 || sources.length === 0) {
    refusal('RESPONSE_UNGROUNDED', 'A response cannot be exposed without grounded text and a source citation.');
  }
  return {
    response_kind: 'ANSWER',
    text: answer,
    source: EVIDENCE_SOURCE,
    sources,
  };
}

function finalizerRefusal(domain: ResponseDomain): never {
  refusal(
    'RESPONSE_UNGROUNDED',
    `No grounded ${domain} response was present in the successful immutable receipts; refusing to invent fallback text.`,
  );
}

function faqResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
): FinalResponse | undefined {
  const answers = payload['answers'];
  if (!Array.isArray(answers) || answers.length === 0) return undefined;
  const top = record(answers[0]);
  if (top === null) return undefined;
  const answer = nonEmpty(top['approved_answer']) ?? nonEmpty(top['answer']);
  const file = nonEmpty(top['source_file']) ?? sourceFile(payload);
  if (
    answer === undefined
    || file === undefined
    || !file.startsWith(FAQ_SOURCE_PREFIX)
    || file.length <= FAQ_SOURCE_PREFIX.length
    || !SHA256.test(String(payload['source_version'] ?? ''))
  ) return undefined;
  const faqId = nonEmpty(top['faq_id']);
  const enriched = {
    ...payload,
    source_file: file,
    ...(faqId === undefined ? {} : { faq_id: faqId }),
  };
  return finalResponse(answer, [citation(enriched, evidence.evidence, FAQ_SOURCE_FILE)]);
}
function faqNoAnswerResponse(payload: Record<string, unknown>): FinalResponse | undefined {
  if (
    !Array.isArray(payload['answers'])
    || payload['answers'].length !== 0
    || payload['match_confidence'] !== 0
    || !SHA256.test(String(payload['source_version'] ?? ''))
  ) {
    return undefined;
  }
  return templateResponse('NO_ANSWER', 'care.faq_no_answer_offer_handoff', 'CARE_FAQ_NO_ANSWER');
}

function orderNotFoundResponse(
  payload: Record<string, unknown>,
  hasVerifiedCustomer: boolean,
): FinalResponse | undefined {
  if (payload['result'] !== 'ORDER_NOT_FOUND' || !hasVerifiedCustomer) return undefined;
  return templateResponse('NO_ANSWER', 'care.order_not_found', 'ORDER_NOT_FOUND');
}

function orderResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
  hasVerifiedCustomer: boolean,
): FinalResponse | undefined {
  const orderId = nonEmpty(payload['order_id']);
  const status = nonEmpty(payload['status'])?.toUpperCase();
  const customerStatus = status === undefined ? undefined : ORDER_STATUS_LABELS[status];
  if (orderId === undefined || customerStatus === undefined || !hasVerifiedCustomer) return undefined;
  const sourcePayload = sourceFile(payload) === undefined ? { ...payload, source_file: ORDER_SOURCE_FILE } : payload;
  const rendered = renderResponseTemplate('care.order_status', {
    order_id: escapeRenderedText(orderId),
    status: customerStatus,
  });
  return finalResponse(rendered.text, [citation(sourcePayload, evidence.evidence, ORDER_SOURCE_FILE)]);
}

function quoteResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
  input: ResponseFinalizationInput,
  now: () => Date,
  quoteSigningSecret: string | undefined,
  receipts: readonly VerifiedStepReceipt[],
): FinalResponse | undefined {
  const sku = nonEmpty(payload['sku_id']);
  const currency = nonEmpty(payload['currency']);
  const expiry = nonEmpty(payload['quote_expires_at']);
  const token = nonEmpty(payload['quote_token']);
  const finalPrice = payload['final_price'];
  const listPrice = payload['list_price'];
  const floor = payload['p_floor'];
  if (
    sku === undefined
    || currency === undefined
    || expiry === undefined
    || token === undefined
    || !finiteNumber(finalPrice)
    || finalPrice < 0
    || !finiteNumber(listPrice)
    || listPrice < 0
    || !finiteNumber(floor)
    || floor < 0
    || finalPrice < floor
    || finalPrice > listPrice
    || Number.isNaN(Date.parse(expiry))
    || new Date(expiry).getTime() <= now().getTime()
    || !hasValidQuoteSignature(input, payload, token, finalPrice, floor, currency, expiry, quoteSigningSecret)
  ) return undefined;

  const cartId = nonEmpty(payload['cart_id']);
  const cartTotal = readCartTotal(receipts, cartId);
  if (
    (cartId !== undefined && cartTotal === undefined)
    || (cartTotal !== undefined && (cartTotal === null || cartTotal !== finalPrice))
  ) return undefined;

  const sourcePayload = sourceFile(payload) === undefined ? { ...payload, source_file: QUOTE_SOURCE_FILE } : payload;
  return finalResponse(
    `Quote for ${escapeRenderedText(sku)}: ${escapeRenderedText(currency)} ${String(finalPrice)} (valid until ${escapeRenderedText(expiry)}).`,
    [citation(sourcePayload, evidence.evidence, QUOTE_SOURCE_FILE)],
  );
}

/** Validates an unsigned ERP price without downgrading an invalid signed quote. */
function unsignedListPrice(payload: Record<string, unknown>): number | undefined {
  // Never downgrade a malformed, expired or invalid signed quote to an unsigned price.
  if (payload['quote_token'] !== undefined || payload['quote_expires_at'] !== undefined) return undefined;
  const currency = nonEmpty(payload['currency']);
  const listPrice = payload['list_price'];
  const finalPrice = payload['final_price'];
  const floor = payload['p_floor'];
  if (
    currency === undefined
    || !/^[A-Z]{3}$/.test(currency)
    || !finiteNumber(listPrice)
    || listPrice < 0
    || !finiteNumber(finalPrice)
    || !finiteNumber(floor)
    || floor < 0
    || finalPrice < floor
    || finalPrice > listPrice
  ) return undefined;
  return listPrice;
}

/** A read-only ERP list price is not a customer-bound quote and needs no quote token. */
function listPriceResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
): FinalResponse | undefined {
  const sku = nonEmpty(payload['sku_id']);
  const currency = nonEmpty(payload['currency']);
  const listPrice = unsignedListPrice(payload);
  if (sku === undefined || currency === undefined || listPrice === undefined) return undefined;
  const sourcePayload = sourceFile(payload) === undefined ? { ...payload, source_file: QUOTE_SOURCE_FILE } : payload;
  const price = new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(listPrice);
  return finalResponse(
    `Giá niêm yết ERP của ${escapeRenderedText(sku)}: ${price}.`,
    [citation(sourcePayload, evidence.evidence, QUOTE_SOURCE_FILE)],
  );
}

/**
 * Grounded availability answer for `skill.sales.check_stock`: the SKU and quantity are copied from
 * the authoritative inventory receipt, never inferred or re-derived locally.
 */
function stockResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
): FinalResponse | undefined {
  const sku = nonEmpty(payload['sku_id']);
  const available = payload['available_quantity'];
  if (sku === undefined || !finiteNumber(available) || available < 0) return undefined;
  const answer = available > 0
    ? `${sku} is available now — ${String(available)} in stock.`
    : `${sku} is currently out of stock.`;
  const sourcePayload = sourceFile(payload) === undefined
    ? { ...payload, source_file: INVENTORY_SOURCE_FILE }
    : payload;
  return finalResponse(answer, [citation(sourcePayload, evidence.evidence, INVENTORY_SOURCE_FILE)]);
}

/**
 * Grounded catalog answer for `skill.sales.search_product`: every line names a product of the same
 * verified catalog receipt, with that receipt's own SKU, name, price and currency.
 */
function catalogResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
): FinalResponse | undefined {
  const products = payload['products'];
  if (!Array.isArray(products) || products.length === 0) return undefined;
  const lines: string[] = [];
  for (const item of products.slice(0, 3)) {
    const row = record(item);
    if (row === null) return undefined;
    const sku = nonEmpty(row['sku']);
    const name = nonEmpty(row['name']);
    const price = row['list_price'];
    const currency = nonEmpty(row['currency']);
    if (sku === undefined || name === undefined || !finiteNumber(price) || price < 0 || currency === undefined) {
      return undefined;
    }
    lines.push(`${name} (${sku}) — ${currency} ${String(price)}`);
  }
  const sourcePayload = sourceFile(payload) === undefined
    ? { ...payload, source_file: CATALOG_SOURCE_FILE }
    : payload;
  return finalResponse(
    `Catalog matches: ${lines.join('; ')}.`,
    [citation(sourcePayload, evidence.evidence, CATALOG_SOURCE_FILE)],
  );
}

/**
 * Grounded recommendation answer: join the selected SKU to its verified ERP list-price receipt.
 * Non-advisor recommendations can still use their authoritative catalog-backed product price.
 */
function recommendationResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
  receipts: readonly VerifiedStepReceipt[],
  advisor: boolean,
): FinalResponse | undefined {
  const product = record(payload['product']);
  if (product === null) return undefined;
  const sku = nonEmpty(product['sku']);
  const name = nonEmpty(product['name']);
  if (sku === undefined || name === undefined) return undefined;
  const priceReceipt = receipts.find((verified) =>
    nonEmpty(verified.receipt.response_payload['sku_id']) === sku
    && unsignedListPrice(verified.receipt.response_payload) !== undefined);
  if (priceReceipt !== undefined) {
    const pricePayload = priceReceipt.receipt.response_payload;
    const listPrice = unsignedListPrice(pricePayload);
    const currency = nonEmpty(pricePayload['currency']);
    if (listPrice === undefined || currency === undefined) return undefined;
    const renderedPrice = new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(listPrice);
    const expected = record(payload['expected_outcome']);
    const reason = nonEmpty(payload['reason']);
    if (reason === undefined) return undefined;
    const recommendationSource = sourceFile(payload) === undefined
      ? { ...payload, source_file: RECOMMENDATION_SOURCE_FILE, source_record_id: sku }
      : payload;
    const priceSource = sourceFile(pricePayload) === undefined
      ? { ...pricePayload, source_file: QUOTE_SOURCE_FILE }
      : pricePayload;
    return finalResponse(
      `${escapeRenderedText(name)} (${escapeRenderedText(sku)}) — Giá niêm yết ERP: ${renderedPrice}. ${escapeRenderedText(reason)}${expected === null ? ' Chưa có dữ liệu doanh thu.' : ''}`,
      [
        citation(recommendationSource, evidence.evidence, RECOMMENDATION_SOURCE_FILE),
        citation(priceSource, priceReceipt.evidence, QUOTE_SOURCE_FILE),
      ],
    );
  }
  if (advisor) return undefined;
  const price = product['price'];
  const expected = record(payload['expected_outcome']);
  const currency = nonEmpty(product['currency'])
    ?? (expected === null ? undefined : nonEmpty(expected['currency']));
  const reason = nonEmpty(payload['reason']);
  if (
    currency === undefined
    || !finiteNumber(price)
    || price < 0
    || reason === undefined
  ) {
    return undefined;
  }
  const sourcePayload = sourceFile(payload) === undefined
    ? { ...payload, source_file: RECOMMENDATION_SOURCE_FILE, source_record_id: sku }
    : payload;
  return finalResponse(
    `${name} (${sku}) — ${currency} ${String(price)}. ${reason}${expected === null ? ' Chưa có dữ liệu doanh thu.' : ''}`,
    [citation(sourcePayload, evidence.evidence, RECOMMENDATION_SOURCE_FILE)],
  );
}

/** The first receipt that yields a grounded projection, or `undefined` when none does. */
function firstProjection(
  receipts: readonly VerifiedStepReceipt[],
  project: (verified: VerifiedStepReceipt) => FinalResponse | undefined,
): FinalResponse | undefined {
  for (const verified of receipts) {
    const projected = project(verified);
    if (projected !== undefined) return projected;
  }
  return undefined;
}

function draftResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
): FinalResponse | undefined {
  const draftId = nonEmpty(payload['draft_id']);
  const body = nonEmpty(payload['body_content']) ?? nonEmpty(payload['draft_text']);
  if (draftId === undefined || body === undefined) return undefined;
  const sourcePayload = sourceFile(payload) === undefined ? { ...payload, source_file: DRAFT_SOURCE_FILE } : payload;
  return finalResponse(body, [citation(sourcePayload, evidence.evidence, DRAFT_SOURCE_FILE)]);
}

function structuredResponse(
  payload: Record<string, unknown>,
  evidence: VerifiedStepReceipt,
  domain: ResponseDomain,
  hasVerifiedCustomer: boolean,
): FinalResponse | undefined {
  const answer = structuredText(payload);
  if (answer === undefined) return undefined;
  const file = sourceFile(payload);
  if (file === undefined) return undefined;
  if (
    domain === 'support'
    && !(file.startsWith(FAQ_SOURCE_PREFIX) && file.length > FAQ_SOURCE_PREFIX.length)
    && file !== ORDER_SOURCE_FILE
  ) return undefined;
  if (domain === 'support' && file === ORDER_SOURCE_FILE && !hasVerifiedCustomer) return undefined;
  if (
    domain === 'sales'
    && file !== QUOTE_SOURCE_FILE
    && file !== 'API-001.CatalogConnector'
    && file !== 'API-003.CommunicationConnector'
  ) return undefined;
  // A quote-labelled response must pass the signed, unexpired quote checks above; otherwise a
  // free-form reply could smuggle an expired or missing price into the customer channel.
  if (domain === 'sales' && file === QUOTE_SOURCE_FILE) return undefined;
  if (domain === 'marketing' && file !== DRAFT_SOURCE_FILE && !file.startsWith('marketing/')) return undefined;
  return finalResponse(answer, [citation(payload, evidence.evidence, file)]);
}

/**
 * Builds terminal text only from successful immutable receipts. It intentionally has no generic
 * apology, clarification, or model fallback: a receipt without a grounded response is refused.
 */
export class VerifiedResponseFinalizer implements IResponseFinalizer {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly quoteSigningSecret?: string,
  ) {}

  async finalize(input: ResponseFinalizationInput): Promise<FinalResponse> {
    if (input.terminal_response !== undefined) {
      assertTrustedContext(input);
      return assertTemplateResponse(input.terminal_response);
    }

    const receipts = assertTrustedInput(input);
    const domain = input.domain as ResponseDomain;
    let faqNoAnswer: FinalResponse | undefined;
    for (const verified of receipts) {
      const payload = verified.receipt.response_payload;
      if (domain === 'support') {
        const faq = faqResponse(payload, verified);
        if (faq !== undefined) return faq;
        faqNoAnswer = faqNoAnswerResponse(payload) ?? faqNoAnswer;
        const orderNotFound = orderNotFoundResponse(payload, input.context.customer !== null);
        if (orderNotFound !== undefined) return orderNotFound;
        const order = orderResponse(payload, verified, input.context.customer !== null);
        if (order !== undefined) return order;
      } else if (domain === 'sales') {
        // Prefer signed quotes, recommendations, then read-only ERP list prices, availability
        // and catalog results. Every amount comes from a successful immutable receipt.
        const quote = firstProjection(receipts, (verified) =>
          quoteResponse(verified.receipt.response_payload, verified, input, this.now, this.quoteSigningSecret, receipts));
        if (quote !== undefined) return quote;

        const recommendation = firstProjection(receipts, (verified) =>
          recommendationResponse(
            verified.receipt.response_payload,
            verified,
            receipts,
            input.context.run_state?.sales?.advisor_requirements !== undefined,
          ));
        if (recommendation !== undefined) return recommendation;

        const listPrice = firstProjection(receipts, (verified) =>
          listPriceResponse(verified.receipt.response_payload, verified));
        if (listPrice !== undefined) return listPrice;

        const availability = firstProjection(receipts, (verified) =>
          stockResponse(verified.receipt.response_payload, verified));
        if (availability !== undefined) return availability;

        const catalog = firstProjection(receipts, (verified) =>
          catalogResponse(verified.receipt.response_payload, verified));
        if (catalog !== undefined) return catalog;
      } else {
        const draft = draftResponse(payload, verified);
        if (draft !== undefined) return draft;
      }
      const structured = structuredResponse(payload, verified, domain, input.context.customer !== null);
      if (structured !== undefined) return structured;
    }
    return faqNoAnswer ?? finalizerRefusal(domain);
  }
}

/** Alias used by composition roots that prefer the implementation's trust property in its name. */
export const GroundedResponseFinalizer = VerifiedResponseFinalizer;

function readStoredResponse(recordValue: RunResponseRecord): FinalResponse {
  if (
    typeof recordValue.answer !== 'string'
    || recordValue.answer.trim().length === 0
    || !Array.isArray(recordValue.sources)
    || nonEmpty(recordValue.source) === undefined
    || !RESPONSE_KINDS.includes(recordValue.response_kind)
    || recordValue.outcome !== RESPONSE_OUTCOME_BY_KIND[recordValue.response_kind]
  ) {
    refusal('RESPONSE_STORE_INVALID', 'Durable response row is malformed; refusing to expose it.');
  }
  const sources = recordValue.sources as unknown[];
  for (const source of sources) {
    const row = record(source);
    if (
      row === null
      || nonEmpty(row['source_record_id']) === undefined
      || nonEmpty(row['source_version']) === undefined
      || nonEmpty(row['source_file']) === undefined
    ) {
      refusal('RESPONSE_STORE_INVALID', 'Durable response row contains an invalid source citation.');
    }
  }

  if (recordValue.response_kind === 'ANSWER') {
    if (sources.length === 0 || recordValue.source !== EVIDENCE_SOURCE || recordValue.template_key !== null) {
      refusal('RESPONSE_STORE_INVALID', 'Durable answer is missing evidence provenance.');
    }
    return {
      response_kind: 'ANSWER',
      text: recordValue.answer,
      source: recordValue.source,
      sources: sources as RunResponseSource[],
    };
  }

  if (recordValue.template_key === null || !TEMPLATE_KEYS.includes(recordValue.template_key as TemplateKey)) {
    refusal('RESPONSE_STORE_INVALID', 'Durable template response has no allowlisted template key.');
  }
  return assertTemplateResponse({
    response_kind: recordValue.response_kind,
    text: recordValue.answer,
    source: recordValue.source,
    template_key: recordValue.template_key as TemplateKey,
    ...(recordValue.reason_code === null ? {} : { reason_code: recordValue.reason_code }),
    sources: sources as RunResponseSource[],
  });
}

/** Adapts the database repository's atomic response/message transaction to the core port. */
export class RunResponseStoreAdapter implements IRunResponseStore {
  constructor(private readonly repository: Pick<RunResponseRepository, 'read' | 'save'>) {}

  async read(input: { tenant_id: string; run_id: string }): Promise<FinalResponse | null> {
    const stored = await this.repository.read(input.tenant_id, input.run_id);
    return stored === null ? null : readStoredResponse(stored);
  }

  async save(input: {
    tenant_id: string;
    run_id: string;
    conversation_id?: string;
    outcome: ResponseOutcome;
    sender_id: string;
    response: FinalResponse;
  }): Promise<void> {
    if (input.outcome !== RESPONSE_OUTCOME_BY_KIND[input.response.response_kind]) {
      refusal('RESPONSE_OUTCOME_INVALID', 'Durable response outcome does not match its response kind.');
    }
    await this.repository.save({
      tenant_id: input.tenant_id,
      run_id: input.run_id,
      answer: input.response.text,
      sources: input.response.sources,
      response_kind: input.response.response_kind,
      outcome: input.outcome,
      source: input.response.source,
      ...(input.response.template_key === undefined ? {} : { template_key: input.response.template_key }),
      ...(input.response.reason_code === undefined ? {} : { reason_code: input.response.reason_code }),
      ...(input.conversation_id === undefined ? {} : { conversation_id: input.conversation_id }),
      sender_id: input.sender_id,
    });
  }
}

export const DurableRunResponseStore = RunResponseStoreAdapter;

export function createResponseFinalizer(
  now?: () => Date,
  quoteSigningSecret?: string,
): IResponseFinalizer {
  return new VerifiedResponseFinalizer(now, quoteSigningSecret);
}

export function createRunResponseStore(repository: RunResponseRepository): IRunResponseStore {
  return new RunResponseStoreAdapter(repository);
}

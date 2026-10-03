import { fail } from '../../gateway/http.js';
import type { AgentModule } from '../../gateway/contracts.js';

/**
 * Support takes precedence when a message also mentions a product: an existing order or complaint is
 * not a sales lead.
 */
const SUPPORT_INTENT =
  /\b(refund|return|exchange|warranty|complaint|tracking|delivery|delivered|cancel(?:led)? order|where is my order|my order|broken|damaged|not working|issue|problem)\b|đơn hàng|giao hàng|đổi trả|hoàn tiền|bảo hành|khiếu nại|hủy đơn|bị lỗi|không hoạt động|sự cố/iu;

/**
 * A generic shopping turn names a commercial action, an attribute, a budget, or availability. The
 * classifier is vertical-agnostic: it deliberately encodes no tenant catalog, product type, or
 * currency. Specific product categories come from the tenant catalog lexicon passed by the caller.
 */
const SALES_INTENT =
  /\b(recommend|suggest|looking for|in stock|available|availability|price|pricing|buy|purchase|shop|product|item|catalog|order(?:ing)?|budget|under|below|less than|up to|maximum|at most|size|color|usd|eur|gbp|vnd|dollar|euro|pound)\b|tư vấn|gợi ý|còn hàng|giá|mua|sản phẩm|mặt hàng|danh mục|màu nào|kích cỡ|ngân sách|triệu/iu;
/** Currency symbols are unambiguous only when they introduce a numeric amount. */
const SYMBOL_CURRENCY_PATTERNS: readonly [RegExp, string][] = [
  [/\$\s*[0-9]/, 'USD'],
  [/€\s*[0-9]/, 'EUR'],
  [/£\s*[0-9]/, 'GBP'],
];
/** Vietnamese money markers: a scale suffix or the đồng/đ symbol implies VND. */
const VND_CURRENCY_MARKERS = /₫|\btrieu\b|\bnghin\b|\bngan\b|(?:^|[^a-z0-9])đong(?:$|[^a-z0-9])|[0-9]\s*đ|đ\s*[0-9]/;
/** Explicit ISO-4217 allowlist: prose words are never inferred as currency codes. */
const ISO_4217_CURRENCY_CODES: Readonly<Record<string, true>> = {
  AED: true, AFN: true, ALL: true, AMD: true, ANG: true, AOA: true, ARS: true, AUD: true, AWG: true, AZN: true,
  BAM: true, BBD: true, BDT: true, BGN: true, BHD: true, BIF: true, BMD: true, BND: true, BOB: true, BOV: true,
  BRL: true, BSD: true, BTN: true, BWP: true, BYN: true, BZD: true, CAD: true, CDF: true, CHE: true, CHF: true,
  CHW: true, CLF: true, CLP: true, CNY: true, COP: true, COU: true, CRC: true, CUC: true, CUP: true, CVE: true,
  CZK: true, DJF: true, DKK: true, DOP: true, DZD: true, EGP: true, ERN: true, ETB: true, EUR: true, FJD: true,
  FKP: true, GBP: true, GEL: true, GHS: true, GIP: true, GMD: true, GNF: true, GTQ: true, GYD: true, HKD: true,
  HNL: true, HTG: true, HUF: true, IDR: true, ILS: true, INR: true, IQD: true, IRR: true, ISK: true, JMD: true,
  JOD: true, JPY: true, KES: true, KGS: true, KHR: true, KMF: true, KPW: true, KRW: true, KWD: true, KYD: true,
  KZT: true, LAK: true, LBP: true, LKR: true, LRD: true, LSL: true, LYD: true, MAD: true, MDL: true, MGA: true,
  MKD: true, MMK: true, MNT: true, MOP: true, MRU: true, MUR: true, MVR: true, MWK: true, MXN: true, MXV: true,
  MYR: true, MZN: true, NAD: true, NGN: true, NIO: true, NOK: true, NPR: true, NZD: true, OMR: true, PAB: true,
  PEN: true, PGK: true, PHP: true, PKR: true, PLN: true, PYG: true, QAR: true, RON: true, RSD: true, RUB: true,
  RWF: true, SAR: true, SBD: true, SCR: true, SDG: true, SEK: true, SGD: true, SHP: true, SLE: true, SLL: true,
  SOS: true, SRD: true, SSP: true, STN: true, SVC: true, SYP: true, SZL: true, THB: true, TJS: true, TMT: true,
  TND: true, TOP: true, TRY: true, TTD: true, TWD: true, TZS: true, UAH: true, UGX: true, USD: true, USN: true,
  UYI: true, UYU: true, UYW: true, UZS: true, VED: true, VES: true, VND: true, VUV: true, WST: true, XAF: true,
  XAG: true, XAU: true, XBA: true, XBB: true, XBC: true, XBD: true, XCD: true, XDR: true, XOF: true, XPD: true,
  XPF: true, XPT: true, XSU: true, XTS: true, XUA: true, XXX: true, YER: true, ZAR: true, ZMW: true, ZWL: true,
};
/** A bounded amount is only parsed inside an explicit budget phrase. */
const BUDGET_CONTEXT = /\b(?:under|below|less than|up to|maximum|at most|budget|duoi|ngan sach)\b/i;
const AMOUNT_IN_BUDGET =
  /\b(?:[$€£]|[a-z]{3})?\s*([0-9][0-9.,]*)\s*(million|m|billion|b|thousand|k|trieu|nghin|ngan)?(?:\s*([a-z]{3}))?/;
const SALES_READ_INTENT =
  /\b(in stock|available|availability|stock|price|pricing|how much|spec(?:ification)?s?)\b/i;
const SALES_ADVISOR_INTENT =
  /\b(recommend|suggest|looking for|budget|under|below|less than|up to|maximum|at most)\b/i;

export type SalesOrderPaymentMethod =
  | 'CREDIT_CARD'
  | 'CVS_COD'
  | 'LINE_PAY'
  | 'JKOPAY'
  | 'STRIPE'
  | 'PAYPAL';

export interface SalesOrderRequest {
  readonly sku_id?: string;
  readonly quantity: number;
  readonly payment_method?: SalesOrderPaymentMethod;
}

const PURCHASE_INTENT =
  /\b(?:buy|purchase|order|place\s+(?:an?\s+)?order|get\s+me)\b|mua|đặt\s+(?:mua|hàng)/iu;
const PREFIXED_ORDER_SKU = /\b((?:SKU|PROD|ITEM)-[A-Z0-9][A-Z0-9._-]{0,127})\b/i;
const LABELED_ORDER_SKU =
  /\b(?:sku|product\s*(?:code|id)|item\s*(?:code|id))\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]{0,127})\b/i;
const ORDER_QUANTITY_PATTERNS = [
  /\b(?:quantity|qty)\s*(?:is|of|[:=])?\s*(\d+)\b/i,
  /\b(\d+)\s*(?:units?|items?|pieces?|pcs)\b/i,
  /\b(?:buy|purchase|order)\s+(\d+)\b/i,
  /(?:mua|đặt\s+(?:mua|hàng))\s+(\d+)\b/i,
] as const;
const ORDER_PAYMENT_METHODS: readonly [RegExp, SalesOrderPaymentMethod][] = [
  [/\b(?:cash\s+on\s+delivery|cod)\b|thanh\s+toán\s+khi\s+nhận\s+hàng/iu, 'CVS_COD'],
  [/\b(?:credit\s+card|visa|mastercard)\b|thẻ\s+tín\s+dụng/iu, 'CREDIT_CARD'],
  [/\bline\s*pay\b/iu, 'LINE_PAY'],
  [/\bjko\s*pay\b/iu, 'JKOPAY'],
  [/\bstripe\b/iu, 'STRIPE'],
  [/\bpaypal\b/iu, 'PAYPAL'],
];

/** Parses only explicit customer order wording; SKU, quantity, and payment never come from the LLM. */
export function salesOrderRequestFor(message: string): SalesOrderRequest | undefined {
  if (!PURCHASE_INTENT.test(message)) return undefined;

  const prefixedSku = PREFIXED_ORDER_SKU.exec(message);
  const labeledSku = prefixedSku === null ? LABELED_ORDER_SKU.exec(message) : null;
  const rawSku = prefixedSku?.[1] ?? labeledSku?.[1];

  let quantity: number | undefined;
  for (const pattern of ORDER_QUANTITY_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1] === undefined) continue;
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
    quantity = parsed;
    break;
  }

  let payment_method: SalesOrderPaymentMethod | undefined;
  for (const [pattern, method] of ORDER_PAYMENT_METHODS) {
    if (!pattern.test(message)) continue;
    if (payment_method !== undefined && payment_method !== method) return undefined;
    payment_method = method;
  }

  return {
    ...(rawSku === undefined ? {} : { sku_id: rawSku.toUpperCase() }),
    quantity: quantity ?? 1,
    ...(payment_method === undefined ? {} : { payment_method }),
  };
}

/**
 * A tenant-catalog vocabulary of category terms. It is optional and defaults to empty so the
 * classifier stays vertical-agnostic until a caller supplies the tenant's own catalog.
 */
export type TurnLexicon = readonly string[];

/** Strips diacritics (keeping đ) and lowercases so Vietnamese and English match uniformly. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function containsTerm(haystack: string, term: string, pluralInsensitive = false): boolean {
  // Match the Sales catalog's categoryKey convention without depending on worker internals.
  const key = pluralInsensitive && term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = pluralInsensitive && key.length >= 3 ? 's?' : '';
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}${suffix}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function matchesLexicon(foldedMessage: string, lexicon: TurnLexicon): boolean {
  for (const entry of lexicon) {
    const folded = fold(entry).trim().replace(/\s+/g, ' ');
    if (folded.length > 0 && folded.length <= 64 && containsTerm(foldedMessage, folded)) return true;
  }
  return false;
}

/**
 * Structured requirements are an advisor proposal only when the customer is asking for a
 * recommendation. Inventory, price, and specification questions remain direct Sales reads; the
 * worker must not turn a SKU lookup into an unrelated clarification message.
 */
export function shouldUseSalesAdvisor(message: string, requirements: SalesTurnRequirements | undefined): boolean {
  if (requirements === undefined) return false;
  return !SALES_READ_INTENT.test(message) || SALES_ADVISOR_INTENT.test(message);
}

const AGENT_MODULES: readonly AgentModule[] = Object.freeze(['marketing', 'sales', 'support', 'auto']);

/** Classifies only the destination module. LLM output never grants module authority. */
export function classifyTurnModule(
  message: string,
  requested: AgentModule | undefined,
  lexicon: TurnLexicon = [],
): AgentModule {
  if (requested !== undefined && !AGENT_MODULES.includes(requested)) {
    fail('UNKNOWN_SKILL', 'the requested agent module is not supported');
  }
  if (requested !== undefined && requested !== 'auto') return requested;
  if (SUPPORT_INTENT.test(message)) return 'support';
  if (SALES_INTENT.test(message) || matchesLexicon(fold(message), lexicon)) return 'sales';
  if (requested === undefined) return 'support';
  fail('UNKNOWN_SKILL', 'automatic routing could not determine a supported agent module');
}


export interface SalesBudget {
  readonly amount: number;
  /** A bounded ISO-4217-style code; source verification belongs to Sales connectors. */
  readonly currency: string;
}

export interface SalesProductEligibilityHint {
  /** A customer/model-proposed lookup hint, not proof of product identity or inventory. */
  readonly sku?: string;
  /** A customer/model-proposed category hint, not a catalog authority. */
  readonly category?: string;
}

/**
 * Structured Sales understanding is intentionally optional. Missing fields tell the Sales skill to
 * clarify; the gateway never rejects an otherwise valid Sales turn because a customer omitted a
 * preference.
 */
export interface SalesTurnRequirements {
  readonly category?: string;
  readonly budget?: SalesBudget;
  readonly use_case?: string;
  readonly product_eligibility?: SalesProductEligibilityHint;
}

function textHint(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed.toLowerCase();
}

/** Matches case/plural-insensitive tenant catalog category terms; empty lexicon yields no category. */
function categoryHint(foldedMessage: string, lexicon: TurnLexicon): string | undefined {
  for (const entry of lexicon) {
    const folded = fold(entry).trim().replace(/\s+/g, ' ');
    if (folded.length === 0 || folded.length > 64 || !containsTerm(foldedMessage, folded, true)) continue;
    const hint = textHint(entry, 64);
    if (hint !== undefined) return hint;
  }
  return undefined;
}

/** Resolves a currency only from an explicit symbol, ISO-4217 code, or Vietnamese VND marker. */
function resolveCurrency(window: string, unit: string | undefined): string | undefined {
  for (const [pattern, currency] of SYMBOL_CURRENCY_PATTERNS) {
    if (pattern.test(window)) return currency;
  }
  if (unit === 'trieu' || unit === 'nghin' || unit === 'ngan') return 'VND';
  if (VND_CURRENCY_MARKERS.test(window)) return 'VND';
  for (const candidate of window.match(/\b[a-z]{3}\b/g) ?? []) {
    const upper = candidate.toUpperCase();
    if (ISO_4217_CURRENCY_CODES[upper] === true) return upper;
  }
  return undefined;
}

function budgetHint(folded: string): SalesBudget | undefined {
  const context = BUDGET_CONTEXT.exec(folded);
  if (context === null || context.index === undefined) return undefined;
  const window = folded.slice(context.index + context[0].length, context.index + context[0].length + 48);
  const match = AMOUNT_IN_BUDGET.exec(window);
  if (match === null) return undefined;
  const raw = match[1];
  if (raw === undefined) return undefined;
  const currency = resolveCurrency(match[0], match[2]);
  if (currency === undefined) return undefined;
  const normalizedRaw = raw.includes(',') && raw.includes('.')
    ? raw.replace(/,/g, '')
    : /,\d{3}$/.test(raw)
      ? raw.replace(/,/g, '')
      : raw.replace(',', '.');
  const unit = match[2];
  const multiplier =
    unit === 'million' || unit === 'm' || unit === 'trieu'
      ? 1_000_000
      : unit === 'billion' || unit === 'b'
        ? 1_000_000_000
        : unit === 'thousand' || unit === 'k' || unit === 'nghin' || unit === 'ngan'
          ? 1_000
          : 1;
  const amount = Number(normalizedRaw) * multiplier;
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  return { amount, currency };
}

function useCaseHint(normalized: string): string | undefined {
  const match = normalized.match(
    /\b(?:for|to use for|dung cho|cho)\s+([^.!?;,]{1,160}?)(?=\s+(?:under|below|up to|budget)\b|[.!?;,]|$)/i,
  );
  return match === null ? undefined : textHint(match[1] ?? '', 160);
}

function skuHint(normalized: string): string | undefined {
  const match = normalized.match(/\b(?:sku|product\s*(?:code|id)|item\s*(?:code|id))\s*[:#-]?\s*([a-z0-9][a-z0-9._-]{0,127})\b/i);
  return match === null ? undefined : textHint(match[1] ?? '', 128);
}

/**
 * Extracts bounded, non-authoritative commercial hints from the customer's message.
 *
 * LLM structured understanding is primary: provider-proposed category, use case, and SKU take
 * precedence, and the bounded regex extraction only fills the gaps. Amounts are never taken from the
 * provider — they must remain traceable to the customer message and later verified by Sales sources,
 * so a budget is parsed only from an explicit currency word or symbol and validated against ISO-4217.
 */
export function salesRequirementsFor(
  message: string,
  proposal?: SalesTurnRequirements,
  lexicon: TurnLexicon = [],
): SalesTurnRequirements | undefined {
  const folded = fold(message);

  const proposedCategory = proposal?.category === undefined ? undefined : textHint(proposal.category, 64);
  const proposedUseCase = proposal?.use_case === undefined ? undefined : textHint(proposal.use_case, 160);
  const proposedSku = proposal?.product_eligibility?.sku === undefined
    ? undefined
    : textHint(proposal.product_eligibility.sku, 128);
  const proposedEligibilityCategory = proposal?.product_eligibility?.category === undefined
    ? undefined
    : textHint(proposal.product_eligibility.category, 64);

  const resolvedCategory = proposedCategory ?? categoryHint(folded, lexicon);
  const resolvedUseCase = proposedUseCase ?? useCaseHint(folded);
  const resolvedSku = proposedSku ?? skuHint(folded);
  const resolvedEligibilityCategory = proposedEligibilityCategory;
  const budget = budgetHint(folded);

  if (resolvedCategory === undefined && budget === undefined && resolvedUseCase === undefined && resolvedSku === undefined
    && resolvedEligibilityCategory === undefined) {
    return undefined;
  }

  const product_eligibility =
    resolvedSku === undefined && resolvedEligibilityCategory === undefined
      ? undefined
      : {
          ...(resolvedSku === undefined ? {} : { sku: resolvedSku }),
          ...(resolvedEligibilityCategory === undefined ? {} : { category: resolvedEligibilityCategory }),
        };
  return {
    ...(resolvedCategory === undefined ? {} : { category: resolvedCategory }),
    ...(budget === undefined ? {} : { budget }),
    ...(resolvedUseCase === undefined ? {} : { use_case: resolvedUseCase }),
    ...(product_eligibility === undefined ? {} : { product_eligibility }),
  };
}

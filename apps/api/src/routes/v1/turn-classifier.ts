import { fail } from '../../gateway/http.js';
import type { AgentModule } from '../../gateway/contracts.js';

/**
 * Support takes precedence when a message also mentions a product: an existing order or complaint is
 * not a sales lead.
 */
const SUPPORT_INTENT =
  /\b(refund|return|exchange|warranty|complaint|tracking|delivery|delivered|cancel(?:led)? order|where is my order|my order|broken|damaged|not working|issue|problem)\b|đơn hàng|giao hàng|đổi trả|hoàn tiền|bảo hành|khiếu nại|hủy đơn|bị lỗi|không hoạt động|sự cố/iu;

/**
 * A generic shopping turn names an action, a product, a budget, or availability. The classifier
 * deliberately does not encode a tenant catalog or a currency: category and commercial details are
 * proposals for the Sales skill, never authority to act.
 */
const SALES_INTENT =
  /\b(recommend|suggest|looking for|in stock|available|availability|price|pricing|buy|purchase|shop|product|item|catalog|order(?:ing)?|size|color|laptop|notebook|computer|desktop|monitor|screen|keyboard|mouse|headphone|speaker|phone|smartphone|tablet|camera|printer|router|ssd|storage|drive|accessor(?:y|ies)|budget|under|below|less than|up to|maximum|at most|usd|eur|gbp|vnd|dollar|euro|pound)\b|tư vấn|gợi ý|còn hàng|giá|mua|sản phẩm|mặt hàng|danh mục|màu nào|kích cỡ|máy tính|điện thoại|màn hình|bàn phím|tai nghe|máy ảnh|ngân sách|triệu|đồng/iu;
const SYMBOL_CURRENCY_PATTERNS: readonly [RegExp, string][] = [
  [/\$\s*[0-9]/, 'USD'],
  [/€\s*[0-9]/, 'EUR'],
  [/£\s*[0-9]/, 'GBP'],
  [/(?:₫|đ)\s*[0-9]|[0-9][0-9.,]*\s*(?:₫|đ|\bvnd\b|d\b)/iu, 'VND'],
];

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
const SALES_READ_INTENT =
  /\b(in stock|available|availability|stock|price|pricing|how much|spec(?:ification)?s?)\b/i;
const SALES_ADVISOR_INTENT =
  /\b(recommend|suggest|looking for|budget|under|below|less than|up to|maximum|at most)\b/i;

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
export function classifyTurnModule(message: string, requested: AgentModule | undefined): AgentModule {
  if (requested !== undefined && !AGENT_MODULES.includes(requested)) {
    fail('UNKNOWN_SKILL', 'the requested agent module is not supported');
  }
  if (requested !== undefined && requested !== 'auto') return requested;
  if (SUPPORT_INTENT.test(message)) return 'support';
  if (SALES_INTENT.test(message)) return 'sales';
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

function categoryHint(normalized: string): string | undefined {
  const candidates: readonly [RegExp, string][] = [
    [/\b(laptop|notebook|computer|desktop|pc)\b|may tinh/, 'laptops'],
    [/\b(phone|smartphone|mobile)\b|dien thoai/, 'phones'],
    [/\b(tablet)\b|may tinh bang/, 'tablets'],
    [/\b(camera)\b|may anh/, 'cameras'],
    [/\b(monitor|screen)\b|man hinh/, 'monitors'],
    [/\b(printer)\b|may in/, 'printers'],
    [/\b(router)\b/, 'routers'],
    [/\b(headphone|earbuds|speaker)\b|tai nghe/, 'audio'],
    [/\b(keyboard|mouse|dock|hub|cable|pen|stylus|bag|case|accessory|accessories)\b|ban phim|chuot|phu kien/, 'accessories'],
    [/\b(ssd|storage|drive)\b|o cung/, 'storage'],
  ];
  for (const [pattern, category] of candidates) {
    if (pattern.test(normalized)) return category;
  }
  return undefined;
}

function parseNumericAmount(raw: string): number {
  const trimmed = raw.trim();
  if (/^[0-9]{1,3}(?:\.[0-9]{3})+$/.test(trimmed)) return Number(trimmed.replace(/\./g, ''));
  if (/^[0-9]{1,3}(?:,[0-9]{3})+$/.test(trimmed)) return Number(trimmed.replace(/,/g, ''));
  if (trimmed.includes(',') && trimmed.includes('.')) {
    return trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')
      ? Number(trimmed.replace(/\./g, '').replace(',', '.'))
      : Number(trimmed.replace(/,/g, ''));
  }
  return Number(trimmed.replace(',', '.'));
}

function currencyHint(normalized: string): string | undefined {
  for (const [pattern, currency] of SYMBOL_CURRENCY_PATTERNS) {
    if (pattern.test(normalized)) return currency;
  }

  const match = normalized.match(
    /\b([a-z]{3})\b(?=\s*[0-9])|\b([a-z]{3})\b(?=\s*(?:under|below|less than|up to|maximum|at most|budget)\b)|\b[0-9][0-9.,]*\s*(?:million|m|billion|b|thousand|k|trieu|triệu|nghin|nghìn|tr)?\s*([a-z]{3})\b/iu,
  );
  const candidate = (match?.[1] ?? match?.[2] ?? match?.[3])?.toUpperCase();
  if (candidate !== undefined && ISO_4217_CURRENCY_CODES[candidate] === true) {
    return candidate;
  }

  if (/(?:₫|đ|\bdong\b|đồng|\btrieu\b|triệu|\btr\b|\d+\s*tr\b|\d+\s*k\b|\bnghin\b|nghìn|\d+\s*nghin\b|\d+\s*nghìn\b|\d+\s*d\b)/iu.test(normalized)) {
    return 'VND';
  }

  return undefined;
}

function budgetHint(normalized: string): SalesBudget | undefined {
  const currency = currencyHint(normalized);
  if (currency === undefined) return undefined;
  const match = normalized.match(
    /(?:under|below|less than|up to|maximum|at most|budget|duoi|dưới|ngan sach|ngân sách)\s*(?:[$€£₫]\s*)?(?:([0-9]+(?:[.,][0-9]+)*)\s*(million|m|billion|b|thousand|k|trieu|triệu|nghin|nghìn|tr|d)?(?:\s*(?:d|dong|vnd))?|(?:[a-z]{3})\s*([0-9]+(?:[.,][0-9]+)*))/iu,
  );
  if (match === null) return undefined;
  const raw = match[1] ?? match[3];
  if (raw === undefined) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === 'million' || unit === 'm' || unit === 'trieu' || unit === 'triệu' || unit === 'tr'
      ? 1_000_000
      : unit === 'billion' || unit === 'b'
        ? 1_000_000_000
        : unit === 'thousand' || unit === 'k' || unit === 'nghin' || unit === 'nghìn'
          ? 1_000
          : 1;
  const amount = Math.round(parseNumericAmount(raw) * multiplier);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  return { amount, currency };
}

function useCaseHint(normalized: string): string | undefined {
  const match = normalized.match(
    /\b(?:for|to use for|dung cho|dùng cho|cho|de|để)\s+([^.!?;,]{1,160}?)(?=\s+(?:under|below|up to|budget|duoi|dưới|ngan sach|ngân sách)\b|[.!?;,]|$)/iu,
  );
  if (match !== null) {
    const hint = textHint(match[1] ?? '', 160);
    if (hint) return hint;
  }
  if (/\b(graphic design|design|creator)\b|do hoa|thiet ke/.test(normalized)) return 'graphic design';
  if (/\b(gaming|game)\b|choi game/.test(normalized)) return 'gaming';
  if (/\b(office|work|business)\b|van phong|cong so|hoc tap|hoc sinh|sinh vien/.test(normalized)) return 'office';
  if (/\b(travel|portable|lightweight)\b|du lich|di chuyen|mong nhe/.test(normalized)) return 'travel';
  return undefined;
}

function skuHint(normalized: string): string | undefined {
  const match = normalized.match(/\b(?:sku|product\s*(?:code|id)|item\s*(?:code|id))\s*[:#-]?\s*([a-z0-9][a-z0-9._-]{0,127})\b/i);
  return match === null ? undefined : textHint(match[1] ?? '', 128);
}

/** Extracts bounded, non-authoritative commercial hints from the customer's message. */
export function salesRequirementsFor(message: string, proposal?: SalesTurnRequirements): SalesTurnRequirements | undefined {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
  const category = categoryHint(normalized);
  const budget = budgetHint(normalized);
  const use_case = useCaseHint(normalized);
  const sku = skuHint(normalized);

  // Provider hints are advisory only. In particular, never accept a provider-supplied amount:
  // amounts must remain traceable to the customer message and later verified by Sales sources.
  const proposedCategory = proposal?.category === undefined ? undefined : textHint(proposal.category, 64);
  const proposedUseCase = proposal?.use_case === undefined ? undefined : textHint(proposal.use_case, 160);
  const proposedSku = proposal?.product_eligibility?.sku === undefined
    ? undefined
    : textHint(proposal.product_eligibility.sku, 128);
  const proposedEligibilityCategory = proposal?.product_eligibility?.category === undefined
    ? undefined
    : textHint(proposal.product_eligibility.category, 64);
  const resolvedCategory = category ?? proposedCategory;
  const resolvedUseCase = use_case ?? proposedUseCase;
  const resolvedSku = sku ?? proposedSku;
  const resolvedEligibilityCategory = proposedEligibilityCategory;

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
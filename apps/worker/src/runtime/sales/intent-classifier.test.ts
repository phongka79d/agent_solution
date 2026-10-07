import { describe, expect, it, vi } from 'vitest';
import type { HydratedContext, SignalEnvelope } from '@agentos/core-engine/contracts';
import {
  BUILTIN_SALES_LEXICON,
  isCartRecoveryInquiry,
  isCustomerLookupInquiry,
  isInventoryInquiry,
  isPriceInquiry,
  isProductSearchInquiry,
  isRecommendInquiry,
  isReplenishmentInquiry,
  type SalesLexicon,
} from './intent-classifier.js';
import { SalesAgentRuntime } from './agent-runtime.js';

const tenant_id = 'tenant-sales-lexicon';
const correlation_id = 'correlation-sales-lexicon';

const context: HydratedContext = {
  correlation_id,
  tenant_id,
  customer: null,
  working_memory: {
    session_id: 'session-sales-lexicon',
    last_touch_channel: 'web',
    turn_count: 1,
    takeover_active: false,
  },
  knowledge_citations: [],
  hydrated_at: '2026-01-01T00:00:00.000Z',
};

function signal(message: string, overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    signal_id: `signal-${message}`,
    tenant_id,
    correlation_id,
    source_channel: 'web',
    event_type: 'message',
    payload: { message },
    subject: { session_id: 'session-sales-lexicon', channel_type: 'web' },
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SalesLexicon intent matching', () => {
  it.each([
    ['price', isPriceInquiry],
    ['pricing', isPriceInquiry],
    ['discount', isPriceInquiry],
    ['cost', isPriceInquiry],
    ['how much', isPriceInquiry],
    ['quote', isPriceInquiry],
    ['quotation', isPriceInquiry],
    ['rate', isPriceInquiry],
    ['fee', isPriceInquiry],
    ['p_floor', isPriceInquiry],
    ['stock', isInventoryInquiry],
    ['inventory', isInventoryInquiry],
    ['available', isInventoryInquiry],
    ['availability', isInventoryInquiry],
    ['in stock', isInventoryInquiry],
    ['out of stock', isInventoryInquiry],
    ['quantity', isInventoryInquiry],
    ['recommend', isRecommendInquiry],
    ['recommendation', isRecommendInquiry],
    ['suggest', isRecommendInquiry],
    ['cross-sell', isRecommendInquiry],
    ['upsell', isRecommendInquiry],
    ['bundle', isRecommendInquiry],
    ['substitute', isRecommendInquiry],
    ['pair with', isRecommendInquiry],
    ['customer', isCustomerLookupInquiry],
    ['profile', isCustomerLookupInquiry],
    ['account', isCustomerLookupInquiry],
    ['my account', isCustomerLookupInquiry],
    ['purchase history', isCustomerLookupInquiry],
    ['order history', isCustomerLookupInquiry],
    ['search', isProductSearchInquiry],
    ['find', isProductSearchInquiry],
    ['looking for', isProductSearchInquiry],
    ['look for', isProductSearchInquiry],
    ['catalog', isProductSearchInquiry],
    ['browse', isProductSearchInquiry],
    ['show me', isProductSearchInquiry],
    ['product', isProductSearchInquiry],
    ['products', isProductSearchInquiry],
    ['abandoned cart', isCartRecoveryInquiry],
    ['abandoned-cart', isCartRecoveryInquiry],
    ['cart recovery', isCartRecoveryInquiry],
    ['cart-recovery', isCartRecoveryInquiry],
    ['recover cart', isCartRecoveryInquiry],
    ['recover-cart', isCartRecoveryInquiry],
    ['replenish', isReplenishmentInquiry],
    ['replenishment', isReplenishmentInquiry],
    ['reorder', isReplenishmentInquiry],
    ['repurchase', isReplenishmentInquiry],
    ['recurring order', isReplenishmentInquiry],
    ['refill', isReplenishmentInquiry],
    ['subscribe again', isReplenishmentInquiry],
    ['order again', isReplenishmentInquiry],
    ['buy again', isReplenishmentInquiry],
  ])('matches builtin term %s', (term, matcher) => {
    expect(matcher(`please ${term.toUpperCase()} now`)).toBe(true);
  });

  it('matches Vietnamese diacritics with case-insensitive word boundaries', () => {
    expect(isPriceInquiry('Tôi muốn biết GIÁ sản phẩm')).toBe(true);
    expect(isInventoryInquiry('sản phẩm còn hàng không?')).toBe(true);
    expect(isRecommendInquiry('gợi ý sản phẩm phù hợp')).toBe(true);
    expect(isProductSearchInquiry('tôi cần mua laptop')).toBe(true);
  });

  it('uses tenant terms, replacing only the categories provided', async () => {
    const runtime = new SalesAgentRuntime({
      lexicon: {
        read: vi.fn(async () => ({ product_search: ['sku-mới'] })),
      },
    });
    const hypothesis = await runtime.deriveHypothesis(signal('sku-mới'), context);
    const routing = await runtime.resolveRouting(signal('sku-mới'), context, hypothesis);

    expect(hypothesis.intent).toBe('product_search');
    expect(hypothesis.metadata).toEqual({ lexicon_source: 'tenant' });
    expect(routing.metadata).toEqual({ lexicon_source: 'tenant' });
    expect(isProductSearchInquiry('sku-mới', BUILTIN_SALES_LEXICON)).toBe(false);
  });

  it('falls back to builtin lexicon with a warning when the tenant port fails', async () => {
    const read = vi.fn(async () => {
      throw new Error('lexicon unavailable');
    });
    const runtime = new SalesAgentRuntime({ lexicon: { read } });
    const currentSignal = signal('price');
    const hypothesis = await runtime.deriveHypothesis(currentSignal, context);
    const routing = await runtime.resolveRouting(currentSignal, context, hypothesis);

    expect(hypothesis.intent).toBe('disabled_price');
    expect(hypothesis.metadata).toEqual({
      lexicon_source: 'builtin',
      lexicon_warning: 'SALES_LEXICON_READ_FAILED',
    });
    expect(routing.metadata).toEqual(hypothesis.metadata);
  });

  it('reads tenant lexicon once per run', async () => {
    const read = vi.fn(async (): Promise<Partial<SalesLexicon> | undefined> => ({
      product_search: ['once-only-term'],
    }));
    const runtime = new SalesAgentRuntime({ lexicon: { read } });
    const currentSignal = signal('once-only-term');

    await runtime.deriveHypothesis(currentSignal, context);
    await runtime.deriveHypothesis(currentSignal, context);

    expect(read).toHaveBeenCalledTimes(1);
  });
});

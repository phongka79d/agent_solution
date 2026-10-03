import { describe, expect, it, vi } from 'vitest';
import type { HydratedContext, SignalEnvelope } from '@agentos/core-engine/contracts';
import {
  BUILTIN_SALES_LEXICON,
  extractSku,
  isCartRecoveryInquiry,
  isCustomerLookupInquiry,
  isInventoryInquiry,
  isPriceInquiry,
  isProductSearchInquiry,
  isRecommendInquiry,
  isReplenishmentInquiry,
  type SalesLexicon,
  type SkillRegistryRowMetadata,
} from './intent-classifier.js';
import { SalesAgentRuntime } from './agent-runtime.js';

const tenant_id = 'tenant-sales-lexicon';
const correlation_id = 'correlation-sales-lexicon';

function createContext(): HydratedContext {
  return {
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
}

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
  });

  it('uses tenant terms, replacing only the categories provided', async () => {
    const runtime = new SalesAgentRuntime({
      lexicon: {
        read: vi.fn(async () => ({ product_search: ['sku-mới'] })),
      },
    });
    const runContext = createContext();
    const hypothesis = await runtime.deriveHypothesis(signal('sku-mới'), runContext);
    const routing = await runtime.resolveRouting(signal('sku-mới'), runContext, hypothesis);

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
    const runContext = createContext();
    const hypothesis = await runtime.deriveHypothesis(currentSignal, runContext);
    const routing = await runtime.resolveRouting(currentSignal, runContext, hypothesis);

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

    const runContext = createContext();
    await runtime.deriveHypothesis(currentSignal, runContext);
    await runtime.deriveHypothesis(currentSignal, runContext);

    expect(read).toHaveBeenCalledTimes(1);
  });
  it('rehydrates tenant lexicon from checkpoint context in a fresh runtime', async () => {
    const read = vi.fn(async (): Promise<Partial<SalesLexicon> | undefined> => ({
      product_search: ['checkpoint-only-term'],
    }));
    const context = createContext();
    const currentSignal = signal('checkpoint-only-term');
    const original = new SalesAgentRuntime({ lexicon: { read } });

    await original.deriveHypothesis(currentSignal, context);
    const checkpointContext = JSON.parse(JSON.stringify(context)) as HydratedContext;
    const reclaimedRead = vi.fn(async () => {
      throw new Error('reclaimed worker must use checkpoint lexicon');
    });
    const reclaimed = new SalesAgentRuntime({ lexicon: { read: reclaimedRead } });
    const hypothesis = await reclaimed.deriveHypothesis(currentSignal, checkpointContext);

    expect(hypothesis.intent).toBe('product_search');
    expect(hypothesis.metadata).toEqual({ lexicon_source: 'tenant' });
    expect(reclaimedRead).not.toHaveBeenCalled();
    expect(checkpointContext.run_state?.sales?.lexicon).toMatchObject({
      product_search: ['checkpoint-only-term'],
    });
  });
  it('extracts catalog SKUs and plans stock and price checks for direct SKU questions', async () => {
    const customerContext: HydratedContext = {
      ...createContext(),
      customer: {
        customer_id: 'customer-sales-1',
        tenant_id,
        verified_phone: null,
        verified_email: null,
        total_spent: 0,
        order_count: 0,
        rfm_segment_hypothesis: 'LOYAL',
        consent_marketing: true,
        consent_updated_at: null,
        suppression_active: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const rows: Record<string, SkillRegistryRowMetadata> = {
      'skill.sales.check_stock': {
        skill_id: 'skill.sales.check_stock',
        effect_class: 'READ',
        guarded_dependency: 'API-001.InventoryConnector',
        required_authority: 'AUTH-0',
        timeout_ms: 1000,
        enabled: true,
        allowed_agents: ['SAL-02'],
      },
      'skill.sales.check_price': {
        skill_id: 'skill.sales.check_price',
        effect_class: 'READ',
        guarded_dependency: 'API-001.PricingEngine',
        required_authority: 'AUTH-3',
        timeout_ms: 1000,
        enabled: true,
        allowed_agents: ['SAL-02'],
      },
    };
    const registry = {
      get(skill_id: string) {
        return rows[skill_id] ?? null;
      },
    };
    const currentSignal = signal('NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const runtime = new SalesAgentRuntime({ registry });

    expect(extractSku('NM-L01-BLK còn hàng không, giá bao nhiêu?')).toBe('NM-L01-BLK');
    const hypothesis = await runtime.deriveHypothesis(currentSignal, customerContext);
    expect(hypothesis.intent).toBe('sku_stock_price');

    const routing = await runtime.resolveRouting(currentSignal, customerContext, hypothesis);
    expect(routing.requires_clarification).toBe(false);
    const plan = await runtime.formulatePlan(routing, customerContext, hypothesis);
    expect(plan.steps.map((step) => step.skill_id)).toEqual([
      'skill.sales.check_stock',
      'skill.sales.check_price',
    ]);
    expect(plan.steps.map((step) => step.input_parameters)).toEqual([
      { tenant_id, sku_id: 'NM-L01-BLK' },
      { tenant_id, sku_id: 'NM-L01-BLK', customer_id: 'customer-sales-1' },
    ]);
  });

  it('routes a vague greeting to the approved clarification template', async () => {
    const currentSignal = signal('hi');
    const runtime = new SalesAgentRuntime();
    const runContext = createContext();
    const hypothesis = await runtime.deriveHypothesis(currentSignal, runContext);
    const routing = await runtime.resolveRouting(currentSignal, runContext, hypothesis);

    expect(hypothesis.intent).toBe('unknown');
    expect(routing.requires_clarification).toBe(true);
    expect(routing.clarification_template_key).toBe('sales.need_more_detail');
    expect(routing.clarification_reason_code).toBe('SALES_INTENT_UNCLEAR');
  });

});

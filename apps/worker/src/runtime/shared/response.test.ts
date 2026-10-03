import { renderResponseTemplate, TEMPLATE_SOURCE } from '@agentos/core-engine';
import { describe, expect, it, vi } from 'vitest';
import type { RunResponseRecord } from '@agentos/database';
import type {
  ExecutionReceipt,
  FinalResponse,
  HydratedContext,
  ImmutableEvidenceRecord,
  RunResponseSource,
} from '@agentos/core-engine/contracts';

import {
  RunResponseStoreAdapter,
  VerifiedResponseFinalizer,
} from './response.js';
import { computeQuoteToken } from '../sales/skills/quote-payment-guards.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const RUN = 'run-response-test';
const QUOTE_SECRET = 'response-test-quote-signing-secret';
const PAYLOAD_SHA = 'a'.repeat(64);
const NOW = new Date('2026-09-28T00:00:00.000Z');

function context(customer = true): HydratedContext {
  return {
    tenant_id: TENANT,
    correlation_id: 'correlation-1',
    customer: customer ? {
      customer_id: 'customer-1',
      tenant_id: TENANT,
      verified_phone: null,
      verified_email: null,
      total_spent: 0,
      order_count: 0,
      rfm_segment_hypothesis: 'HIBERNATING',
      consent_marketing: true,
      consent_updated_at: null,
      suppression_active: false,
      created_at: NOW.toISOString(),
    } : null,
    working_memory: {
      session_id: 'session-1',
      conversation_id: 'conversation-1',
      last_touch_channel: 'WEB_CHAT',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: NOW.toISOString(),
  };
}

interface VerifiedFixture {
  readonly evidence: ImmutableEvidenceRecord;
  readonly receipt: ExecutionReceipt;
}

function verified(payload: Record<string, unknown>, step = 1): VerifiedFixture {
  const receipt: ExecutionReceipt = {
    execution_id: `execution-${step}`,
    adapter_status: 'SUCCESS',
    provider_reference: `provider-${step}`,
    response_payload: payload,
    latency_ms: 10,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
  const evidence: ImmutableEvidenceRecord = {
    evidence_id: `evidence-${step}`,
    run_id: RUN,
    tenant_id: TENANT,
    correlation_id: 'correlation-1',
    step_index: step,
    effect_key: `effect-${step}`,
    previous_evidence_hash: 'b'.repeat(64),
    payload_sha256: PAYLOAD_SHA,
    chain_hash: 'c'.repeat(64),
    signature: 'd'.repeat(64),
    created_at: NOW.toISOString(),
    receipt,
  };
  return { evidence, receipt };
}

function input(
  domain: 'support' | 'sales' | 'marketing',
  successful_receipts: VerifiedFixture[],
  customer = true,
  terminal_response?: FinalResponse,
) {
  return {
    tenant_id: TENANT,
    run_id: RUN,
    conversation_id: 'conversation-1',
    domain,
    context: context(customer),
    successful_receipts,
    ...(terminal_response === undefined ? {} : { terminal_response }),
  };
}

describe('VerifiedResponseFinalizer', () => {
  it('returns a structured answer only with an approved source citation', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input(
      'support',
      [verified({
        answer: 'Returns are accepted within 14 days when unopened.',
        source_file: 'customer-care/faq.md',
        source_record_id: 'FAQ-1',
        source_version: 'novamart-demo-v1',
      })],
    ));

    expect(result).toEqual({
      response_kind: 'ANSWER',
      text: 'Returns are accepted within 14 days when unopened.',
      source: 'Core.Evidence@1',
      sources: [{
        source_record_id: 'FAQ-1',
        source_version: 'novamart-demo-v1',
        source_file: 'customer-care/faq.md',
      }],
    });
  });

  it('uses the approved FAQ answer with its approved file SHA-256 version', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input(
      'support',
      [verified({
        answers: [{
          faq_id: 'FAQ-1',
          approved_answer: 'Unopened items may be returned within 14 days.',
          source_file: 'customer-care/faq.md',
        }],
        match_confidence: 1,
        source_version: 'e'.repeat(64),
      })],
    ));

    expect(result.text).toBe('Unopened items may be returned within 14 days.');
    expect(result.sources[0]).toEqual({
      source_record_id: 'FAQ-1',
      source_version: 'e'.repeat(64),
      source_file: 'customer-care/faq.md',
    });
  });
  it('accepts a database FAQ citation for its namespace/slug and document SHA-256', async () => {
    const version = 'f'.repeat(64);
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input(
      'support',
      [verified({
        answers: [{
          faq_id: 'FAQ-1',
          approved_answer: 'Unopened items may be returned within 14 days.',
          source_file: 'customer-care/stack-return-policy',
        }],
        match_confidence: 1,
        source_version: version,
      })],
    ));

    expect(result.sources).toEqual([{
      source_record_id: 'FAQ-1',
      source_version: version,
      source_file: 'customer-care/stack-return-policy',
    }]);
  });
  it('returns a typed no-answer template after a verified FAQ miss', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [
      verified({ answers: [], match_confidence: 0, source_version: PAYLOAD_SHA }),
    ]));
    const rendered = renderResponseTemplate('care.faq_no_answer_offer_handoff');

    expect(result).toEqual({
      response_kind: 'NO_ANSWER',
      text: rendered.text,
      source: TEMPLATE_SOURCE,
      template_key: 'care.faq_no_answer_offer_handoff',
      reason_code: 'CARE_FAQ_NO_ANSWER',
      sources: [],
    });
  });

  it('accepts only approved template kinds without receipts; ANSWER still requires evidence', async () => {
    const rendered = renderResponseTemplate('sales.need_more_detail');
    const terminalResponse: FinalResponse = {
      response_kind: 'CLARIFICATION',
      ...rendered,
      reason_code: 'SALES_INTENT_UNCLEAR',
      sources: [],
    };
    const finalizer = new VerifiedResponseFinalizer(() => NOW);

    await expect(finalizer.finalize(input('sales', [], true, terminalResponse))).resolves.toEqual(terminalResponse);
    await expect(finalizer.finalize(input('sales', []))).rejects.toMatchObject({
      code: 'RESPONSE_EVIDENCE_MISSING',
    });
    await expect(finalizer.finalize(input('sales', [], true, {
      ...terminalResponse,
      text: 'Caller-supplied text',
    }))).rejects.toMatchObject({ code: 'RESPONSE_TEMPLATE_INVALID' });
  });
  it.each([
    ['CLARIFICATION', 'care.identity_required'],
    ['NO_ANSWER', 'care.faq_no_answer_offer_handoff'],
    ['HANDOFF_ACK', 'core.handoff_ack'],
  ] as const)('accepts receipt-free %s only from its registered template', async (response_kind, template_key) => {
    const response: FinalResponse = {
      response_kind,
      ...renderResponseTemplate(template_key),
      reason_code: 'TEST_TERMINAL_RESPONSE',
      sources: [],
    };

    await expect(new VerifiedResponseFinalizer(() => NOW).finalize(
      input('support', [], true, response),
    )).resolves.toEqual(response);
  });


  it('formats a verified private order status but refuses it without verified customer context', async () => {
    const receipt = verified({ order_id: 'ORD-DEMO-005', status: 'DELIVERED' });
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt]));
    expect(result.text).toBe('Tình trạng đơn hàng ORD-DEMO-005: Đã giao hàng.');
    expect(result.sources[0]?.source_file).toBe('API-001.OrderConnector');

    await expect(
      new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt], false)),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it('returns one approved no-answer for an owner-scoped order miss without exposing existence', async () => {
    const receipt = verified({ result: 'ORDER_NOT_FOUND' });
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt]));
    const rendered = renderResponseTemplate('care.order_not_found');

    expect(result).toEqual({
      response_kind: 'NO_ANSWER',
      text: rendered.text,
      source: TEMPLATE_SOURCE,
      template_key: 'care.order_not_found',
      reason_code: 'ORDER_NOT_FOUND',
      sources: [],
    });
    expect(result.text).not.toMatch(/ORD-|order id|does not exist|not yours/i);
    await expect(
      new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt], false)),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it.each([
    ['PENDING', 'Đang chờ xử lý'],
    ['PROCESSING', 'Đang xử lý'],
    ['SHIPPED', 'Đã gửi hàng'],
    ['DELIVERED', 'Đã giao hàng'],
    ['CANCELLED', 'Đã hủy'],
    ['RETURNED', 'Đã hoàn trả'],
  ])('renders verified %s orders using the approved Vietnamese status template', async (status, label) => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input(
      'support',
      [verified({ order_id: 'ORD-DEMO-005', status })],
    ));

    expect(result.text).toBe(`Tình trạng đơn hàng ORD-DEMO-005: ${label}.`);
    expect(result.text).not.toMatch(/\b(Order|status)\b/);
  });
  it('formats a non-expired signed sales quote and rejects expired or incomplete quotes', async () => {
    const quoteExpiresAt = '2026-09-28T00:15:00.000Z';
    const quote = verified({
      sku_id: 'NM-L01-BLK',
      list_price: 18_900_000,
      final_price: 18_900_000,
      p_floor: 18_900_000,
      currency: 'VND',
      quote_token: computeQuoteToken(QUOTE_SECRET, {
        tenant_id: TENANT,
        sku_id: 'NM-L01-BLK',
        customer_id: 'customer-1',
        final_price: 18_900_000,
        p_floor: 18_900_000,
        currency: 'VND',
        quote_expires_at: quoteExpiresAt,
      }),
      quote_expires_at: quoteExpiresAt,
    });
    const unsignedPrice = verified({
      sku_id: 'NM-L01-BLK', list_price: 18_900_000, final_price: 18_900_000,
      p_floor: 18_900_000, currency: 'VND',
    }, 2);
    const result = await new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [unsignedPrice, quote]));
    expect(result.text).toContain('NM-L01-BLK');
    expect(result.text).toContain('VND 18900000');
    expect(result.sources[0]?.source_file).toBe('API-001.PricingEngine');
    expect(result.text).toMatch(/^Quote for /);
    expect(result.text).not.toContain('Giá niêm yết');

    await expect(
      new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [verified({
        ...quote.receipt.response_payload,
        quote_expires_at: '2026-09-27T23:59:00.000Z',
      })])),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it('refuses a quote whose HMAC is invalid before exposing its amount', async () => {
    const quote = verified({
      sku_id: 'NM-L01-BLK',
      list_price: 100,
      final_price: 100,
      p_floor: 80,
      currency: 'VND',
      quote_token: '0'.repeat(64),
      quote_expires_at: '2026-09-28T00:15:00.000Z',
      customer_id: 'customer-1',
    });

    await expect(
      new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [quote])),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it('refuses a quote whose total differs from the verified cart subtotal', async () => {
    const quoteExpiresAt = '2026-09-28T00:15:00.000Z';
    const quote = verified({
      sku_id: 'NM-L01-BLK',
      list_price: 100,
      final_price: 100,
      p_floor: 80,
      currency: 'VND',
      quote_token: computeQuoteToken(QUOTE_SECRET, {
        tenant_id: TENANT,
        sku_id: 'NM-L01-BLK',
        customer_id: 'customer-1',
        final_price: 100,
        p_floor: 80,
        currency: 'VND',
        quote_expires_at: quoteExpiresAt,
      }),
      quote_expires_at: quoteExpiresAt,
      customer_id: 'customer-1',
    });
    const cart = verified({ cart_id: 'cart-1', subtotal: 125, currency: 'VND' }, 2);

    await expect(
      new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [quote, cart])),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it('escapes untrusted quote fields in the rendered answer', async () => {
    const quoteExpiresAt = '2026-09-28T00:15:00.000Z';
    const sku = '<img src=x onerror=alert(1)>';
    const quote = verified({
      sku_id: sku,
      list_price: 100,
      final_price: 100,
      p_floor: 80,
      currency: 'VND&',
      quote_token: computeQuoteToken(QUOTE_SECRET, {
        tenant_id: TENANT,
        sku_id: sku,
        customer_id: 'customer-1',
        final_price: 100,
        p_floor: 80,
        currency: 'VND&',
        quote_expires_at: quoteExpiresAt,
      }),
      quote_expires_at: quoteExpiresAt,
      customer_id: 'customer-1',
    });

    const result = await new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [quote]));
    expect(result.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.text).toContain('VND&amp; 100');
    expect(result.text).not.toContain('<img');
  });

  it('returns a stored marketing draft without claiming delivery', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('marketing', [verified({
      draft_id: 'draft-1',
      body_content: 'Nội dung bản nháp cho chiến dịch tái kích hoạt.',
    })]));

    expect(result.text).toBe('Nội dung bản nháp cho chiến dịch tái kích hoạt.');
    expect(result.sources[0]?.source_record_id).toBe('draft-1');
    expect(result.sources[0]?.source_file).toBe('Marketing.DraftReceipt');
    expect(result.text).not.toContain('sent');
  });

  it('refuses ungrounded receipts and mismatched immutable evidence', async () => {
    await expect(
      new VerifiedResponseFinalizer(() => NOW).finalize(input('sales', [verified({ status: 'SUCCESS' })])),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });

    const original = verified({
      answer: 'Untrusted',
      source_file: 'customer-care/faq.md',
    });
    const mismatched: VerifiedFixture = {
      receipt: original.receipt,
      evidence: {
        ...original.evidence,
        receipt: {
          ...original.receipt,
          response_payload: { answer: 'Different', source_file: 'customer-care/faq.md' },
        },
      },
    };
    await expect(
      new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [mismatched])),
    ).rejects.toMatchObject({ code: 'RESPONSE_EVIDENCE_INVALID' });
  });
});

describe('anonymous ERP list-price responses', () => {
  it('prefers the verified list price to stock without inventing a binding quote or discount', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('sales', [
      verified({ sku_id: 'NM-L01-BLK', available_quantity: 5 }, 1),
      verified({
        sku_id: 'NM-L01-BLK', list_price: 18_900_000, final_price: 18_000_000,
        p_floor: 17_000_000, discount_allowed: true, currency: 'VND',
      }, 2),
    ], false));
    expect(result.text).toBe(`Giá niêm yết ERP của NM-L01-BLK: ${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(18_900_000)}.`);
    expect(result.text).not.toContain('18000000');
    expect(result.text).not.toMatch(/quote|valid until/i);
    expect(result.sources).toEqual([{
      source_record_id: 'NM-L01-BLK', source_version: PAYLOAD_SHA, source_file: 'API-001.PricingEngine',
    }]);
  });

  it('does not expose a price from a failed receipt', async () => {
    const priced = verified({
      sku_id: 'NM-L01-BLK', list_price: 18_900_000, final_price: 18_900_000,
      p_floor: 18_900_000, currency: 'VND',
    });
    const receipt: ExecutionReceipt = { ...priced.receipt, adapter_status: 'ERROR' };
    await expect(new VerifiedResponseFinalizer(() => NOW).finalize(input('sales', [{
      receipt, evidence: { ...priced.evidence, receipt },
    }], false))).rejects.toMatchObject({ code: 'RESPONSE_EVIDENCE_INVALID' });
  });

  it.each([
    { list_price: undefined },
    { list_price: Number.NaN },
    { list_price: -1 },
    { currency: '' },
    { quote_token: 'invalid' },
    { quote_expires_at: '2026-09-27T00:00:00.000Z' },
  ])('refuses malformed prices and never downgrades a quote: %j', async (fields) => {
    await expect(new VerifiedResponseFinalizer(() => NOW).finalize(input('sales', [verified({
      sku_id: 'NM-L01-BLK', list_price: 18_900_000, final_price: 18_900_000,
      p_floor: 18_900_000, currency: 'VND', ...fields,
    })], false))).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });
});

describe('anonymous recommendation ERP prices', () => {
  function advisorInput(receipts: VerifiedFixture[]) {
    const value = input('sales', receipts, false);
    value.context.run_state = {
      sales: {
        advisor_requirements: {
          category: 'laptops',
          budget: { amount: 20_000_000, currency: 'VND' },
          use_case: 'graphic design',
        },
      },
    };
    return value;
  }

  it.each([undefined, 1, 99_999_999])('uses the matching ERP list price, not recommendation price %s', async (price) => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(advisorInput([
      verified({ sku_id: 'NM-L01-BLK', available_quantity: 5 }, 1),
      verified({
        sku_id: 'NM-L03-STD', list_price: 14_900_000, final_price: 14_900_000,
        p_floor: 14_900_000, currency: 'VND',
      }, 2),
      verified({
        sku_id: 'NM-L01-BLK', list_price: 18_900_000, final_price: 18_000_000,
        p_floor: 17_000_000, currency: 'VND',
      }, 3),
      verified({
        product: { sku: 'NM-L01-BLK', name: 'Nova Studio 14 Creator', price, currency: 'USD' },
        reason: 'Selected from authoritative ERP catalog and stock.',
        expected_outcome: null,
      }, 4),
    ]));
    expect(result.text).toBe(
      `Nova Studio 14 Creator (NM-L01-BLK) — Giá niêm yết ERP: ${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(18_900_000)}. Selected from authoritative ERP catalog and stock. Chưa có dữ liệu doanh thu.`,
    );
    const quote = /\((NM-[A-Z0-9-]+)\)\s*[—–-]\s*Giá niêm yết ERP:\s*(\d[\d,.]*\d|\d)\s*₫/.exec(result.text);
    expect(quote?.[1]).toBe('NM-L01-BLK');
    expect(Number(quote?.[2]?.replace(/[,.]/g, ''))).toBe(18_900_000);
    expect(result.text).not.toMatch(/USD|18000000|14900000|quote|valid until/i);
    expect(result.sources).toEqual([
      { source_record_id: 'NM-L01-BLK', source_version: PAYLOAD_SHA, source_file: 'Core.RecommendationEngine' },
      { source_record_id: 'NM-L01-BLK', source_version: PAYLOAD_SHA, source_file: 'API-001.PricingEngine' },
    ]);
  });

  it.each([
    {},
    { list_price: Number.NaN },
    { list_price: -1 },
    { list_price: 18_900_000, quote_token: 'invalid' },
    { list_price: 18_900_000, quote_expires_at: '2026-09-27T00:00:00.000Z' },
  ])('refuses advisor recommendation amounts without valid same-SKU price evidence: %j', async (fields) => {
    await expect(new VerifiedResponseFinalizer(() => NOW).finalize(advisorInput([
      verified({
        sku_id: 'NM-L01-BLK', final_price: 18_900_000,
        p_floor: 18_900_000, currency: 'VND', ...fields,
      }, 1),
      verified({
        product: { sku: 'NM-L01-BLK', name: 'Nova Studio 14 Creator', price: 18_900_000, currency: 'VND' },
        reason: 'Selected from catalog.',
        expected_outcome: null,
      }, 2),
    ]))).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });

  it('never attaches another SKU price to the recommended product', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(advisorInput([
      verified({
        sku_id: 'NM-L03-STD', list_price: 14_900_000, final_price: 14_900_000,
        p_floor: 14_900_000, currency: 'VND',
      }, 1),
      verified({
        product: { sku: 'NM-L01-BLK', name: 'Nova Studio 14 Creator', price: 1, currency: 'VND' },
        reason: 'Selected from catalog.',
        expected_outcome: null,
      }, 2),
    ]));
    expect(result.text).not.toContain('Nova Studio 14 Creator');
    expect(result.text).not.toContain('NM-L01-BLK');
    expect(result.sources[0]?.source_record_id).toBe('NM-L03-STD');
  });
});

describe('RunResponseStoreAdapter', () => {
  it('delegates one tenant-scoped save with the planner sender id and reads immutable content', async () => {
    const storedSources: readonly RunResponseSource[] = [{
      source_record_id: 'FAQ-1',
      source_version: PAYLOAD_SHA,
      source_file: 'customer-care/faq.md',
    }];
    const repository = {
      read: vi.fn(async () => ({
        tenant_id: TENANT,
        run_id: RUN,
        answer: 'Grounded answer',
        sources: storedSources,
        response_kind: 'ANSWER',
        outcome: 'ANSWERED',
        source: 'Core.Evidence@1',
        template_key: null,
        reason_code: null,
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        created_at: NOW.toISOString(),
      } as RunResponseRecord)),
      save: vi.fn(async () => ({
        tenant_id: TENANT,
        run_id: RUN,
        answer: 'Grounded answer',
        sources: storedSources,
        response_kind: 'ANSWER',
        outcome: 'ANSWERED',
        source: 'Core.Evidence@1',
        template_key: null,
        reason_code: null,
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        created_at: NOW.toISOString(),
      } as RunResponseRecord)),
    };
    const store = new RunResponseStoreAdapter(repository);
    const response: FinalResponse = {
      response_kind: 'ANSWER',
      text: 'Grounded answer',
      source: 'Core.Evidence@1',
      sources: storedSources,
    };

    await store.save({
      tenant_id: TENANT,
      run_id: RUN,
      conversation_id: 'conversation-1',
      sender_id: 'CS-01',
      outcome: 'ANSWERED',
      response,
    });
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT,
      run_id: RUN,
      sender_id: 'CS-01',
      conversation_id: 'conversation-1',
      answer: 'Grounded answer',
    }));

    await expect(store.read({ tenant_id: TENANT, run_id: RUN })).resolves.toEqual(response);
  });

  it('grounds a Sales availability answer in the authoritative inventory receipt', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input(
      'sales',
      [verified({ sku_id: 'NM-L01-BLK', available_quantity: 5, in_stock: true })],
    ));

    expect(result.text).toBe('NM-L01-BLK is available now — 5 in stock.');
    expect(result.sources).toEqual([{
      source_record_id: 'NM-L01-BLK',
      source_version: PAYLOAD_SHA,
      source_file: 'API-001.InventoryConnector',
    }]);
  });

  it('grounds a catalog answer in the verified search receipt and refuses an unsupported stock row', async () => {
    const finalizer = new VerifiedResponseFinalizer(() => NOW);

    const catalog = await finalizer.finalize(input('sales', [verified({
      products: [
        { sku: 'NM-L01-BLK', name: 'L01 Nova Studio 14 Creator', list_price: 18_900_000, currency: 'VND' },
        { sku: 'NM-L03-STD', name: 'L03 Nova Work 14', list_price: 14_900_000, currency: 'VND' },
      ],
      total_found: 2,
    })]));

    expect(catalog.text).toBe(
      'Catalog matches: L01 Nova Studio 14 Creator (NM-L01-BLK) — VND 18900000; L03 Nova Work 14 (NM-L03-STD) — VND 14900000.',
    );
    expect(catalog.sources[0]?.source_file).toBe('API-001.CatalogConnector');

    await expect(finalizer.finalize(input('sales', [
      verified({ sku_id: 'NM-L01-BLK', available_quantity: -1 }),
    ]))).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });
});

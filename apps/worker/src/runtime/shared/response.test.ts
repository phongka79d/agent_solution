import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionReceipt,
  HydratedContext,
  ImmutableEvidenceRecord,
  RunResponseSource,
} from '@agentos/core-engine/contracts';
import type { RunResponseRecord } from '@agentos/database';

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
) {
  return {
    tenant_id: TENANT,
    run_id: RUN,
    conversation_id: 'conversation-1',
    domain,
    context: context(customer),
    successful_receipts,
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
      answer: 'Returns are accepted within 14 days when unopened.',
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

    expect(result.answer).toBe('Unopened items may be returned within 14 days.');
    expect(result.sources[0]).toEqual({
      source_record_id: 'FAQ-1',
      source_version: 'e'.repeat(64),
      source_file: 'customer-care/faq.md',
    });
  });

  it('formats a verified private order status but refuses it without verified customer context', async () => {
    const receipt = verified({ order_id: 'ORD-DEMO-005', status: 'DELIVERED' });
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt]));
    expect(result.answer).toBe('Order ORD-DEMO-005 status: DELIVERED.');
    expect(result.sources[0]?.source_file).toBe('API-001.OrderConnector');

    await expect(
      new VerifiedResponseFinalizer(() => NOW).finalize(input('support', [receipt], false)),
    ).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
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
    const result = await new VerifiedResponseFinalizer(() => NOW, QUOTE_SECRET).finalize(input('sales', [quote]));
    expect(result.answer).toContain('NM-L01-BLK');
    expect(result.answer).toContain('VND 18900000');
    expect(result.sources[0]?.source_file).toBe('API-001.PricingEngine');

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
    expect(result.answer).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.answer).toContain('VND&amp; 100');
    expect(result.answer).not.toContain('<img');
  });

  it('returns a stored marketing draft without claiming delivery', async () => {
    const result = await new VerifiedResponseFinalizer(() => NOW).finalize(input('marketing', [verified({
      draft_id: 'draft-1',
      body_content: 'Nội dung bản nháp cho chiến dịch tái kích hoạt.',
    })]));

    expect(result.answer).toBe('Nội dung bản nháp cho chiến dịch tái kích hoạt.');
    expect(result.sources[0]?.source_record_id).toBe('draft-1');
    expect(result.sources[0]?.source_file).toBe('Marketing.DraftReceipt');
    expect(result.answer).not.toContain('sent');
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
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        created_at: NOW.toISOString(),
      } as RunResponseRecord)),
      save: vi.fn(async () => ({
        tenant_id: TENANT,
        run_id: RUN,
        answer: 'Grounded answer',
        sources: storedSources,
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        created_at: NOW.toISOString(),
      } as RunResponseRecord)),
    };
    const store = new RunResponseStoreAdapter(repository);
    const response = { answer: 'Grounded answer', sources: storedSources };

    await store.save({
      tenant_id: TENANT,
      run_id: RUN,
      conversation_id: 'conversation-1',
      sender_id: 'CS-01',
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

    expect(result.answer).toBe('NM-L01-BLK is available now — 5 in stock.');
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

    expect(catalog.answer).toBe(
      'Catalog matches: L01 Nova Studio 14 Creator (NM-L01-BLK) — VND 18900000; L03 Nova Work 14 (NM-L03-STD) — VND 14900000.',
    );
    expect(catalog.sources[0]?.source_file).toBe('API-001.CatalogConnector');

    await expect(finalizer.finalize(input('sales', [
      verified({ sku_id: 'NM-L01-BLK', available_quantity: -1 }),
    ]))).rejects.toMatchObject({ code: 'RESPONSE_UNGROUNDED' });
  });
});

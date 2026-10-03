import { describe, expect, it, vi } from 'vitest';
import type { SignalSubject } from '@agentos/core-engine/contracts';
import type { ConversationRecord, CustomerEventTimeline, CustomerProfileRow } from '@agentos/database';

import { SalesContextAggregator } from './context-aggregator.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CORRELATION_ID = 'corr-sales-1';
const NOW = new Date('2026-09-24T10:00:00.000Z');

const subject = (verified_customer_id?: string, conversation_id?: string): SignalSubject => ({
  session_id: 'session-1',
  channel_type: 'web',
  channel_identifier: 'session-1',
  ...(verified_customer_id === undefined ? {} : { verified_customer_id }),
  ...(conversation_id === undefined ? {} : { conversation_id }),
});

const profile = (overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow => ({
  customer_id: CUSTOMER_ID,
  tenant_id: TENANT_ID,
  verified_phone: null,
  verified_email: null,
  total_spent: '120.50',
  order_count: 2,
  rfm_segment_hypothesis: 'LOYAL',
  consent_marketing: true,
  consent_updated_at: new Date('2026-01-01T00:00:00.000Z'),
  suppression_active: false,
  line_user_id: null,
  created_at: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
});

const timeline: CustomerEventTimeline = {
  items: [{
    event_id: 'event-verified-1',
    source_event_id: 'web:event-1',
    event_name: 'product_view',
    session_id: 'session-1',
    channel: 'web',
    occurred_at: '2026-09-24T09:00:00.000Z',
    payload: { category: 'accessories' },
  }],
  next_cursor: null,
};

describe('SalesContextAggregator', () => {
  it('hydrates only the gateway-bound customer profile and durable timeline', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({
      repositories: { getProfile, listTimeline },
      now: () => NOW,
    });

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);

    expect(getProfile).toHaveBeenCalledOnce();
    expect(getProfile).toHaveBeenCalledWith(TENANT_ID, CUSTOMER_ID);
    expect(listTimeline).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      limit: 100,
    });
    expect(context.customer).toMatchObject({ customer_id: CUSTOMER_ID, tenant_id: TENANT_ID, total_spent: 120.5 });
    expect(aggregator.verifiedCustomerFor(context)).toEqual(context.customer);
    expect(aggregator.verifiedTimelineFor(context)?.items[0]?.event_id).toBe('event-verified-1');
  });
  it('carries only a valid default shipping address from the verified customer profile', async () => {
    const defaultShippingAddress = {
      recipient_name: 'Test Buyer',
      phone: '+15551234567',
      postal_code: '10001',
      city: 'Metro',
      district: 'Central',
      address_line1: '10 Main Street',
    };
    const aggregator = new SalesContextAggregator({
      repositories: {
        getProfile: async () => profile({ default_shipping_address: defaultShippingAddress }),
        listTimeline: async () => timeline,
      },
    });

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'order-address-corr');
    expect(context.run_state?.sales?.default_shipping_address).toEqual(defaultShippingAddress);

    const malformedAggregator = new SalesContextAggregator({
      repositories: {
        getProfile: async () => profile({
          default_shipping_address: { ...defaultShippingAddress, unexpected: 'untrusted' },
        }),
        listTimeline: async () => timeline,
      },
    });
    const malformedContext = await malformedAggregator.hydrateContext(
      TENANT_ID,
      subject(CUSTOMER_ID),
      'order-address-malformed-corr',
    );
    expect(malformedContext.run_state?.sales?.default_shipping_address).toBeUndefined();
  });
  it('rehydrates verified customer, timeline, and takeover from checkpoint context in a fresh instance', async () => {
    const original = new SalesContextAggregator({
      repositories: { getProfile: async () => profile(), listTimeline: async () => timeline },
      sessionControl: { isTakenOver: async () => true },
    });
    const context = await original.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);
    const checkpointContext = JSON.parse(JSON.stringify(context)) as typeof context;
    const reclaimed = new SalesContextAggregator();

    expect(reclaimed.verifiedCustomerFor(checkpointContext)).toEqual(context.customer);
    expect(reclaimed.verifiedTimelineFor(checkpointContext)?.items[0]?.event_id).toBe('event-verified-1');
    expect(reclaimed.takeoverActiveFor(checkpointContext)).toBe(true);
  });

  it('leaves anonymous subjects empty and rejects malformed verified customer ids', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    const anonymous = await aggregator.hydrateContext(TENANT_ID, subject(), 'anonymous-corr');
    await expect(aggregator.hydrateContext(TENANT_ID, subject('not-a-customer-uuid'), 'malformed-corr'))
      .rejects.toMatchObject({ code: 'SUBJECT_BINDING_MISMATCH' });

    expect(anonymous.customer).toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it('rejects a missing or foreign-tenant verified profile without loading its timeline', async () => {
    const getProfile = vi.fn(async () => profile({ tenant_id: OTHER_TENANT_ID }));
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    await expect(aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'foreign-corr'))
      .rejects.toMatchObject({ code: 'SUBJECT_BINDING_MISMATCH' });
    expect(listTimeline).not.toHaveBeenCalled();
  });
  it('keeps hydrated customer state isolated between tenants', async () => {
    const aggregator = new SalesContextAggregator({
      repositories: {
        getProfile: async (tenant_id) => profile({
          tenant_id,
          customer_id: tenant_id === TENANT_ID ? CUSTOMER_ID : 'bbbbbbbb-0000-4000-8000-00000000000b',
        }),
        listTimeline: async () => timeline,
      },
    });

    const firstContext = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);
    const secondContext = await aggregator.hydrateContext(
      OTHER_TENANT_ID,
      subject('bbbbbbbb-0000-4000-8000-00000000000b'),
      CORRELATION_ID,
    );

    expect(aggregator.verifiedCustomerFor(firstContext)?.customer_id).toBe(CUSTOMER_ID);
    expect(aggregator.verifiedCustomerFor(secondContext)?.customer_id)
      .toBe('bbbbbbbb-0000-4000-8000-00000000000b');
  });


  it('propagates profile retrieval failures without exposing partial context', async () => {
    const getProfile = vi.fn(async () => { throw new Error('private DB error'); });
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    await expect(aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'failed-corr'))
      .rejects.toThrow('private DB error');
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it('reports real takeover value and empty unbound when sessionControl port is bound', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const isTakenOver = vi.fn(async (_tenantId: string, _sessionId: string) => false);
    const aggregator = new SalesContextAggregator({
      repositories: { getProfile, listTimeline },
      sessionControl: { isTakenOver },
    });

    expect(aggregator.unbound).toEqual([]);

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);
    expect(isTakenOver).toHaveBeenCalledWith(TENANT_ID, 'session-1');
    expect(context.working_memory.takeover_active).toBe(false);
    expect(aggregator.takeoverActiveFor(context)).toBe(false);

    // When session is taken over, reports true
    isTakenOver.mockResolvedValueOnce(true);
    const takenOverContext = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'corr-taken-over');
    expect(takenOverContext.working_memory.takeover_active).toBe(true);
    expect(aggregator.takeoverActiveFor(takenOverContext)).toBe(true);
  });

  it('fails closed with takeover_active true and records unbound capability when sessionControl is not bound', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({
      repositories: { getProfile, listTimeline },
    });

    expect(aggregator.unbound.some((cap) => cap.includes('sessionControl'))).toBe(true);

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);
    expect(context.working_memory.takeover_active).toBe(true);
    expect(aggregator.takeoverActiveFor(context)).toBe(true);
  });

  it('fails closed with takeover_active true when bound sessionControl check throws', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const isTakenOver = vi.fn(async () => {
      throw new Error('redis timeout');
    });
    const aggregator = new SalesContextAggregator({
      repositories: { getProfile, listTimeline },
      sessionControl: { isTakenOver },
    });

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);
    expect(context.working_memory.takeover_active).toBe(true);
  });

  describe('createPurchaseEvidencePort', () => {
    it('adapts customer event timeline purchase rows into typed VerifiedPurchaseEvidence', async () => {
      const purchaseTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-view-1',
            source_event_id: 'src-view-1',
            event_name: 'product_view',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-09-24T08:00:00.000Z',
            payload: { category: 'accessories' },
          },
          {
            event_id: 'evt-order-1',
            source_event_id: 'src-order-1',
            event_name: 'order_placed',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-08-01T12:00:00.000Z',
            payload: {
              order_id: 'ORD-PRIOR-999',
              order_date: '2026-08-01T12:00:00.000Z',
              sku_ids: ['SKU-RUN-456'],
              quantity: 2,
              total_amount: 120,
              currency: 'USD',
            },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => purchaseTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      const purchases = await port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID });

      expect(listTimeline).toHaveBeenCalledWith({
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        limit: 100,
      });
      expect(purchases).toHaveLength(1);
      expect(purchases[0]).toEqual({
        order_id: 'ORD-PRIOR-999',
        order_date: '2026-08-01T12:00:00.000Z',
        items: ['SKU-RUN-456'],
        sku_ids: ['SKU-RUN-456'],
        quantity: 2,
        total_amount: 120,
        currency: 'USD',
      });
    });

    it('rejects the read when timeline contains only non-purchase events (never a silently empty read)', async () => {
      const nonPurchaseTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-view-1',
            source_event_id: 'src-view-1',
            event_name: 'product_view',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-09-24T08:00:00.000Z',
            payload: { category: 'accessories' },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => nonPurchaseTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      await expect(port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID })).rejects.toThrow(
        'purchase evidence missing or stale: purchase evidence missing',
      );
    });

    it('rejects the read when a purchase-shaped row is malformed (missing order_id)', async () => {
      const malformedTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-order-bad',
            source_event_id: 'src-order-bad',
            event_name: 'purchase',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-08-01T12:00:00.000Z',
            payload: {
              // order_id missing
              order_date: '2026-08-01T12:00:00.000Z',
            },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => malformedTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      await expect(port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID })).rejects.toThrow(
        'purchase evidence missing or stale: purchase evidence missing',
      );
    });

    it('rejects the read when a purchase-shaped row has an invalid ISO timestamp', async () => {
      const malformedTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-order-bad-date',
            source_event_id: 'src-order-bad-date',
            event_name: 'order_placed',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: 'not-a-valid-iso-date',
            payload: {
              order_id: 'ORD-VALID-1',
              order_date: 'not-a-valid-iso-date',
            },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => malformedTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      await expect(port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID })).rejects.toThrow(
        'purchase evidence missing or stale: purchase evidence missing',
      );
    });

    it('skips SKU-bearing non-purchase events without fabricating purchase evidence', async () => {
      const mixedTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-view-sku',
            source_event_id: 'src-view-sku',
            event_name: 'product_view',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-09-24T08:00:00.000Z',
            payload: { sku_id: 'SKU-BROWSE-1', sku_ids: ['SKU-BROWSE-1'] },
          },
          {
            event_id: 'evt-order-1',
            source_event_id: 'src-order-1',
            event_name: 'order_placed',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-08-01T12:00:00.000Z',
            payload: {
              order_id: 'ORD-GENUINE-1',
              order_date: '2026-08-01T12:00:00.000Z',
              sku_ids: ['SKU-BOUGHT-1'],
            },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => mixedTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      const purchases = await port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID });

      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.order_id).toBe('ORD-GENUINE-1');
      expect(purchases[0]?.order_date).toBe('2026-08-01T12:00:00.000Z');
      expect(purchases[0]?.sku_ids).toEqual(['SKU-BOUGHT-1']);
    });

    it('rejects the read when timeline contains only SKU-bearing non-purchase events', async () => {
      const skuOnlyTimeline: CustomerEventTimeline = {
        items: [
          {
            event_id: 'evt-view-sku',
            source_event_id: 'src-view-sku',
            event_name: 'product_view',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-09-24T08:00:00.000Z',
            payload: { sku_id: 'SKU-BROWSE-1' },
          },
          {
            event_id: 'evt-click-sku',
            source_event_id: 'src-click-sku',
            event_name: 'search_click',
            session_id: 'sess-1',
            channel: 'web',
            occurred_at: '2026-09-24T08:05:00.000Z',
            payload: { sku_ids: ['SKU-BROWSE-2'] },
          },
        ],
        next_cursor: null,
      };

      const listTimeline = vi.fn(async () => skuOnlyTimeline);
      const aggregator = new SalesContextAggregator({
        repositories: { listTimeline },
      });

      const port = aggregator.createPurchaseEvidencePort();
      await expect(port.read({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID })).rejects.toThrow(
        'purchase evidence missing or stale: purchase evidence missing',
      );
    });
  });

  it('carries only the verified gateway conversation into working memory', async () => {
    const conversation_id = '33333333-3333-4333-8333-333333333333';
    const conversation: ConversationRecord = {
      conversation_id,
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      channel: 'web',
      external_thread_id: 'session-1',
      active_agent: 'CS-01',
      state: 'open',
      takeover_operator_id: null,
      last_message_at: '2026-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const aggregator = new SalesContextAggregator({
      repositories: {
        getProfile: vi.fn(async () => profile()),
        getConversation: vi.fn(async () => conversation),
        listTimeline: async () => timeline,
      },
    });

    const bound = await aggregator.hydrateContext(
      TENANT_ID,
      subject(CUSTOMER_ID, conversation_id),
      'conversation-corr',
    );
    expect(bound.working_memory.conversation_id).toBe(conversation_id);

    const unbound = await aggregator.hydrateContext(TENANT_ID, subject(), 'session-only-corr');
    expect(unbound.working_memory.conversation_id).toBeUndefined();
  });
});

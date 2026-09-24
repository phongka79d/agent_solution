import { describe, expect, it, vi } from 'vitest';
import type { SignalSubject } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline, CustomerProfileRow } from '@agentos/database';

import { SalesContextAggregator } from './context-aggregator.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CORRELATION_ID = 'corr-sales-1';
const NOW = new Date('2026-09-24T10:00:00.000Z');

const subject = (verified_customer_id?: string): SignalSubject => ({
  session_id: 'session-1',
  channel_type: 'web',
  ...(verified_customer_id === undefined ? {} : { verified_customer_id }),
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
    expect(aggregator.verifiedCustomerFor(TENANT_ID, CORRELATION_ID)).toEqual(context.customer);
    expect(aggregator.verifiedTimelineFor(TENANT_ID, CORRELATION_ID)?.items[0]?.event_id).toBe('event-verified-1');
  });

  it('does not query profile or timeline when identity is absent or malformed', async () => {
    const getProfile = vi.fn(async () => profile());
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    const anonymous = await aggregator.hydrateContext(TENANT_ID, subject(), 'anonymous-corr');
    const malformed = await aggregator.hydrateContext(TENANT_ID, subject('not-a-customer-uuid'), 'malformed-corr');

    expect(anonymous.customer).toBeNull();
    expect(malformed.customer).toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it('does not disclose a missing or foreign-tenant profile and never loads its timeline', async () => {
    const getProfile = vi.fn(async () => profile({ tenant_id: OTHER_TENANT_ID }));
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'foreign-corr');

    expect(context.customer).toBeNull();
    expect(aggregator.verifiedCustomerFor(TENANT_ID, 'foreign-corr')).toBeNull();
    expect(aggregator.verifiedTimelineFor(TENANT_ID, 'foreign-corr')).toBeNull();
    expect(listTimeline).not.toHaveBeenCalled();
  });

  it('does not cross tenants when retrieving a hydrated correlation', async () => {
    const aggregator = new SalesContextAggregator({
      repositories: { getProfile: async () => profile(), listTimeline: async () => timeline },
    });

    await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), CORRELATION_ID);

    expect(aggregator.verifiedCustomerFor(OTHER_TENANT_ID, CORRELATION_ID)).toBeNull();
    expect(aggregator.verifiedTimelineFor(OTHER_TENANT_ID, CORRELATION_ID)).toBeNull();
  });

  it('fails closed when profile retrieval fails', async () => {
    const getProfile = vi.fn(async () => { throw new Error('private DB error'); });
    const listTimeline = vi.fn(async () => timeline);
    const aggregator = new SalesContextAggregator({ repositories: { getProfile, listTimeline } });

    const context = await aggregator.hydrateContext(TENANT_ID, subject(CUSTOMER_ID), 'failed-corr');

    expect(context.customer).toBeNull();
    expect(listTimeline).not.toHaveBeenCalled();
  });
});

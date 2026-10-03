import { describe, expect, it } from 'vitest';

import type { CompanyCrmCustomerProfileRow } from '@agentos/database';
import {
  mergeCustomerTimeline,
  normalizeClassification,
  normalizeDataClass,
  toCustomerListItem,
  toCustomerProfile,
} from './customers.js';

const row: CompanyCrmCustomerProfileRow = {
  customer_id: 'customer-1',
  tenant_id: 'tenant-1',
  display_name: 'Customer',
  customer_tier: 'standard',
  verification_status: 'verified',
  created_at: '2026-01-01T00:00:00.000Z',
  verified_phone: '+886912345678',
  verified_email: 'alice@example.com',
  total_spent: '10.00',
  order_count: 1,
  rfm_segment_hypothesis: 'NEW',
  consent_marketing: false,
  suppression_active: false,
  identities: [{ channel_type: 'email', channel_identifier: 'alice@example.com', is_primary: true, verified_at: null }],
  orders: [],
  conversations: [],
  campaign_engagement: [],
  recommendations: [{
    recommendation_id: 'rec-1',
    recommendation_type: 'cross_sell',
    reason: 'derived',
    evidence: { classification: 'UNKNOWN' },
    confidence: '0.8',
    expected_outcome: {},
    status: 'proposed',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-02-01T00:00:00.000Z',
  }],
  service_cases: [],
};

describe('customer projection', () => {
  it('masks identities and labels recommendations as hypotheses', () => {
    const output = toCustomerProfile(row);
    expect(output.email).toBe('a***@e***.com');
    expect(output.phone).toBe('***5678');
    expect(output.identities[0]?.value).toBe('a***@e***.com');
    expect(output.recommendations[0]?.classification).toBe('HYPOTHESIS');

  });

  it('labels an absent stored data class as PRODUCTION and keeps a stored one', () => {
    expect(toCustomerProfile(row).data_class).toBe('PRODUCTION');
    expect(normalizeDataClass('PRODUCTION')).toBe('PRODUCTION');
    expect(normalizeDataClass('demo')).toBe('DEMO');
    expect(normalizeDataClass('WEIRD')).toBe('WEIRD');
    const stored: CompanyCrmCustomerProfileRow = { ...row, data_class: 'TEST' };
    expect(toCustomerListItem(stored).data_class).toBe('TEST');
    expect(toCustomerProfile(stored).data_class).toBe('TEST');
  });

  it('maps unknown classifications to UNCLASSIFIED', () => {
    expect(normalizeClassification('UNKNOWN')).toBe('UNCLASSIFIED');
    expect(normalizeClassification(undefined)).toBe('UNCLASSIFIED');
  });
});

describe('merged customer timeline', () => {
  const timeline = mergeCustomerTimeline({
    events: [{ event_id: 'evt-1', event_type: 'purchase', occurred_at: '2026-01-03T00:00:00.000Z', classification: 'SIGNAL', summary: 'Đã mua hàng' }],
    conversations: [{ conversation_id: 'conv-1', channel: 'WEB_CHAT', state: 'OPEN', last_message_at: '2026-01-02T00:00:00.000Z' }],
    orders: [{ order_id: 'order-1', order_number: 'SO-1001', status: 'PAID', total_amount: '120.00', created_at: '2026-01-04T00:00:00.000Z' }],
    campaign_engagement: [{ outcome_id: 'outcome-1', campaign_id: 'camp-1', conversion_type: 'purchase', recorded_at: '2026-01-01T00:00:00.000Z' }],
    service_cases: [{ case_id: 'case-1', subject: 'Giao trễ', status: 'OPEN', classification: 'UNKNOWN', created_at: 'not-a-date' }],
  });

  it('merges the five sources newest first and keeps each source class', () => {
    expect(timeline.map((item) => item.kind)).toEqual([
      'ORDER',
      'EVENT',
      'CONVERSATION',
      'CAMPAIGN_ENGAGEMENT',
      'SERVICE_CASE',
    ]);
    expect(timeline[0]?.classification).toBe('FACT');
    expect(timeline[1]?.classification).toBe('SIGNAL');
    expect(timeline[2]?.classification).toBe('UNCLASSIFIED');
    expect(timeline[3]?.classification).toBe('FACT');
    expect(timeline[4]?.classification).toBe('UNCLASSIFIED');
  });

  it('keeps an unusable timestamp explicit instead of inventing an instant', () => {
    expect(timeline[4]?.occurred_at).toBeNull();
    expect(timeline[4]?.item_id).toBe('case-1');
    expect(timeline[1]?.summary).toBe('Đã mua hàng');
  });

  it('returns an empty chronology when no source has rows', () => {
    expect(mergeCustomerTimeline({})).toEqual([]);
  });
});

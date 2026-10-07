import { describe, expect, it } from 'vitest';

import type { CompanyCrmCustomerProfileRow } from '@agentos/database';
import { normalizeClassification, toCustomerProfile } from './customers.js';

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

  it('maps unknown classifications to UNCLASSIFIED', () => {
    expect(normalizeClassification('UNKNOWN')).toBe('UNCLASSIFIED');
    expect(normalizeClassification(undefined)).toBe('UNCLASSIFIED');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { CustomerProfileRow } from '@agentos/database';

import { createSalesConsentPort } from './consent-adapter.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '99000000-0000-4000-8000-000000000005';

function profile(overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow {
  return {
    customer_id: CUSTOMER,
    tenant_id: TENANT,
    verified_phone: null,
    verified_email: null,
    total_spent: '120.00',
    order_count: 1,
    rfm_segment_hypothesis: 'GOLD',
    consent_marketing: true,
    consent_updated_at: new Date('2026-01-01T00:00:00.000Z'),
    suppression_active: false,
    line_user_id: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createSalesConsentPort', () => {
  it('answers the customer-level consent the policy gate reads', async () => {
    const port = createSalesConsentPort({ getProfileFn: vi.fn(async () => profile()) });

    await expect(port.getConsent({ tenant_id: TENANT, customer_id: CUSTOMER })).resolves.toEqual({
      consent_marketing: true,
      suppression_active: false,
    });
  });

  it('refuses an unknown, foreign, revoked or suppressed customer instead of assuming consent', async () => {
    const unknown = createSalesConsentPort({ getProfileFn: vi.fn(async () => null) });
    await expect(unknown.getConsent({ tenant_id: TENANT, customer_id: CUSTOMER })).resolves.toBeUndefined();
    await expect(unknown.read({ tenant_id: TENANT, customer_id: CUSTOMER, channel: 'WEB_CHAT' })).resolves.toMatchObject({
      consented: false,
      reason: 'IDENTITY_UNVERIFIED',
    });

    const foreign = createSalesConsentPort({ getProfileFn: vi.fn(async () => profile({ tenant_id: OTHER_TENANT })) });
    await expect(foreign.getConsent({ tenant_id: TENANT, customer_id: CUSTOMER })).resolves.toBeUndefined();

    const revoked = createSalesConsentPort({ getProfileFn: vi.fn(async () => profile({ consent_marketing: false })) });
    await expect(revoked.read({ tenant_id: TENANT, customer_id: CUSTOMER, channel: 'WEB_CHAT' })).resolves.toMatchObject({
      consented: false,
      suppressed: false,
      reason: 'CONSENT_REQUIRED',
    });

    const suppressed = createSalesConsentPort({ getProfileFn: vi.fn(async () => profile({ suppression_active: true })) });
    await expect(suppressed.read({ tenant_id: TENANT, customer_id: CUSTOMER, channel: 'WEB_CHAT' })).resolves.toMatchObject({
      consented: false,
      suppressed: true,
      reason: 'SUPPRESSED',
    });
  });
});

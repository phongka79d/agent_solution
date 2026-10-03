import { describe, expect, it } from 'vitest';
import { buildCreatePayload, validateCreateForm } from './TestCustomerForm';

const base = {
  display_name: 'Khách Test',
  email: '', phone: '', locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh',
  segment: '', lifecycle: '', tags: '', source: '',
  consent: { email: true, sms: false, whatsapp: false, transactional: true },
  salesEnabled: false, salesCategory: '', salesBudget: '', salesCurrency: 'VND', salesUseCase: '',
  orderEnabled: false, orderReference: '', orderStatus: 'paid', orderCurrency: 'VND', orderTotal: '', orderItems: '',
  careEnabled: false, careSubject: '', careEscalation: false, careFaq: '',
  marketingEnabled: false, marketingLastActive: '', marketingInactiveDays: '90', marketingOrderCount: '1', marketingCampaign: '', marketingSuppressed: false,
} as const;

describe('TestCustomerForm', () => {
  it('requires a display name and validates an order total', () => {
    expect(validateCreateForm({ ...base, display_name: '' })).not.toBeNull();
    expect(validateCreateForm({ ...base, email: 'nope' })).not.toBeNull();
    expect(validateCreateForm({ ...base, orderEnabled: true, orderTotal: '-1' })).not.toBeNull();
    expect(validateCreateForm({ ...base, orderEnabled: true, orderTotal: '120' })).toBeNull();
  });

  it('builds the server payload with identities, consents and optional seeds', () => {
    const payload = buildCreatePayload({
      ...base,
      email: 'a@example.test',
      phone: '0900000000',
      segment: 'retail',
      tags: 'vip, new',
      salesEnabled: true,
      salesCategory: 'laptop',
      orderEnabled: true,
      orderTotal: '250000',
      orderItems: 'Laptop A\nChuột B',
      careEnabled: true,
      careEscalation: true,
      marketingEnabled: true,
      marketingInactiveDays: '30',
    });
    expect(payload.display_name).toBe('Khách Test');
    expect(payload.primary_email).toBe('a@example.test');
    expect(payload.identities).toEqual([
      { channel_type: 'email', channel_identifier: 'a@example.test', is_primary: true },
      { channel_type: 'phone', channel_identifier: '0900000000', is_primary: false },
    ]);
    expect(payload.consents).toEqual(expect.arrayContaining([
      { consent_type: 'marketing_messaging', channel: 'email', is_granted: true },
      { consent_type: 'marketing_sms', channel: 'sms', is_granted: false },
    ]));
    expect(payload.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_name: 'product_view' }),
      expect.objectContaining({ event_name: 'profile_seeded' }),
    ]));
    expect(payload.order).toEqual(expect.objectContaining({ total_amount: 250000 }));
    expect(payload.marketing_cohort).toEqual({ last_paid_purchase_days_ago: 30, order_count: 1 });
    expect(payload.support_request).toBeDefined();
    expect(payload.handoff_request).toBeDefined();
  });

  it('validates the cohort and projects suppression into canonical email consent', () => {
    expect(validateCreateForm({ ...base, marketingEnabled: true, marketingInactiveDays: '' })).not.toBeNull();
    expect(validateCreateForm({ ...base, marketingEnabled: true, marketingInactiveDays: '-1' })).not.toBeNull();
    expect(validateCreateForm({ ...base, marketingEnabled: true, marketingOrderCount: '1.5' })).not.toBeNull();
    expect(validateCreateForm({ ...base, marketingEnabled: true, marketingOrderCount: '0' })).not.toBeNull();
    expect(validateCreateForm({ ...base, marketingEnabled: true })).toBeNull();
    const payload = buildCreatePayload({ ...base, marketingEnabled: true, marketingSuppressed: true });
    expect(payload.consents).toEqual(expect.arrayContaining([
      { consent_type: 'marketing_messaging', channel: 'email', is_granted: false },
    ]));
    expect(buildCreatePayload(base)).not.toHaveProperty('marketing_cohort');
  });

  it('never emits server-owned keys', () => {
    const payload = buildCreatePayload({ ...base, orderEnabled: true, orderTotal: '1' });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('tenant_id');
    expect(serialized).not.toContain('verified_customer_id');
    expect(serialized).not.toContain('data_class');
  });
});

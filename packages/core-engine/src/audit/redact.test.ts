import { describe, expect, it } from 'vitest';

import { redactForAudit } from './redact.js';

describe('redactForAudit', () => {
  it('masks configured fields, hashes identifiers, and drops PII and spend from context', () => {
    const email = 'private.customer@example.test';
    const phone = '+1 415 555 0199';
    const record = {
      run_id: 'run-1',
      tenant_id: 'tenant-1',
      agent_id: 'SAL-01',
      customer_or_entity_id: 'customer-123',
      started_at: '2026-01-02T03:04:05.000Z',
      context: {
        customer: {
          customer_id: 'customer-123',
          verified_email: email,
          verified_phone: phone,
          address: '1 Example Street',
          total_spent: 180,
          order_count: 2,
        },
        email,
        phone,
        spend: 180,
        notes: `Contact ${email} or ${phone}`,
      },
      action: { evidence_images: ['private-image-ref'], private_note: 'classified' },
    };

    const redacted = redactForAudit(record, { mask_pii_fields: ['evidence_images', 'private_note'] });
    const redactedText = JSON.stringify(redacted);

    expect(redacted.context.customer).toEqual({
      customer_id: expect.stringMatching(/^sha256:[0-9a-f]{57}$/),
      order_count: 2,
    });
    expect(redacted.context).not.toHaveProperty('email');
    expect(redacted.context).not.toHaveProperty('phone');
    expect(redacted.context).not.toHaveProperty('spend');
    expect(redacted.context.notes).toBe('Contact [REDACTED] or [REDACTED]');
    expect(redacted.action.evidence_images).toBe('[REDACTED]');
    expect(redacted.action.private_note).toBe('[REDACTED]');
    expect(redacted.customer_or_entity_id).toMatch(/^sha256:[0-9a-f]{57}$/);
    expect(redacted.run_id).toBe('run-1');
    expect(redacted.tenant_id).toBe('tenant-1');
    expect(redacted.started_at).toBe('2026-01-02T03:04:05.000Z');
    expect(redactedText).not.toContain(email);
    expect(redactedText).not.toContain(phone);
    expect(redactedText).not.toContain('1 Example Street');
    expect(redactedText).not.toContain('customer-123');
    expect(record.context.customer.verified_email).toBe(email);
  });

  it('preserves accounting data outside context and safely handles absent audit specs', () => {
    const record = {
      context: { customer: { total_spent: 42 } },
      cost: { total_cost_usd: 0.25 },
    };

    expect(redactForAudit(record)).toEqual({
      context: { customer: {} },
      cost: { total_cost_usd: 0.25 },
    });
  });
});

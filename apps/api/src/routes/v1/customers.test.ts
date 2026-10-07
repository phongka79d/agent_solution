import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { CompanyCrmCustomerRow } from '@agentos/database';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCustomerRoutes } from './customers.js';

const TENANT = 'tenant-a';
const TOKEN = 'customer-reader-token';

const customer: CompanyCrmCustomerRow = {
  customer_id: 'customer-1',
  tenant_id: TENANT,
  display_name: 'Alice',
  customer_tier: 'standard',
  verification_status: 'verified',
  created_at: '2026-01-01T00:00:00.000Z',
  verified_phone: '+886912345678',
  verified_email: 'alice@example.com',
  total_spent: null,
  order_count: null,
  rfm_segment_hypothesis: null,
  consent_marketing: null,
  suppression_active: null,
  identities: [],
};

function buildHarness(profile: CompanyCrmCustomerRow | null = null) {
  const runtime = {
    companyCrm: {
      listCustomers: vi.fn(async () => ({ items: [customer], next_cursor: null })),
      getCustomerProfile: vi.fn(async () => profile),
    },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-customer-1',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCustomerRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{ token: TOKEN, tenant_id: TENANT, operator_id: 'operator-1', permissions: ['customer:read'] }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, runtime };
}

describe('customer projection routes', () => {
  it('lists tenant customers through the CRM projection and masks contact values', async () => {
    const { app, runtime } = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/customers?limit=10',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [expect.objectContaining({ customer_id: 'customer-1', email: 'a***@e***.com', phone: '***5678' })],
        next_cursor: null,
      });
      expect(runtime.companyCrm?.listCustomers).toHaveBeenCalledWith({ tenant_id: TENANT, limit: 10 });
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the profile source has no row', async () => {
    const { app, runtime } = buildHarness(null);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/customers/customer-missing/profile',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error_code).toBe('NOT_FOUND');
      expect(runtime.companyCrm?.getCustomerProfile).toHaveBeenCalledWith(TENANT, 'customer-missing');
    } finally {
      await app.close();
    }
  });
});

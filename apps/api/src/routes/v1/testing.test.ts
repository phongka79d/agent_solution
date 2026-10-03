import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerIdentityRow, TestCustomersRepository } from '@agentos/database';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { createIdentityPort } from '../../runtime/bindings/approval-identity-port.js';
import { registerTestingRoutes } from './testing.js';
import type { TestingRouteDependencies } from './testing.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000011';
const CUSTOMER = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

const CUSTOMER_RECORD = {
  id: CUSTOMER,
  tenant_id: TENANT,
  display_name: 'TEST Lan',
  primary_email: null,
  primary_phone: null,
  external_crm_id: null,
  verification_status: 'verified',
  data_class: 'TEST' as const,
  created_at: '2026-10-01T00:00:00.000Z',
};

function buildHarness(overrides: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  const repository = {
    tenantDataClass: vi.fn(async () => 'DEMO' as const),
    tenantTestDataEnabled: vi.fn(async () => false),
    listCustomers: vi.fn(async () => ({ items: [CUSTOMER_RECORD], next_cursor: null })),
    getCustomer: vi.fn(async () => ({ ...CUSTOMER_RECORD, identities: [], consents: [], orders: [], events: [], service_cases: [] })),
    createCustomer: vi.fn(async (_tenant: string, input: { readonly primary_phone?: string }) => ({
      ...CUSTOMER_RECORD,
      primary_phone: input.primary_phone ?? null,
      identities: [], consents: [], orders: [], events: [], service_cases: [],
    })),
    createWidgetIdentity: vi.fn(async (
      _tenant: string,
      _customer: string,
      channel_type: string,
      channel_identifier: string,
    ) => ({
      id: 'test-identity-1',
      channel_type,
      channel_identifier,
      is_primary: false,
      verified: true,
    })),
    deleteCustomer: vi.fn(async () => CUSTOMER_RECORD),
    appendEvent: vi.fn(async () => ({ id: 'e1', event_name: 'product_view', channel: 'web', session_id: 's1', occurred_at: '2026-10-01T00:00:00.000Z' })),
    setConsent: vi.fn(async () => ({ id: 'c1', consent_type: 'marketing_messaging', channel: 'email', is_granted: true, opt_in_method: 'test_lab', opt_in_timestamp: '2026-10-01T00:00:00.000Z' })),
    createOrder: vi.fn(async () => ({ id: 'o1', order_number: 'TEST-1', status: 'paid', currency: 'VND', total_amount: 100, created_at: '2026-10-01T00:00:00.000Z' })),
    createSupportRequest: vi.fn(async () => ({ id: 'sc1', case_number: 'TESTCASE-1', state: 'NEW', subject: 'help', priority: 'P3', created_at: '2026-10-01T00:00:00.000Z' })),
    requestHandoff: vi.fn(async () => ({ id: 'h1', event_name: 'ext.care.handoff_requested', channel: 'web', session_id: 's1', occurred_at: '2026-10-01T00:00:00.000Z' })),
    resetTestData: vi.fn(async (_tenant: string, _actor: string, dry_run: boolean) => ({
      tenant_id: TENANT,
      dry_run,
      counts: { customers: dry_run ? 2 : 0 },
    })),
    ...overrides,
  };
  const audit = { record: vi.fn(async () => undefined) };
  const artifactPurger = { purge: vi.fn(async () => undefined) };
  const runtime = {
    clock: () => new Date('2026-10-01T00:00:00.000Z'),
    audit,
    testCustomerArtifacts: artifactPurger,
    ids: () => 'testing-route-test',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  const deps: TestingRouteDependencies = {
    runtime,
    credentials: createCredentialStore({
      operators: [
        { token: 'lab-token', tenant_id: TENANT, operator_id: 'lab-operator', scope: 'company', permissions: ['testdata:manage'] },
        { token: 'plain-token', tenant_id: TENANT, operator_id: 'plain-operator', scope: 'company', permissions: ['run:read'] },
      ],
      sessions: [],
      widgets: [],
    }),
    testCustomers: repository as unknown as TestCustomersRepository,
    widgetSessions: {
      issue: async ({ session_id }) => ({ access_token: 'widget-token', expires_at: '2026-10-01T00:30:00.000Z', session_id }),
    },
    env: () => env,
  };
  registerTestingRoutes(app, deps);
  return { app, repository, audit, artifactPurger };
}

const auth = { authorization: 'Bearer lab-token' };

describe('test customer lab routes', () => {
  it('requires testdata:manage and binds the list to the authenticated tenant', async () => {
    const { app, repository } = buildHarness();
    const allowed = await app.inject({ method: 'GET', url: '/testing/customers?limit=10', headers: auth });
    const denied = await app.inject({ method: 'GET', url: '/testing/customers', headers: { authorization: 'Bearer plain-token' } });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items).toHaveLength(1);
    expect(repository.listCustomers).toHaveBeenCalledWith(TENANT, { limit: 10 });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses a tenant whose data class does not allow the lab', async () => {
    const { app } = buildHarness({ tenantDataClass: vi.fn(async () => 'PRODUCTION' as const) });
    const response = await app.inject({ method: 'GET', url: '/testing/customers', headers: auth });
    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('CAPABILITY_NOT_ENABLED');
  });

  it('enables the lab for a PRODUCTION tenant whose settings allow test data', async () => {
    const { app } = buildHarness({
      tenantDataClass: vi.fn(async () => 'PRODUCTION' as const),
      tenantTestDataEnabled: vi.fn(async () => true),
    });
    const response = await app.inject({ method: 'GET', url: '/testing/customers', headers: auth });
    expect(response.statusCode).toBe(200);
  });

  it('creates a TEST customer with a validated default shipping address and refuses a client-supplied tenant_id', async () => {
    const { app, repository } = buildHarness();
    const default_shipping_address = {
      recipient_name: 'TEST Lan',
      phone: '+15551234567',
      postal_code: '10001',
      city: 'Metro',
      district: 'Central',
      address_line1: '10 Main Street',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/testing/customers',
      headers: auth,
      payload: { display_name: 'TEST Lan', default_shipping_address },
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/testing/customers',
      headers: auth,
      payload: { display_name: 'TEST Lan', tenant_id: TENANT },
    });
    const callsBeforeInvalidAddress = repository.createCustomer.mock.calls.length;
    const invalidAddress = await app.inject({
      method: 'POST',
      url: '/testing/customers',
      headers: auth,
      payload: {
        display_name: 'TEST Lan',
        default_shipping_address: { ...default_shipping_address, district: '' },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(repository.createCustomer).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ display_name: 'TEST Lan', default_shipping_address }),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error_code).toBe('VALIDATION_FAILED');
    expect(invalidAddress.statusCode).toBe(400);
    expect(repository.createCustomer).toHaveBeenCalledTimes(callsBeforeInvalidAddress);
  });

  it('creates a server-classified TEST marketing cohort with verified identity inputs and canonical consent', async () => {
    const { app, repository } = buildHarness();
    const input = {
      display_name: 'TEST Cohort',
      primary_email: 'cohort@example.test',
      identities: [{ channel_type: 'email', channel_identifier: 'cohort@example.test', is_primary: true }],
      consents: [{ consent_type: 'marketing_messaging', channel: 'email', is_granted: true }],
      marketing_cohort: { last_paid_purchase_days_ago: 90, order_count: 2 },
    };
    const created = await app.inject({ method: 'POST', url: '/testing/customers', headers: auth, payload: input });
    expect(created.statusCode).toBe(201);
    expect(created.json().customer.data_class).toBe('TEST');
    expect(repository.createCustomer).toHaveBeenCalledWith(TENANT, input);
  });

  it.each([
    { last_paid_purchase_days_ago: -1, order_count: 1 },
    { last_paid_purchase_days_ago: 30.5, order_count: 1 },
    { last_paid_purchase_days_ago: 36501, order_count: 1 },
    { last_paid_purchase_days_ago: 90, order_count: 0 },
    { last_paid_purchase_days_ago: 90, order_count: 1.5 },
    { last_paid_purchase_days_ago: 90 },
  ])('refuses invalid cohort fields before repository mutation: %j', async (marketing_cohort) => {
    const { app, repository } = buildHarness();
    const response = await app.inject({
      method: 'POST', url: '/testing/customers', headers: auth,
      payload: { display_name: 'TEST Cohort', marketing_cohort },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.createCustomer).not.toHaveBeenCalled();
  });

  it.each(['DEMO', 'PRODUCTION'])('refuses client-classified %s marketing seeds', async (data_class) => {
    const { app, repository } = buildHarness();
    const response = await app.inject({
      method: 'POST', url: '/testing/customers', headers: auth,
      payload: { display_name: 'Cohort', data_class, marketing_cohort: { last_paid_purchase_days_ago: 90, order_count: 1 } },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.createCustomer).not.toHaveBeenCalled();
  });
  it('seeds each created TEST customer into the tenant mock ERP before storefront mutations', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        tenant_id: TENANT,
        data_class: 'TEST',
        customers_seeded: 1,
        orders_seeded: 0,
        products_seeded: 0,
        inventory_seeded: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const { app } = buildHarness({}, {
      MOCK_ERP_ENABLED: 'true',
      MOCK_SECRET_KEY: 'local-test-secret',
      ERP_API_BASE_URL: 'http://mock-erp:4010/api/v1',
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/testing/customers',
        headers: auth,
        payload: { display_name: 'TEST Lan', primary_phone: '+15551234567' },
      });

      expect(response.statusCode).toBe(201);
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/__sim/seed');
      const seed = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      expect(seed['customers']).toEqual([{
        customer_id: CUSTOMER,
        display_name: 'TEST Lan',
        email: null,
        phone: '+15551234567',
      }]);
      expect(seed['orders']).toEqual([]);
      expect((calls[0]?.init.headers as Record<string, string>)['x-tenant-id']).toBe(TENANT);
      expect((calls[0]?.init.headers as Record<string, string>)['x-mock-signature']).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });


  it('reads and deletes one TEST customer', async () => {
    const { app, repository } = buildHarness();
    const found = await app.inject({ method: 'GET', url: `/testing/customers/${CUSTOMER}`, headers: auth });
    const removed = await app.inject({ method: 'DELETE', url: `/testing/customers/${CUSTOMER}`, headers: auth });

    expect(found.statusCode).toBe(200);
    expect(found.json().customer.id).toBe(CUSTOMER);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().deleted).toBe(true);
    expect(repository.getCustomer).toHaveBeenCalledWith(TENANT, CUSTOMER);
  });

  it('answers NOT_FOUND for an unknown TEST customer', async () => {
    const { app } = buildHarness({ getCustomer: vi.fn(async () => null) });
    const response = await app.inject({ method: 'GET', url: `/testing/customers/${CUSTOMER}`, headers: auth });
    expect(response.statusCode).toBe(404);
    expect(response.json().error_code).toBe('NOT_FOUND');
  });

  it('maps a refused PRODUCTION delete to a prohibition', async () => {
    const { app } = buildHarness({ deleteCustomer: vi.fn(async () => { throw new Error('TEST_CUSTOMER_NOT_TEST_DATA: nope'); }) });
    const response = await app.inject({ method: 'DELETE', url: `/testing/customers/${CUSTOMER}`, headers: auth });
    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('PROHIBITED_ACTION');
  });

  it('appends events, consents, support requests and handoff requests', async () => {
    const { app, audit } = buildHarness();
    const event = await app.inject({ method: 'POST', url: `/testing/customers/${CUSTOMER}/events`, headers: auth, payload: { event_name: 'product_view', channel: 'web' } });
    const consent = await app.inject({ method: 'POST', url: `/testing/customers/${CUSTOMER}/consent`, headers: auth, payload: { consent_type: 'marketing_messaging', channel: 'email', is_granted: true } });
    const support = await app.inject({ method: 'POST', url: `/testing/customers/${CUSTOMER}/support-requests`, headers: auth, payload: { subject: 'help' } });
    const handoff = await app.inject({ method: 'POST', url: `/testing/customers/${CUSTOMER}/handoff-request`, headers: auth, payload: { escalation_reason: 'angry' } });

    expect(event.statusCode).toBe(201);
    expect(consent.statusCode).toBe(200);
    expect(support.statusCode).toBe(201);
    expect(handoff.statusCode).toBe(202);
    expect(audit.record).toHaveBeenCalledTimes(4);
  });

  it('refuses an order seed when the tenant system of record cannot be seeded', async () => {
    const { app, repository } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/testing/customers/${CUSTOMER}/orders`,
      headers: auth,
      payload: { total_amount: 100 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error_code).toBe('SOR_SEED_UNSUPPORTED');
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  it('seeds the system of record before persisting a TEST order', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ tenant_id: TENANT, data_class: 'TEST', customers_seeded: 1, orders_seeded: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { app, repository } = buildHarness({}, {
        MOCK_ERP_ENABLED: 'true',
        MOCK_SECRET_KEY: 'secret',
        ERP_API_BASE_URL: 'http://mock-erp:4010/api/v1',
      });
      const response = await app.inject({
        method: 'POST',
        url: `/testing/customers/${CUSTOMER}/orders`,
        headers: auth,
        payload: { order_number: 'TEST-42', total_amount: 250 },
      });

      expect(response.statusCode).toBe(201);
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]?.url ?? '').pathname).toBe('/__sim/seed');
      expect((calls[0]?.init.headers as Record<string, string>)['x-tenant-id']).toBe(TENANT);
      expect(repository.createOrder).toHaveBeenCalledWith(
        TENANT,
        CUSTOMER,
        expect.objectContaining({ order_number: 'TEST-42', total_amount: 250 }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('mints a server-bound widget session for the TEST customer', async () => {
    const { app, repository } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/testing/customers/${CUSTOMER}/widget-session`,
      headers: auth,
      payload: { origin: 'http://localhost:3001' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ tenant_id: TENANT, customer_id: CUSTOMER, access_token: 'widget-token' });
    expect(repository.createWidgetIdentity).toHaveBeenCalledWith(
      TENANT,
      CUSTOMER,
      'WEB_CHAT',
      response.json<{ session_id: string }>().session_id,
    );
  });

  it('resolves launched TEST customers by their exact tenant and Web Chat session', async () => {
    const otherCustomer = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c';
    const identities: CustomerIdentityRow[] = [];
    const { app } = buildHarness({
      getCustomer: vi.fn(async (_tenant: string, id: string) => ({
        ...CUSTOMER_RECORD, id, identities: [], consents: [], orders: [], events: [], service_cases: [],
      })),
      createWidgetIdentity: vi.fn(async (
        tenant_id: string,
        customer_id: string,
        channel_type: string,
        channel_identifier: string,
      ) => {
        const identity: CustomerIdentityRow = {
          id: `identity-${customer_id}`,
          tenant_id,
          customer_id,
          channel_type,
          channel_identifier,
          identifier_hash: 'test-session-hash',
          is_primary: false,
          verified_at: new Date(CUSTOMER_RECORD.created_at),
          created_at: new Date(CUSTOMER_RECORD.created_at),
        };
        identities.push(identity);
        return {
          id: identity.id,
          channel_type,
          channel_identifier,
          is_primary: false,
          verified: true,
        };
      }),
    });
    const identityPort = createIdentityPort(async (tenant_id, channel_type, channel_identifier) =>
      identities.find((identity) =>
        identity.tenant_id === tenant_id &&
        identity.channel_type === channel_type &&
        identity.channel_identifier === channel_identifier) ?? null,
    );

    try {
      for (const customer_id of [CUSTOMER, otherCustomer]) {
        const launched = await app.inject({
          method: 'POST',
          url: `/testing/customers/${customer_id}/widget-session`,
          headers: auth,
          payload: { origin: 'http://localhost:3001' },
        });
        expect(launched.statusCode).toBe(201);
        const { session_id } = launched.json<{ session_id: string }>();
        const input = {
          tenant_id: TENANT,
          session_id,
          channel_type: 'WEB_CHAT',
          channel_identifier: session_id,
          claimed_customer_id: customer_id === CUSTOMER ? otherCustomer : CUSTOMER,
        };
        await expect(identityPort.resolveCustomer(input)).resolves.toEqual({
          customer_id, verdict: 'CHANNEL_IDENTIFIER_EXACT',
        });
        await expect(identityPort.resolveCustomer({
          ...input, tenant_id: '9a2f7ed4-1fe4-4f8c-8d63-008450000012',
        })).resolves.toEqual({ customer_id: null, verdict: 'UNRESOLVED' });
        await expect(identityPort.resolveCustomer({
          ...input, session_id: 'unknown-session', channel_identifier: 'unknown-session',
        })).resolves.toEqual({ customer_id: null, verdict: 'UNRESOLVED' });
      }
    } finally {
      await app.close();
    }
  });

  it('purges Redis/Qdrant artifacts only for the reset TEST customers', async () => {
    const secondTestId = '6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c';
    const productionId = '7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5c';
    const { app, repository, artifactPurger } = buildHarness({
      listCustomers: vi.fn()
        .mockResolvedValueOnce({ items: [CUSTOMER_RECORD], next_cursor: secondTestId })
        .mockResolvedValueOnce({
          items: [
            { ...CUSTOMER_RECORD, id: secondTestId },
            { ...CUSTOMER_RECORD, id: productionId, data_class: 'PRODUCTION' },
          ],
          next_cursor: null,
        }),
    });
    const dry = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: true } });
    const token = dry.json().confirm_token as string;
    const confirmed = await app.inject({
      method: 'POST',
      url: '/testing/reset',
      headers: auth,
      payload: { dry_run: false, confirm_token: token },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(artifactPurger.purge).toHaveBeenCalledWith({
      tenant_id: TENANT,
      customer_ids: [CUSTOMER, secondTestId],
    });
    expect(repository.listCustomers).toHaveBeenNthCalledWith(1, TENANT, { limit: 100 });
    expect(repository.listCustomers).toHaveBeenNthCalledWith(2, TENANT, { limit: 100, cursor: secondTestId });
  });

  it('keeps the reset confirmation token usable when artifact purge fails', async () => {
    const { app, repository, artifactPurger } = buildHarness();
    artifactPurger.purge.mockRejectedValueOnce(new Error('ARTIFACT_PURGE_FAILED'));
    const dry = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: true } });
    const token = dry.json().confirm_token as string;
    const failed = await app.inject({
      method: 'POST',
      url: '/testing/reset',
      headers: auth,
      payload: { dry_run: false, confirm_token: token },
    });

    expect(failed.statusCode).toBe(500);
    expect(repository.resetTestData).toHaveBeenCalledTimes(1);
    expect(repository.resetTestData).toHaveBeenNthCalledWith(1, TENANT, 'lab-operator', true);

    const retry = await app.inject({
      method: 'POST',
      url: '/testing/reset',
      headers: auth,
      payload: { dry_run: false, confirm_token: token },
    });
    expect(retry.statusCode).toBe(200);
    expect(repository.resetTestData).toHaveBeenNthCalledWith(2, TENANT, 'lab-operator', false);
  });

  it('requires a dry run and its token before deleting TEST data', async () => {
    const { app, repository, artifactPurger } = buildHarness();
    const direct = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: false } });
    const dry = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: true } });
    const token = dry.json().confirm_token as string;
    const wrong = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: false, confirm_token: 'nope' } });
    const confirmed = await app.inject({ method: 'POST', url: '/testing/reset', headers: auth, payload: { dry_run: false, confirm_token: token } });

    expect(direct.statusCode).toBe(400);
    expect(dry.statusCode).toBe(200);
    expect(wrong.statusCode).toBe(403);
    expect(confirmed.statusCode).toBe(200);
    expect(repository.resetTestData).toHaveBeenLastCalledWith(TENANT, 'lab-operator', false);
    expect(artifactPurger.purge).toHaveBeenCalledWith({ tenant_id: TENANT, customer_ids: [CUSTOMER] });
  });
});

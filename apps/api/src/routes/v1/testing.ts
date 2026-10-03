import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { TestCustomersRepository, TestDataClass } from '@agentos/database';
import { signMockRequest } from '@agentos/adapters';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { nodeHmacSha256Hex } from '../../runtime/adapters.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** Server-side storefront session minted for one TEST customer (`workflow.md` §5.7, T7.4). */
export interface TestWidgetSessionIssuer {
  issue(input: {
    readonly tenant_id: string;
    readonly customer_id: string;
    readonly data_class: TestDataClass;
    readonly session_id: string;
    readonly origin: string;
  }): Promise<{ readonly access_token: string; readonly expires_at: string; readonly session_id: string }>;
}


export interface TestingRouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly testCustomers: TestCustomersRepository;
  /** Present when configured Redis/Qdrant stores need TEST customer cleanup. */
  readonly widgetSessions?: TestWidgetSessionIssuer;
  /** Read at request time so a long-lived process cannot pin stale demo gating. */
  readonly env?: () => Environment;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 100;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Keys the server owns; a client that sends any of them is refused, never silently ignored. */
const RESERVED_KEYS: Readonly<Record<string, true>> = { tenant_id: true, verified_customer_id: true, data_class: true };

interface IdParams {
  readonly id: string;
}

interface ListQuery {
  readonly limit?: string;
  readonly cursor?: string;
  readonly search?: string;
}

interface ResetTokenEntry {
  readonly token: string;
  readonly expires_ms: number;
}

const ID_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } },
} as const;

const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
    cursor: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    search: { type: 'string', maxLength: 128 },
  },
} as const;

const IDENTITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['channel_type', 'channel_identifier'],
  properties: {
    channel_type: { type: 'string', minLength: 1, maxLength: 32 },
    channel_identifier: { type: 'string', minLength: 1, maxLength: 255 },
    is_primary: { type: 'boolean' },
  },
} as const;

const CONSENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['consent_type', 'channel', 'is_granted'],
  properties: {
    consent_type: { type: 'string', minLength: 1, maxLength: 64 },
    channel: { type: 'string', minLength: 1, maxLength: 32 },
    is_granted: { type: 'boolean' },
    opt_in_method: { type: 'string', minLength: 1, maxLength: 64 },
    evidence_text: { type: 'string', maxLength: 2000 },
  },
} as const;

const EVENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['event_name', 'channel'],
  properties: {
    event_name: { type: 'string', minLength: 1, maxLength: 64 },
    channel: { type: 'string', minLength: 1, maxLength: 32 },
    session_id: { type: 'string', minLength: 1, maxLength: 128 },
    payload: { type: 'object' },
  },
} as const;

const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['total_amount'],
  properties: {
    order_number: { type: 'string', minLength: 1, maxLength: 64 },
    currency: { type: 'string', minLength: 3, maxLength: 8 },
    status: { type: 'string', minLength: 1, maxLength: 32 },
    total_amount: { type: 'number', minimum: 0 },
    items: { type: 'array', maxItems: 50, items: { type: 'object' } },
  },
} as const;

const SUPPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject'],
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 512 },
    category: { type: 'string', maxLength: 64 },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
  },
} as const;

const HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['escalation_reason'],
  properties: {
    escalation_reason: { type: 'string', minLength: 1, maxLength: 1000 },
    summary_context: { type: 'string', maxLength: 2000 },
    channel: { type: 'string', maxLength: 32 },
    session_id: { type: 'string', maxLength: 128 },
  },
} as const;
const DEFAULT_SHIPPING_ADDRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recipient_name', 'phone', 'postal_code', 'city', 'district', 'address_line1'],
  properties: {
    recipient_name: { type: 'string', minLength: 1, maxLength: 255 },
    phone: { type: 'string', minLength: 1, maxLength: 255 },
    postal_code: { type: 'string', minLength: 1, maxLength: 255 },
    city: { type: 'string', minLength: 1, maxLength: 255 },
    district: { type: 'string', minLength: 1, maxLength: 255 },
    address_line1: { type: 'string', minLength: 1, maxLength: 255 },
    cvs_store_id: { type: 'string', minLength: 1, maxLength: 255 },
    cvs_store_name: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

const MARKETING_COHORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['last_paid_purchase_days_ago', 'order_count'],
  properties: {
    last_paid_purchase_days_ago: { type: 'integer', minimum: 0, maximum: 36500 },
    order_count: { type: 'integer', minimum: 1, maximum: 1000000 },
  },
} as const;

const CREATE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['display_name'],
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: 255 },
    primary_email: { type: 'string', maxLength: 255 },
    primary_phone: { type: 'string', maxLength: 64 },
    external_crm_id: { type: 'string', maxLength: 128 },
    identities: { type: 'array', maxItems: 10, items: IDENTITY_SCHEMA },
    default_shipping_address: DEFAULT_SHIPPING_ADDRESS_SCHEMA,
    marketing_cohort: MARKETING_COHORT_SCHEMA,
    consents: { type: 'array', maxItems: 20, items: CONSENT_SCHEMA },
    events: { type: 'array', maxItems: 50, items: EVENT_SCHEMA },
    order: ORDER_SCHEMA,
    support_request: SUPPORT_SCHEMA,
    handoff_request: HANDOFF_SCHEMA,
  },
} as const;

const WIDGET_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['origin'],
  properties: { origin: { type: 'string', minLength: 1, maxLength: 255 } },
} as const;

const RESET_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dry_run'],
  properties: {
    dry_run: { type: 'boolean' },
    confirm_token: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuses any server-owned key at any depth; the client never selects its own tenant or identity. */
function assertNoReservedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoReservedKeys(entry);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (RESERVED_KEYS[key] === true) fail('VALIDATION_FAILED', `${key} is server-owned and cannot be supplied`);
    assertNoReservedKeys(entry);
  }
}

function customerId(request: FastifyRequest<{ Params: IdParams }>): string {
  const id = request.params.id;
  if (!UUID.test(id)) fail('VALIDATION_FAILED', 'customer id must be a UUID');
  return id;
}

function listQuery(query: ListQuery): { limit?: number; cursor?: string; search?: string } {
  const result: { limit?: number; cursor?: string; search?: string } = {};
  if (query.limit !== undefined) {
    const limit = Number.parseInt(query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      fail('VALIDATION_FAILED', `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    result.limit = limit;
  }
  if (query.cursor !== undefined) {
    if (!UUID.test(query.cursor)) fail('VALIDATION_FAILED', 'cursor must be a customer id');
    result.cursor = query.cursor;
  }
  if (query.search !== undefined && query.search.trim() !== '') result.search = query.search.trim();
  return result;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (!isPlainRecord(body)) fail('VALIDATION_FAILED', 'a JSON object body is required');
  assertNoReservedKeys(body);
  return body;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof Error) {
    const code = error.message.split(':')[0]?.trim() ?? '';
    if (code === 'TEST_CUSTOMER_NOT_FOUND') fail('NOT_FOUND', 'the TEST customer does not exist');
    if (code === 'TEST_CUSTOMER_NOT_TEST_DATA') {
      fail('PROHIBITED_ACTION', 'only TEST customers can be changed by the Test Customer Lab');
    }
    if (code.startsWith('TEST_CUSTOMER_') || code.startsWith('TEST_DATA_')) {
      fail('VALIDATION_FAILED', 'the TEST customer request is not valid');
    }
  }
  throw error;
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapRepositoryError(error);
  }
}
async function listTestCustomerIds(repository: TestCustomersRepository, tenant_id: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const query = cursor === undefined ? { limit: MAX_LIMIT } : { limit: MAX_LIMIT, cursor };
    const page = await callRepository(() => repository.listCustomers(tenant_id, query));
    for (const customer of page.items) {
      if (customer.data_class === 'TEST') ids.push(customer.id);
    }
    if (page.next_cursor === null) return ids;
    cursor = page.next_cursor;
  }
}


type TestSorCustomer = {
  readonly id: string;
  readonly display_name: string | null;
  readonly primary_email: string | null;
  readonly primary_phone: string | null;
};

type TestSorOrder = {
  readonly customer_id: string;
  readonly order_number?: string;
  readonly currency?: string;
  readonly status?: string;
  readonly total_amount: number;
  readonly items?: readonly Readonly<Record<string, unknown>>[];
};

async function seedTestDataThroughSor(
  env: Environment,
  tenant_id: string,
  input: { readonly customer?: TestSorCustomer; readonly order?: TestSorOrder },
): Promise<string | undefined> {
  const hasOrder = input.order !== undefined;
  if (!hasOrder && env.MOCK_ERP_ENABLED !== 'true') return undefined;

  const secret = env.MOCK_SECRET_KEY;
  const configured = env.ERP_API_BASE_URL;
  const unsupported = 'the tenant system of record does not support test-lab seeding';
  if (env.MOCK_ERP_ENABLED !== 'true' || secret === undefined || configured === undefined || !configured.includes('mock-erp')) {
    fail('SOR_SEED_UNSUPPORTED', unsupported);
  }
  let seedUrl: URL;
  try {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol) || base.username !== '' || base.password !== '') {
      fail('SOR_SEED_UNSUPPORTED', unsupported);
    }
    seedUrl = new URL('/__sim/seed', base);
  } catch {
    fail('SOR_SEED_UNSUPPORTED', unsupported);
  }

  const order = input.order;
  const order_reference = order === undefined
    ? undefined
    : order.order_number ?? `TEST-${randomUUID().slice(0, 12).toUpperCase()}`;
  const rawBody = JSON.stringify({
    customers: input.customer === undefined ? [] : [{
      customer_id: input.customer.id,
      display_name: input.customer.display_name ?? 'TEST customer',
      email: input.customer.primary_email ?? null,
      phone: input.customer.primary_phone ?? null,
    }],
    orders: order === undefined ? [] : [{
      order_id: order_reference,
      customer_id: order.customer_id,
      order_number: order_reference,
      currency: order.currency ?? 'VND',
      status: order.status ?? 'paid',
      total_amount: order.total_amount,
      items: order.items ?? [],
    }],
  });
  const response = await fetch(seedUrl.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenant_id,
      'x-mock-signature': signMockRequest(secret, 'POST', seedUrl.pathname, rawBody, nodeHmacSha256Hex),
    },
    body: rawBody,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) fail('SOR_SEED_UNSUPPORTED', 'the tenant system of record refused the test data seed');
  const seeded: unknown = await response.json();
  if (
    !isPlainRecord(seeded)
    || (input.customer !== undefined && seeded.customers_seeded !== 1)
    || (order !== undefined && seeded.orders_seeded !== 1)
  ) {
    fail('SOR_SEED_UNSUPPORTED', 'the tenant system of record refused the test data seed');
  }
  return order_reference;
}

async function seedOrderThroughSor(
  env: Environment,
  tenant_id: string,
  customer_id: string,
  order: Omit<TestSorOrder, 'customer_id'>,
): Promise<string> {
  const order_reference = await seedTestDataThroughSor(env, tenant_id, {
    order: { ...order, customer_id },
  });
  if (order_reference === undefined) {
    fail('SOR_SEED_UNSUPPORTED', 'the tenant system of record refused the test order seed');
  }
  return order_reference;
}

/**
 * Registers the server-side Test Customer Lab (`workflow.md` §5, PLAN T7.2).
 *
 * Only operators holding `testdata:manage` may call these routes, and only inside a tenant whose
 * data class is `DEMO` or `TEST`. The tenant is the authenticated principal's; a body that tries to
 * bind `tenant_id` or `verified_customer_id` is refused. Every mutation is audited.
 */
export function registerTestingRoutes(app: FastifyInstance, deps: TestingRouteDependencies): void {
  const preHandler = authenticate({ credentials: deps.credentials, runtime: deps.runtime });
  const resetTokens = new Map<string, ResetTokenEntry>();

  async function requireTestLab(tenant_id: string): Promise<void> {
    const data_class = await callRepository(() => deps.testCustomers.tenantDataClass(tenant_id));
    if (data_class === 'DEMO' || data_class === 'TEST') return;
    const enabled = await callRepository(() => deps.testCustomers.tenantTestDataEnabled(tenant_id));
    if (!enabled) {
      fail('CAPABILITY_NOT_ENABLED', 'the Test Customer Lab is enabled only for DEMO or TEST tenants');
    }
  }

  async function audit(
    request: FastifyRequest,
    tenant_id: string,
    operation: string,
    detail: Record<string, unknown>,
    principal_kind: string,
    operator_id: string | undefined,
  ): Promise<void> {
    await deps.runtime.audit.record({
      tenant_id,
      correlation_id: correlationIdOf(request, deps.runtime),
      operation,
      principal_kind,
      ...(operator_id === undefined ? {} : { operator_id }),
      outcome: 'ACCEPTED',
      detail,
    });
  }

  // The reserved-key guard must be encapsulated: it runs before schema validation (Fastify strips
  // unknown properties during validation), and it must never apply to sibling route groups.
  void app.register((scope, _options, done) => {
    scope.addHook('preValidation', async (request) => {
      assertNoReservedKeys(request.body);
    });

    scope.get<{ Querystring: ListQuery }>('/testing/status', { preHandler }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      const data_class = await callRepository(() => deps.testCustomers.tenantDataClass(principal.tenant_id));
      const setting_enabled = data_class === 'DEMO' || data_class === 'TEST'
        ? true
        : await callRepository(() => deps.testCustomers.tenantTestDataEnabled(principal.tenant_id));
      return reply.code(200).send({
        tenant_id: principal.tenant_id,
        data_class,
        enabled: setting_enabled,
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    scope.post<{ Body: Parameters<TestCustomersRepository['createCustomer']>[1] }>('/testing/customers', { preHandler, schema: { body: CREATE_BODY_SCHEMA } }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      await requireTestLab(principal.tenant_id);
      assertNoReservedKeys(request.body);
      const input = request.body;
      const { order, handoff_request, ...profile } = input;
      const customer = await callRepository(() => deps.testCustomers.createCustomer(principal.tenant_id, profile));
      const env = deps.env?.() ?? process.env;
      let seeded_order_reference: string | undefined;
      if (order != null) {
        const reference = await seedTestDataThroughSor(env, principal.tenant_id, {
          customer,
          order: { ...order, customer_id: customer.id },
        });
        if (reference === undefined) {
          fail('SOR_SEED_UNSUPPORTED', 'the tenant system of record refused the test order seed');
        }
        seeded_order_reference = reference;
        await callRepository(() => deps.testCustomers.createOrder(principal.tenant_id, customer.id, {
          ...order,
          ...(order.order_number === undefined ? { order_number: reference } : {}),
        }));
      } else {
        await seedTestDataThroughSor(env, principal.tenant_id, { customer });
      }
      if (handoff_request != null) {
        await callRepository(() => deps.testCustomers.requestHandoff(principal.tenant_id, customer.id, handoff_request));
      }
      const created = await callRepository(() => deps.testCustomers.getCustomer(principal.tenant_id, customer.id));
      await audit(request, principal.tenant_id, 'testing.customers.create', { customer_id: customer.id }, principal.kind, principal.operator_id);
      return reply.code(201).send({
        customer: created ?? customer,
        ...(seeded_order_reference === undefined ? {} : { seeded_order_reference }),
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    scope.get<{ Querystring: ListQuery }>('/testing/customers', { preHandler, schema: { querystring: LIST_QUERY_SCHEMA } }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      await requireTestLab(principal.tenant_id);
      const page = await callRepository(() => deps.testCustomers.listCustomers(principal.tenant_id, listQuery(request.query)));
      return reply.code(200).send(page);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    scope.get<{ Params: IdParams }>('/testing/customers/:id', { preHandler, schema: { params: ID_PARAMS_SCHEMA } }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      await requireTestLab(principal.tenant_id);
      const customer = await callRepository(() => deps.testCustomers.getCustomer(principal.tenant_id, customerId(request)));
      if (customer === null) fail('NOT_FOUND', 'the TEST customer does not exist');
      return reply.code(200).send({ customer });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    scope.delete<{ Params: IdParams }>('/testing/customers/:id', { preHandler, schema: { params: ID_PARAMS_SCHEMA } }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      await requireTestLab(principal.tenant_id);
      const deleted = await callRepository(() => deps.testCustomers.deleteCustomer(principal.tenant_id, customerId(request)));
      await audit(request, principal.tenant_id, 'testing.customers.delete', { customer_id: deleted.id }, principal.kind, principal.operator_id);
      return reply.code(200).send({ deleted: true, customer: deleted });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/events',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: EVENT_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        const body = bodyOf(request);
        const event = await callRepository(() => deps.testCustomers.appendEvent(
          principal.tenant_id,
          customerId(request),
          body as unknown as Parameters<TestCustomersRepository['appendEvent']>[2],
        ));
        await audit(request, principal.tenant_id, 'testing.customers.event', { customer_id: request.params.id, event_id: event.id }, principal.kind, principal.operator_id);
        return reply.code(201).send({ event });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/orders',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: ORDER_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        const id = customerId(request);
        const body = bodyOf(request);
        const customer = await callRepository(() => deps.testCustomers.getCustomer(principal.tenant_id, id));
        if (customer === null) fail('NOT_FOUND', 'the TEST customer does not exist');
        const input = body as unknown as Parameters<TestCustomersRepository['createOrder']>[2];
        const sor_order_id = await seedOrderThroughSor(deps.env?.() ?? process.env, principal.tenant_id, customer.id, input);
        const order = await callRepository(() => deps.testCustomers.createOrder(principal.tenant_id, id, {
          ...input,
          order_number: input.order_number ?? sor_order_id,
        }));
        await audit(request, principal.tenant_id, 'testing.customers.order', { customer_id: id, order_id: order.id }, principal.kind, principal.operator_id);
        return reply.code(201).send({ order, seeded_order_reference: sor_order_id });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/consent',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: CONSENT_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        const body = bodyOf(request);
        const consent = await callRepository(() => deps.testCustomers.setConsent(
          principal.tenant_id,
          customerId(request),
          body as unknown as Parameters<TestCustomersRepository['setConsent']>[2],
        ));
        await audit(request, principal.tenant_id, 'testing.customers.consent', { customer_id: request.params.id, consent_id: consent.id }, principal.kind, principal.operator_id);
        return reply.code(200).send({ consent });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/support-requests',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: SUPPORT_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        const body = bodyOf(request);
        const service_case = await callRepository(() => deps.testCustomers.createSupportRequest(
          principal.tenant_id,
          customerId(request),
          body as unknown as Parameters<TestCustomersRepository['createSupportRequest']>[2],
        ));
        await audit(request, principal.tenant_id, 'testing.customers.support_request', { customer_id: request.params.id, case_id: service_case.id }, principal.kind, principal.operator_id);
        return reply.code(201).send({ service_case });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/handoff-request',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: HANDOFF_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        const body = bodyOf(request);
        const event = await callRepository(() => deps.testCustomers.requestHandoff(
          principal.tenant_id,
          customerId(request),
          body as unknown as Parameters<TestCustomersRepository['requestHandoff']>[2],
        ));
        await audit(request, principal.tenant_id, 'testing.customers.handoff_request', { customer_id: request.params.id, event_id: event.id }, principal.kind, principal.operator_id);
        return reply.code(202).send({ handoff_request: event });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post<{ Params: IdParams }>(
    '/testing/customers/:id/widget-session',
    { preHandler, schema: { params: ID_PARAMS_SCHEMA, body: WIDGET_BODY_SCHEMA } },
    async (request, reply) => {
      try {
        const principal = requireOperator(request, 'testdata:manage');
        await requireTestLab(principal.tenant_id);
        if (deps.widgetSessions === undefined) {
          fail('CAPABILITY_NOT_ENABLED', 'storefront widget sessions are not configured for this deployment');
        }
        const id = customerId(request);
        const customer = await callRepository(() => deps.testCustomers.getCustomer(principal.tenant_id, id));
        if (customer === null) fail('NOT_FOUND', 'the TEST customer does not exist');
        const origin = String(bodyOf(request).origin);
        if (!/^https?:\/\/[^/]+$/.test(origin)) fail('VALIDATION_FAILED', 'origin must be a scheme and host only');
        const session_id = `testlab-${id}-${randomUUID()}`;
        // Store the gateway channel vocabulary used by storefront and conversation identity reads.
        const identity = await callRepository(() => deps.testCustomers.createWidgetIdentity(
          principal.tenant_id,
          id,
          'WEB_CHAT',
          session_id,
        ));
        const issued = await deps.widgetSessions.issue({
          data_class: customer.data_class,
          tenant_id: principal.tenant_id,
          customer_id: id,
          session_id,
          origin,
        });
        await audit(request, principal.tenant_id, 'testing.customers.widget_session', { customer_id: id, identity_id: identity.id }, principal.kind, principal.operator_id);
        return reply.code(201).header('cache-control', 'no-store').send({
          ...issued,
          tenant_id: principal.tenant_id,
          customer_id: id,
          identity_id: identity.id,
        });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
      }
    },
  );

    scope.post('/testing/reset', { preHandler, schema: { body: RESET_BODY_SCHEMA } }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'testdata:manage');
      await requireTestLab(principal.tenant_id);
      const body = bodyOf(request);
      const actor = principal.operator_id ?? principal.tenant_id;
      if (body.dry_run === true) {
        const result = await callRepository(() => deps.testCustomers.resetTestData(principal.tenant_id, actor, true));
        const token = randomUUID();
        resetTokens.set(principal.tenant_id, { token, expires_ms: deps.runtime.clock().getTime() + RESET_TOKEN_TTL_MS });
        return reply.code(200).send({ ...result, confirm_token: token });
      }
      const entry = resetTokens.get(principal.tenant_id);
      const now_ms = deps.runtime.clock().getTime();
      if (entry === undefined || entry.expires_ms <= now_ms) {
        resetTokens.delete(principal.tenant_id);
        fail('VALIDATION_FAILED', 'a fresh dry run is required before resetting TEST data');
      }
      if (body.confirm_token !== entry.token) {
        fail('INSUFFICIENT_AUTHORITY', 'the reset confirmation token does not match the latest dry run');
      }
      const customer_ids = await listTestCustomerIds(deps.testCustomers, principal.tenant_id);
      if (customer_ids.length > 0) {
        const purger = deps.runtime.testCustomerArtifacts;
        if (purger === undefined) {
          fail('CAPABILITY_UNAVAILABLE', 'TEST customer artifact cleanup is not configured');
        }
        await purger.purge({ tenant_id: principal.tenant_id, customer_ids });
      }
      const result = await callRepository(() => deps.testCustomers.resetTestData(principal.tenant_id, actor, false));
      resetTokens.delete(principal.tenant_id);
      await audit(request, principal.tenant_id, 'testing.reset', { counts: result.counts }, principal.kind, principal.operator_id);
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });

    done();
  });
}

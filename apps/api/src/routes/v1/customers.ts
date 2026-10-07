import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CompanyCrmPort, GatewayRuntime } from '../../gateway/ports.js';
import { toCustomerListItem, toCustomerProfile } from '../../projections/customers.js';

export interface CustomerRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function limitField(value: unknown, key: string): number | null {
  const raw = stringField(value, key);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || raw === '0') {
    fail('VALIDATION_FAILED', `${key} must be a positive integer`);
  }
  return Number.parseInt(raw, 10);
}

function crmPort(runtime: GatewayRuntime): CompanyCrmPort {
  if (runtime.companyCrm === undefined) {
    fail('CAPABILITY_NOT_ENABLED', 'the company CRM projection is not configured');
  }
  return runtime.companyCrm;
}

async function handleCustomers(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CustomerRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requireOperator(request, 'customer:read');
    const query = stringField(request.query, 'query') ?? undefined;
    const cursor = stringField(request.query, 'cursor') ?? undefined;
    const rawLimit = limitField(request.query, 'limit');
    const page = await crmPort(runtime).listCustomers({
      tenant_id: principal.tenant_id,
      ...(query === undefined ? {} : { query }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(rawLimit === null ? {} : { limit: rawLimit }),
    });
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/customers',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { result_count: page.items.length },
    });
    return reply.code(200).send({
      items: page.items.map(toCustomerListItem),
      next_cursor: page.next_cursor,
    });
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}

async function handleCustomerProfile(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CustomerRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requireOperator(request, 'customer:read');
    const customer_id = stringField(request.params, 'customer_id');
    if (customer_id === null) fail('VALIDATION_FAILED', 'customer_id is required in the path');
    const row = await crmPort(runtime).getCustomerProfile(principal.tenant_id, customer_id);
    if (row === null) fail('NOT_FOUND', 'the customer profile was not found');
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/customers/{customer_id}/profile',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { customer_id },
    });
    return reply.code(200).send(toCustomerProfile(row));
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}

/** Registers tenant-scoped customer list and Customer 360 profile reads. */
export function registerCustomerRoutes(app: FastifyInstance, deps: CustomerRouteDeps): void {
  const preHandler = authenticate(deps);
  app.get('/customers', { preHandler }, (request, reply) => handleCustomers(request, reply, deps));
  app.get<{ Params: { customer_id: string } }>(
    '/customers/:customer_id/profile',
    { preHandler },
    (request, reply) => handleCustomerProfile(request, reply, deps),
  );
}

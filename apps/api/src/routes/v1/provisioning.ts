import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { AutonomyAdminPort } from './autonomy-admin.js';
export interface ProvisioningCreateInput {
  readonly idempotency_key?: string;
  readonly display_name?: string;
  /** Legacy client field intentionally ignored; the server derives the request fingerprint. */
  readonly fingerprint?: string;
}

export interface ProvisioningTenantProjection {
  readonly tenant_id: string;
  readonly status: string;
  readonly capabilities: unknown;
  readonly connectors: unknown;
  readonly unresolved_owner_inputs: readonly string[];
  readonly autonomy: unknown;
}

export interface ProvisioningRoutePort {
  createShell(input?: ProvisioningCreateInput): Promise<ProvisioningTenantProjection>;
  getShell(tenant_id: string): Promise<ProvisioningTenantProjection | null>;
}

/*
 * This seam intentionally stays structural. The core package's provisioning module is injected by
 * the composition root and is not a public package subpath.
 */

export interface ProvisioningRouteDependencies {
  readonly provisioning: ProvisioningRoutePort;
  readonly autonomyAdmin?: AutonomyAdminPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isProvisioningCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === code;
}

function isProvisioningIdempotencyConflict(error: unknown): boolean {
  if (isProvisioningCode(error, 'IDEMPOTENCY_CONFLICT')) return true;
  if (!isProvisioningCode(error, '23505')) return false;
  return (
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    error.constraint === 'tenants_idempotency_key_key'
  );
}

/** Registers tenant-shell provisioning behind the authenticated operator boundary. */
export function registerProvisioningRoutes(
  app: FastifyInstance,
  deps: ProvisioningRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  const createTenantShell = async (request: FastifyRequest, reply: FastifyReply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      if (principal.scope !== 'platform') {
        fail(
          'INSUFFICIENT_AUTHORITY',
          'tenant provisioning requires a platform-scoped operator',
        );
      }
      const body: unknown = request.body;
      if (body !== undefined && body !== null && !isPlainRecord(body)) {
        fail('VALIDATION_FAILED', 'the request body must be a JSON object when supplied');
      }

      const bodyRecord = isPlainRecord(body) ? body : {};
      const rawDisplayName = bodyRecord['display_name'];
      if (typeof rawDisplayName !== 'string') {
        fail('VALIDATION_FAILED', 'display_name is required');
      }
      const display_name = rawDisplayName.trim();
      if (display_name.length < 1 || display_name.length > 128) {
        fail('VALIDATION_FAILED', 'display_name must contain 1 to 128 characters');
      }
      const bodyKey = typeof bodyRecord['idempotency_key'] === 'string'
        && bodyRecord['idempotency_key'].trim().length > 0
        ? bodyRecord['idempotency_key']
        : undefined;
      const headerKey = stringHeader(request.headers['idempotency-key']);
      const idempotency_key = bodyKey ?? headerKey;
      if (idempotency_key === undefined) {
        fail('VALIDATION_FAILED', 'an Idempotency-Key header or idempotency_key body field is required');
      }
      const input: ProvisioningCreateInput = { display_name, idempotency_key };

      const shell = await deps.provisioning.createShell(input);
      await runtime.audit.record({
        tenant_id: shell.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'provisioning.tenants.create',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { tenant_id: shell.tenant_id },
      });
      return reply.code(201).send(shell);
    } catch (error) {
      if (isProvisioningIdempotencyConflict(error)) {
        try {
          fail('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused with a different request fingerprint');
        } catch (failure) {
          return replyFailure(reply, failure, correlationIdOf(request, runtime));
        }
      }
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  };

  app.post('/provisioning/tenants', { preHandler }, createTenantShell);

  const autonomyAdmin = deps.autonomyAdmin;
  if (autonomyAdmin !== undefined) {
  app.get('/admin/tenants/current', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      const shell = await deps.provisioning.getShell(principal.tenant_id);
      if (shell === null) fail('NOT_FOUND', 'the authenticated tenant has not been provisioned');
      const autonomy = await autonomyAdmin.inspect({ tenant_id: principal.tenant_id });
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'provisioning.tenants.current',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { tenant_id: principal.tenant_id },
      });

      return reply.code(200).send({
        tenant_id: principal.tenant_id,
        status: shell.status,
        capabilities: shell.capabilities,
        connector_readiness: shell.connectors,
        unresolved_owner_inputs: shell.unresolved_owner_inputs,
        autonomy,
        autonomy_summary: autonomy,
        // These fields are explicit absence, never fabricated health or KPI data.
        kpi: { status: 'UNAVAILABLE' as const },
        provider_health: { status: 'UNAVAILABLE' as const },
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
  }
}

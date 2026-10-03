import type { FastifyInstance } from 'fastify';

import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { OwnerInputRecord } from '@agentos/database';
import type { ProvisioningRoutePort } from './provisioning.js';
import {
  companyOwnerInputResolveRouteSchema,
  companyOwnerInputsRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

const OWNER_INPUT_IDS: Readonly<Record<string, true>> = {
  'ASM-001': true,
  'ASM-002': true,
  'ASM-003': true,
  'ASM-004': true,
  FLOOR_POLICY: true,
  REFUND_POLICY: true,
  RETENTION_POLICY: true,
  KPI_BASELINE: true,
  PROVIDER_CREDENTIALS: true,
  RESIDENCY_REGION: true,
  PROMOTION_LIMITS: true,
  careOnboardingItinerary: true,
};

interface OwnerInputParams {
  readonly id: string;
}

type OwnerInputResolutionBody =
  | { readonly value: Readonly<Record<string, unknown>> }
  | { readonly value_ref: string };

interface OwnerInputSummary {
  readonly input_id: string;
  readonly status: OwnerInputRecord['status'];
  readonly version: number;
  readonly resolved_at: string | null;
}

function summaryOf(input: OwnerInputRecord): OwnerInputSummary {
  return {
    input_id: input.input_id,
    status: input.status,
    version: input.version,
    resolved_at: input.resolved_at,
  };
}

function expectedVersion(value: string | undefined): number {
  if (value === undefined) fail('VALIDATION_FAILED', 'If-Match is required');
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (match === null || !Number.isSafeInteger(version) || version < 1) {
    fail('VALIDATION_FAILED', 'If-Match must contain a positive owner-input version');
  }
  return version;
}

function validateResolution(input_id: string, body: OwnerInputResolutionBody): void {
  const keys = Object.keys(body);
  if (keys.length !== 1 || (keys[0] !== 'value' && keys[0] !== 'value_ref')) {
    fail('VALIDATION_FAILED', 'resolution must contain exactly one value or value_ref');
  }
  if ('value_ref' in body) {
    const value_ref = body.value_ref;
    if (typeof value_ref !== 'string' || value_ref.trim().length === 0 || value_ref.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(value_ref)) {
      fail('VALIDATION_FAILED', 'value_ref must be a non-empty reference up to 4096 characters');
    }
    return;
  }
  if (input_id === 'PROVIDER_CREDENTIALS') {
    fail('VALIDATION_FAILED', 'provider credentials must be stored behind a reference');
  }
  if (body.value === null || Array.isArray(body.value) || typeof body.value !== 'object') {
    fail('VALIDATION_FAILED', 'value must be an object');
  }
  const properties = Object.keys(body.value);
  const serialized = JSON.stringify(body.value);
  if (properties.length === 0 || properties.length > 128 || serialized === undefined || serialized.length > 32_768) {
    fail('VALIDATION_FAILED', 'value must be a non-empty object under 32 KB');
  }
}


/** Registers tenant-scoped owner input reads and one-way resolutions with CAS and audit. */
export function registerCompanyOwnerInputsRoutes(
  app: FastifyInstance,
  deps: {
    readonly ownerInputs: ProvisioningRoutePort;
    readonly credentials: CredentialStore;
    readonly runtime: GatewayRuntime;
  },
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);

  app.get('/company/owner-inputs', { preHandler, schema: companyOwnerInputsRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'settings:manage');
      const inputs = await deps.ownerInputs.listOwnerInputs(principal.tenant_id);
      return reply.code(200).send({ items: inputs.map(summaryOf) });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.post<{ Params: OwnerInputParams; Body: OwnerInputResolutionBody }>(
    '/company/owner-inputs/:id/resolve',
    { preHandler, schema: companyOwnerInputResolveRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const principal = requireOperator(request, 'settings:manage');
        const input_id = request.params.id;
        if (OWNER_INPUT_IDS[input_id] !== true) fail('NOT_FOUND', 'owner input does not exist');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
        }
        validateResolution(input_id, request.body);
        const result = await deps.ownerInputs.resolveOwnerInput({
          tenant_id: principal.tenant_id,
          input_id,
          expected_version: expectedVersion(request.headers['if-match']),
          ...('value' in request.body ? { value: request.body.value } : { value_ref: request.body.value_ref }),
          actor_kind: principal.kind,
          actor_id: operator_id,
          correlation_id,
        });
        if (result.status !== 'RESOLVED') {
          if (result.status === 'NOT_FOUND') fail('NOT_FOUND', 'owner input does not exist');
          fail('VERSION_CONFLICT', 'owner input changed; reload before resolving');
        }
        return reply.code(200).header('ETag', `"${result.input.version}"`).send({ input: summaryOf(result.input) });
      } catch (error) {
        return replyFailure(reply, error, correlation_id);
      }
    },
  );
}

/**
 * @file Platform-scoped run projections and cross-company run commands (T8.1, decision D9).
 *
 * The platform control plane is not tenant-bound: `requirePlatformAdmin` proves the caller holds a
 * platform scope, and the run filters (`tenant_id`, `state`, `domain`) are explicit operator inputs,
 * never an implicit tenant binding. Reads go through the fixed SECURITY DEFINER projections, which
 * return derived fields only. Commands execute in the target company's RLS context via the
 * tenant-scoped `runtime.runs` port (`withTenantContext(:id)`) and are audited with actor + target.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getErrorCatalogEntry } from '@agentos/core-engine';

import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime, PlatformDirectoryPort } from '../../gateway/ports.js';

export interface PlatformRunsRouteDependencies {
  readonly platform: PlatformDirectoryPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlatformAdmin(request: FastifyRequest) {
  const principal = requireOperator(request, 'platform:admin');
  if (principal.scope !== 'platform') {
    fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
  }
  return principal;
}

function companyRunParams(request: FastifyRequest): { readonly company_id: string; readonly run_id: string } {
  const params = isPlainRecord(request.params) ? request.params : {};
  const company_id = params['id'];
  const run_id = params['runId'];
  if (typeof company_id !== 'string' || company_id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'company id is required');
  }
  if (typeof run_id !== 'string' || run_id.trim().length === 0) {
    fail('VALIDATION_FAILED', 'run id is required');
  }
  return { company_id, run_id };
}

function optionalQueryString(request: FastifyRequest, key: string): string | undefined {
  const query = request.query;
  const values = typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
  const value = values[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function queryLimit(request: FastifyRequest): number | undefined {
  const raw = optionalQueryString(request, 'limit');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    fail('VALIDATION_FAILED', 'limit must be an integer between 1 and 200');
  }
  return parsed;
}

type ReconciliationResolution =
  | 'PROVIDER_CONFIRMED_SUCCEEDED'
  | 'PROVIDER_CONFIRMED_ABSENT'
  | 'ESCALATE_MANUALLY';

function isResolution(value: unknown): value is ReconciliationResolution {
  return value === 'PROVIDER_CONFIRMED_SUCCEEDED'
    || value === 'PROVIDER_CONFIRMED_ABSENT'
    || value === 'ESCALATE_MANUALLY';
}

/** Registers read projections and the retry/reconcile commands of the platform run console. */
export function registerPlatformRunsRoutes(
  app: FastifyInstance,
  deps: PlatformRunsRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  app.get('/platform/runs', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const search = optionalQueryString(request, 'search');
      const items = await deps.platform.listRuns({
        ...(optionalQueryString(request, 'company_id') === undefined ? {} : { tenant_id: optionalQueryString(request, 'company_id') as string }),
        ...(optionalQueryString(request, 'state') === undefined ? {} : { state: optionalQueryString(request, 'state') as string }),
        ...(optionalQueryString(request, 'domain') === undefined ? {} : { domain: optionalQueryString(request, 'domain') as string }),
        ...(queryLimit(request) === undefined ? {} : { limit: queryLimit(request) as number }),
        ...(optionalQueryString(request, 'before') === undefined ? {} : { before: optionalQueryString(request, 'before') as string }),
        ...(search === undefined ? {} : { search }),
      });
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/runs/summary', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const items = await deps.platform.runsSummary();
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/runs/reconciliation', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const items = await deps.platform.reconciliationQueue({
        ...(optionalQueryString(request, 'company_id') === undefined ? {} : { tenant_id: optionalQueryString(request, 'company_id') as string }),
        ...(queryLimit(request) === undefined ? {} : { limit: queryLimit(request) as number }),
      });
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get('/platform/companies/:id/runs/:runId', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const { company_id, run_id } = companyRunParams(request);
      const detail = await deps.platform.runDetail(company_id, run_id);
      if (detail === null) fail('TASK_NOT_FOUND', 'this company holds no durable task with that identifier');
      return reply.code(200).send(detail);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
  app.get('/platform/companies/:id/runs/:runId/trace', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      requirePlatformAdmin(request);
      const { company_id, run_id } = companyRunParams(request);
      const detail = await deps.platform.runDetail(company_id, run_id);
      if (detail === null) fail('TASK_NOT_FOUND', 'this company holds no durable task with that identifier');

      const trace = await deps.platform.runTraceDetails(company_id, run_id);
      const steps = trace.steps.map((step) => ({
        ...step,
        // A step without a failure carries no code at all (absent, not only null).
        error_hint: typeof step.error_code !== 'string' || step.error_code.length === 0
          ? null
          : getErrorCatalogEntry(step.error_code)?.admin_hint
            ?? 'Review the error code and allowlisted step details before resolving the run.',
      }));
      return reply.code(200).send({
        ...trace,
        run_id: detail.run_id,
        correlation_id: detail.correlation_id,
        domain: detail.domain,
        state: { business: detail.state, raw: detail.state },
        attempts: detail.attempts,
        duration_ms: detail.duration_ms ?? 0,
        steps,
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });


  app.post('/platform/companies/:id/runs/:runId/retry', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);
    try {
      const principal = requirePlatformAdmin(request);
      const operator_id = principal.operator_id;
      if (operator_id === undefined || operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'the authenticated principal carries no operator identifier');
      }
      const { company_id, run_id } = companyRunParams(request);
      const body = isPlainRecord(request.body) ? request.body : {};
      const reason = typeof body['reason'] === 'string' ? body['reason'] : '';

      const classification = await runtime.runs.classifyRetry(company_id, run_id);
      if (!classification.retryable) {
        if (classification.reason === 'NOT_FOUND') {
          fail('TASK_NOT_FOUND', 'this company holds no durable task with that identifier');
        }
        if (classification.reason === 'UNKNOWN') {
          fail(
            'RUN_NOT_RECONCILABLE',
            'the failed attempt has an indeterminate outcome; it is reconciled by effect key and never re-dispatched blind',
          );
        }
        fail('RUN_NOT_RETRYABLE', 'the run is not in a failed state, so there is nothing to re-queue');
      }

      const started = await runtime.runs.retry({
        tenant_id: company_id,
        run_id,
        operator_id,
        reason,
      });

      await runtime.audit.record({
        tenant_id: company_id,
        correlation_id,
        operation: 'platform.runs.retry',
        principal_kind: principal.kind,
        operator_id,
        outcome: 'ACCEPTED',
        detail: {
          target_tenant: company_id,
          run_id,
          failure_class: classification.failure_class,
          ...(reason === '' ? {} : { reason }),
        },
      });

      return reply.code(202).send({
        run_id: started.run_id,
        status: started.lifecycle_state === 'queued' ? 'accepted' : started.lifecycle_state,
        correlation_id,
      });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.post('/platform/companies/:id/runs/:runId/reconcile', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);
    try {
      const principal = requirePlatformAdmin(request);
      const operator_id = principal.operator_id;
      if (operator_id === undefined || operator_id.length === 0) {
        fail('AUTHENTICATION_FAILED', 'the authenticated principal carries no operator identifier');
      }
      const { company_id, run_id } = companyRunParams(request);
      if (!isPlainRecord(request.body)) {
        fail('VALIDATION_FAILED', 'the request body must be a JSON object');
      }
      const body = request.body;
      const resolution = body['resolution'];
      const reason = body['reason'];
      if (!isResolution(resolution)) {
        fail(
          'VALIDATION_FAILED',
          'resolution must be PROVIDER_CONFIRMED_SUCCEEDED, PROVIDER_CONFIRMED_ABSENT or ESCALATE_MANUALLY',
        );
      }
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        fail('VALIDATION_FAILED', 'reason is mandatory for a reconciliation resolution');
      }
      const receipt = body['receipt'];
      if (receipt !== undefined && !isPlainRecord(receipt)) {
        fail('VALIDATION_FAILED', 'receipt must be a JSON object when supplied');
      }

      const accepted = await runtime.runs.reconcile({
        tenant_id: company_id,
        run_id,
        resolution,
        reason,
        operator_id,
        ...(receipt === undefined ? {} : { receipt: receipt as Record<string, unknown> }),
      });

      await runtime.audit.record({
        tenant_id: company_id,
        correlation_id,
        operation: 'platform.runs.reconciliation',
        principal_kind: principal.kind,
        operator_id,
        outcome: 'ACCEPTED',
        detail: { target_tenant: company_id, run_id, resolution, has_provider_receipt: receipt !== undefined },
      });

      return reply.code(202).send({ run_id: accepted.run_id, resolution, correlation_id });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

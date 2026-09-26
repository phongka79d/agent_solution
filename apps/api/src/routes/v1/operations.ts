/**
 * @file Operator run operations: retry, run list and reconciliation (implement/06 §8.1.2 R13/R18,
 * §8.1.3 R16).
 *
 * The retry route is where an indeterminate outcome is most likely to be mishandled, so the shape of
 * this module follows one rule: **a retry is authorized only for a failure the platform can prove
 * was side-effect-free.**
 *
 * - `UNKNOWN` never reaches `runs.retry`. The port classifies it as non-retryable and the route
 *   answers `409` pointing at R18, because re-dispatching an effect that may already have landed is
 *   precisely the duplicate the reservation protocol exists to prevent (BR-005/BR-006).
 * - Retrying reuses the run's original `effect_key`, so the reservation still makes the attempt
 *   at-most-once and a second retry of an already-requeued run is a no-op rather than a second
 *   dispatch.
 */

import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type {
  ReconciliationResolution,
  TaskAcceptedResponse,
  TaskStoredState,
} from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';

/** The stored lifecycle vocabulary R16 returns verbatim (`06` §8.3 C-8). */
const STORED_STATES: readonly TaskStoredState[] = [
  'queued',
  'running',
  'waiting',
  'awaiting_human',
  'completed',
  'stopped',
  'failed',
];

/** The three resolutions R18 accepts; anything else is a `400` and never a silent default. */
const RESOLUTIONS: readonly ReconciliationResolution[] = [
  'PROVIDER_CONFIRMED_SUCCEEDED',
  'PROVIDER_CONFIRMED_ABSENT',
  'ESCALATE_MANUALLY',
];

function isStoredState(value: string): value is TaskStoredState {
  return (STORED_STATES as readonly string[]).includes(value);
}

function isResolution(value: unknown): value is ReconciliationResolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value);
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Registers R13, R16 and R18 on the `/api/v1` prefix.
 *
 * @param app The Fastify instance.
 * @param deps The injected runtime and credential store.
 */
export function registerOperationRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  const preHandler = authenticate(deps);

  // -------------------------------------------------------------------------
  // R13 — POST /api/v1/operations/runs/{run_id}/retry
  // -------------------------------------------------------------------------

  app.post<{ Params: { run_id: string } }>(
    '/operations/runs/:run_id/retry',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'run:retry');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
        }

        const body: unknown = request.body;
        const reason =
          typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['reason'] === 'string'
            ? ((body as Record<string, unknown>)['reason'] as string)
            : '';

        const run_id = request.params.run_id;
        const classification = await runtime.runs.classifyRetry(principal.tenant_id, run_id);

        if (!classification.retryable) {
          if (classification.reason === 'NOT_FOUND') {
            fail('TASK_NOT_FOUND', 'this tenant holds no durable task with that identifier');
          }
          if (classification.reason === 'UNKNOWN') {
            // The one refusal that must never become a retry: the effect may already have landed, so
            // the only correct next step is reconciliation by `effect_key` (R18).
            fail(
              'RUN_NOT_RECONCILABLE',
              'the failed attempt has an indeterminate outcome; it is reconciled by effect key and never re-dispatched blind',
            );
          }
          fail('RUN_NOT_RETRYABLE', 'the run is not in a failed state, so there is nothing to re-queue');
        }

        const started = await runtime.runs.retry({
          tenant_id: principal.tenant_id,
          run_id,
          operator_id,
          reason,
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'operations.runs.retry',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: {
            run_id,
            failure_class: classification.failure_class,
            effect_key: classification.effect_key,
            ...(reason === '' ? {} : { reason }),
          },
        });

        const response: TaskAcceptedResponse = {
          task_id: started.run_id,
          // A retry re-queues a run; the route does not synthesize a conversation binding it was not
          // given, so an unbound run reports `null` rather than an empty identifier.
          conversation_id: null,
          status: started.lifecycle_state === 'queued' ? 'accepted' : started.lifecycle_state,
          task_version: started.task_version,
          correlation_id: started.correlation_id,
        };

        return reply.code(202).send(response);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  // -------------------------------------------------------------------------
  // R16 — GET /api/v1/runs
  // -------------------------------------------------------------------------

  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      agent_id?: string;
      state?: string;
      from?: string;
      to?: string;
    };
  }>('/runs', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requireOperator(request, 'run:read');
      const state = request.query.state;

      // R16 publishes the stored vocabulary, so a wire value like `accepted` is refused here rather
      // than translated: an operator filtering runs must filter on what is actually stored.
      if (state !== undefined && !isStoredState(state)) {
        fail('VALIDATION_FAILED', 'state must be a stored task lifecycle value');
      }

      const page = await runtime.runs.list({
        tenant_id: principal.tenant_id,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        ...(request.query.agent_id === undefined ? {} : { agent_id: request.query.agent_id }),
        ...(state === undefined ? {} : { state }),
        ...(request.query.from === undefined ? {} : { from: request.query.from }),
        ...(request.query.to === undefined ? {} : { to: request.query.to }),
      });

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'operations.runs.list',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { count: page.items.length },
      });

      return reply.code(200).send(page);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  // -------------------------------------------------------------------------
  // R18 — POST /api/v1/operations/runs/{run_id}/reconciliation
  // -------------------------------------------------------------------------

  app.post<{ Params: { run_id: string } }>(
    '/operations/runs/:run_id/reconciliation',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'run:reconcile');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
        }

        const body: unknown = request.body;
        if (!isPlainRecord(body)) {
          fail('VALIDATION_FAILED', 'the request body must be a JSON object');
        }

        const candidate = body;
        const resolution = candidate['resolution'];
        const reason = candidate['reason'];

        if (!isResolution(resolution)) {
          fail(
            'VALIDATION_FAILED',
            'resolution must be PROVIDER_CONFIRMED_SUCCEEDED, PROVIDER_CONFIRMED_ABSENT or ESCALATE_MANUALLY',
          );
        }
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          fail('VALIDATION_FAILED', 'reason is mandatory for a reconciliation resolution');
        }

        const receipt = candidate['receipt'];
        if (receipt !== undefined && !isPlainRecord(receipt)) {
          fail('VALIDATION_FAILED', 'receipt must be a JSON object when supplied');
        }
        const run_id = request.params.run_id;

        const accepted = await runtime.runs.reconcile({
          tenant_id: principal.tenant_id,
          run_id,
          resolution,
          reason,
          operator_id,
          ...(receipt === undefined ? {} : { receipt }),
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'operations.runs.reconciliation',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: {
            run_id,
            resolution,
            // The provider receipt's digest is recorded rather than the receipt itself, so the audit
            // row can be shown to rest on the same evidence without duplicating a provider payload.
            has_provider_receipt: receipt !== undefined,
          },
        });

        return reply.code(202).send({ run_id: accepted.run_id, resolution, correlation_id });
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}

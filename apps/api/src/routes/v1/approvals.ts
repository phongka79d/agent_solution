/**
 * @file Approval queue, approval detail and the decision route (implement/06 §8.1.1 R05, §8.1.3 R14,
 * §8.2.1).
 *
 * The decision route is the only place a human authorizes an action, and three properties make it
 * safe:
 *
 * - **The approver is the credential, not the payload.** `operator_id` in the body is ignored;
 *   `principal.operator_id` is what the port is given, so a caller cannot attribute a decision to
 *   someone else.
 * - **The reviewed digest is restated.** `expected_payload_sha256` must be the digest the approver
 *   actually saw. A payload that changed after the queue was read is `APPROVAL_STALE_PAYLOAD` — the
 *   compare-and-set in the repository is what decides, and it re-verifies inside one transaction.
 * - **There is no second approval surface.** No `/execute`, no `/release`, no sixth decision; the
 *   five baseline decisions are the whole contract (`06` §8.1.1).
 */

import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type {
  ApprovalDecision,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
} from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import {
  approvalDecisionRouteSchema,
  approvalDetailRouteSchema,
  approvalsListRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

/** The five baseline SCR-003 decisions. */
const DECISIONS: readonly ApprovalDecision[] = ['APPROVE', 'REJECT', 'MODIFY', 'PAUSE', 'CANCEL'];

const MAX_REASON_LENGTH = 1000;

function isDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Registers R14, the §8.2.1 detail read and R05 on the `/api/v1` prefix.
 *
 * @param app The Fastify instance.
 * @param deps The injected runtime and credential store.
 */
export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);

  // -------------------------------------------------------------------------
  // R14 — GET /api/v1/approvals?status=PENDING
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    '/approvals',
    { preHandler, schema: approvalsListRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'approval:read');
        const status = request.query.status ?? 'PENDING';

        // `PENDING` is the only supported filter in the baseline: the queue is exactly the pending
        // projection, and a paused-but-undecided item appears in it once with `is_paused = true`.
        if (status !== 'PENDING') {
          fail('VALIDATION_FAILED', 'status must be PENDING: it is the only supported queue filter');
        }

        const rawLimit = request.query.limit;
        let parsedLimit: number | undefined;
        if (rawLimit !== undefined) {
          if (!/^\d+$/.test(rawLimit) || rawLimit === '0') {
            fail('VALIDATION_FAILED', 'limit must be a positive integer');
          }
          parsedLimit = Number.parseInt(rawLimit, 10);
        }
        const page = await runtime.approvals.list({
          tenant_id: principal.tenant_id,
          status: 'PENDING',
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'approvals.list',
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { count: page.items.length, status },
        });

        return reply.code(200).send(page);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  // -------------------------------------------------------------------------
  // §8.2.1 — GET /api/v1/approvals/{approval_id}
  // -------------------------------------------------------------------------

  app.get<{ Params: { approval_id: string } }>(
    '/approvals/:approval_id',
    { preHandler, schema: approvalDetailRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'approval:read');

        // A cross-tenant identifier resolves to `null` and is answered `404`: the row is not
        // redacted into existence, because its absence is itself information the caller may not have.
        const detail = await runtime.approvals.detail(principal.tenant_id, request.params.approval_id);
        if (detail === null) {
          fail('NOT_FOUND', 'this tenant holds no approval with that identifier');
        }

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'approvals.detail',
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { approval_id: detail.approval_id },
        });

        return reply.code(200).send(detail);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  // -------------------------------------------------------------------------
  // R05 — POST /api/v1/approvals/{approval_id}/decision
  // -------------------------------------------------------------------------

  app.post<{ Params: { approval_id: string } }>(
    '/approvals/:approval_id/decision',
    { preHandler, schema: approvalDecisionRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'approval:decide');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
        }

        const body: unknown = request.body;
        if (!isPlainRecord(body)) {
          fail('VALIDATION_FAILED', 'the request body must be a JSON object');
        }

        const candidate: Partial<ApprovalDecisionRequest> = body;
        const decision = candidate.decision;

        if (!isDecision(decision)) {
          fail('VALIDATION_FAILED', 'decision must be one of APPROVE, REJECT, MODIFY, PAUSE or CANCEL');
        }
        if (typeof candidate.reason !== 'string' || candidate.reason.trim().length === 0) {
          fail('VALIDATION_FAILED', 'reason is mandatory for every decision');
        }
        if (candidate.reason.length > MAX_REASON_LENGTH) {
          fail('VALIDATION_FAILED', `reason exceeds the ${MAX_REASON_LENGTH} character limit`);
        }
        if (typeof candidate.expected_payload_sha256 !== 'string' || candidate.expected_payload_sha256.length === 0) {
          fail(
            'VALIDATION_FAILED',
            'expected_payload_sha256 is required: the decision must restate the payload digest the approver reviewed',
          );
        }
        if (decision === 'MODIFY' && !isPlainRecord(candidate.modified_payload)) {
          fail('VALIDATION_FAILED', 'modified_payload must be a JSON object for a MODIFY decision');
        }
        if (decision !== 'MODIFY' && candidate.modified_payload !== undefined) {
          fail('VALIDATION_FAILED', 'modified_payload is only valid on a MODIFY decision');
        }

        const approval_id = request.params.approval_id;
        const detail = await runtime.approvals.detail(principal.tenant_id, approval_id);
        if (detail === null) {
          fail('NOT_FOUND', 'this tenant holds no approval with that identifier');
        }
        if (detail.status === 'EXPIRED') {
          fail('APPROVAL_EXPIRED', 'this approval crossed its review deadline and cannot receive a decision');
        }


        let require_distinct_approver = false;
        const governance = runtime.governance;
        if (governance !== undefined) {
          try {
            const settings = await governance.get(principal.tenant_id);
            require_distinct_approver = settings.require_distinct_approver;
          } catch {
            fail('PROVIDER_TIMEOUT', 'governance settings could not be read; the decision was refused');
          }
        }

        if (require_distinct_approver) {
          let run: { readonly session_id?: string } | null = null;
          try {
            run = await runtime.runs.read({ tenant_id: principal.tenant_id, run_id: detail.run_id });
          } catch {
            fail('PROVIDER_TIMEOUT', 'the draft owner could not be read; the decision was refused');
          }
          if (run === null || run.session_id === undefined || run.session_id.length === 0) {
            fail('PROVIDER_TIMEOUT', 'the draft owner could not be read; the decision was refused');
          }
          if (run.session_id === operator_id) {
            fail('APPROVER_MUST_DIFFER', 'the approver must differ from the draft owner');
          }
        }

        const decided = await runtime.approvals.decide({
          tenant_id: principal.tenant_id,
          approval_id,
          run_id: detail.run_id,
          effect_key: detail.effect_key,
          expected_payload_sha256: candidate.expected_payload_sha256,
          decision,
          operator_id,
          reason: candidate.reason,
          ...(candidate.modified_payload === undefined ? {} : { modified_payload: candidate.modified_payload }),
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'approvals.decision',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: {
            approval_id,
            run_id: detail.run_id,
            effect_key: detail.effect_key,
            decision,
            // The digest the approver reviewed is recorded, so the audit row and the decision row
            // can be shown to have rested on the same bytes.
            expected_payload_sha256: candidate.expected_payload_sha256,
          },
        });

        const response: ApprovalDecisionResponse = {
          approval_id: decided.approval_id,
          task_id: decided.task_id,
          status: decided.status,
          queued_at: decided.queued_at,
          correlation_id,
        };

        return reply.code(202).send(response);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}

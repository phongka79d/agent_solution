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

/** The five baseline SCR-003 decisions. */
const DECISIONS: readonly ApprovalDecision[] = ['APPROVE', 'REJECT', 'MODIFY', 'PAUSE', 'CANCEL'];

function isDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
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
  const preHandler = authenticate(deps);

  // -------------------------------------------------------------------------
  // R14 — GET /api/v1/approvals?status=PENDING
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    '/approvals',
    { preHandler },
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

        const page = await runtime.approvals.list({
          tenant_id: principal.tenant_id,
          status: 'PENDING',
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
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
    { preHandler },
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
    { preHandler },
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
        if (typeof body !== 'object' || body === null) {
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
        if (typeof candidate.expected_payload_sha256 !== 'string' || candidate.expected_payload_sha256.length === 0) {
          fail(
            'VALIDATION_FAILED',
            'expected_payload_sha256 is required: the decision must restate the payload digest the approver reviewed',
          );
        }
        if (decision !== 'MODIFY' && candidate.modified_payload !== undefined) {
          fail('VALIDATION_FAILED', 'modified_payload is only valid on a MODIFY decision');
        }

        const approval_id = request.params.approval_id;
        const detail = await runtime.approvals.detail(principal.tenant_id, approval_id);
        if (detail === null) {
          fail('NOT_FOUND', 'this tenant holds no approval with that identifier');
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
          decided_at: decided.decided_at,
          correlation_id,
        };

        return reply.code(200).send(response);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}

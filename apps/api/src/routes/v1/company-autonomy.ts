import type { FastifyInstance } from 'fastify';

import { authenticate, requireOperator } from '../../gateway/principal.js';
import type { CredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { PromotionDecisionCommand, PromotionRequestCommand } from './autonomy-admin.js';

/**
 * The company-facing autonomy surface (T4.5): one draft-gated skill's promotion request, the
 * server-computed evidence window behind it, and the second, distinct operator's decision. The
 * tenant-wide pause/resume/demotion controls live in `autonomy-admin.ts`.
 */
export interface CompanyAutonomyPort {
  requestPromotion(command: PromotionRequestCommand): Promise<unknown> | unknown;
  decidePromotion(command: PromotionDecisionCommand): Promise<unknown> | unknown;
  listPromotionRequests(command: { readonly tenant_id: string; readonly status?: string }): Promise<unknown> | unknown;
}

export interface CompanyAutonomyRouteDependencies {
  readonly autonomyAdmin: CompanyAutonomyPort;
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Registers the company promotion routes under `/api/v1/company/autonomy`. The evidence window is
 * computed server-side from durable run stage results; a compare-and-set conflict on the policy
 * revision surfaces as 409 `VERSION_CONFLICT` rather than a silent last-write-wins.
 */
export function registerCompanyAutonomyRoutes(
  app: FastifyInstance,
  deps: CompanyAutonomyRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  app.post<{ Params: { skill_id: string } }>(
    '/company/autonomy/:skill_id/promotion-requests',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'agents:manage');
        const skill_id = request.params.skill_id.trim();
        if (skill_id.length === 0) fail('VALIDATION_FAILED', 'skill_id is required');
        const body = isPlainRecord(request.body) ? request.body : {};
        const policy_version = typeof body['policy_version'] === 'string' ? body['policy_version'].trim() : '';
        if (policy_version.length === 0) fail('VALIDATION_FAILED', 'policy_version is required');
        const required_authority = typeof body['required_authority'] === 'string'
          ? body['required_authority'].trim()
          : '';
        if (required_authority.length === 0) fail('VALIDATION_FAILED', 'required_authority is required');
        const reason = typeof body['reason'] === 'string' && body['reason'].trim().length > 0
          ? body['reason'].trim()
          : undefined;
        const expected_revision = typeof body['expected_revision'] === 'number'
          && Number.isSafeInteger(body['expected_revision'])
          ? body['expected_revision']
          : undefined;
        const result = await deps.autonomyAdmin.requestPromotion({
          tenant_id: principal.tenant_id,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          skill_id,
          policy_version,
          required_authority,
          ...(reason === undefined ? {} : { reason }),
          ...(expected_revision === undefined ? {} : { expected_revision }),
        });
        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id: correlationIdOf(request, runtime),
          operation: 'autonomy.promotion.request',
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { skill_id, policy_version },
        });
        return reply.code(200).send(result);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/company/autonomy/promotion-requests/:id/decision',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'agents:manage');
        const request_id = request.params.id.trim();
        if (request_id.length === 0) fail('VALIDATION_FAILED', 'request id is required');
        const body = isPlainRecord(request.body) ? request.body : {};
        const decision = body['decision'];
        if (decision !== 'APPROVE' && decision !== 'REJECT') {
          fail('VALIDATION_FAILED', 'decision must be APPROVE or REJECT');
        }
        const reason = typeof body['reason'] === 'string' && body['reason'].trim().length > 0
          ? body['reason'].trim()
          : undefined;
        const result = await deps.autonomyAdmin.decidePromotion({
          tenant_id: principal.tenant_id,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          request_id,
          decision,
          ...(reason === undefined ? {} : { reason }),
        });
        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id: correlationIdOf(request, runtime),
          operation: 'autonomy.promotion.decision',
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { request_id, decision },
        });
        return reply.code(200).send(result);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  app.get('/company/autonomy/promotion-requests', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'agents:manage');
      const query = request.query as Record<string, unknown> | undefined;
      const status = typeof query?.['status'] === 'string' ? query['status'] : undefined;
      const result = await deps.autonomyAdmin.listPromotionRequests({
        tenant_id: principal.tenant_id,
        ...(status === undefined ? {} : { status }),
      });
      return reply.code(200).send(result);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

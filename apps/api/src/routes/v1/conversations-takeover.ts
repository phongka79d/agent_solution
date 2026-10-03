import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CareHandoffClaimOutcome } from '@agentos/database';

import type {
  ConversationResumeResponse,
  ConversationTakeoverHeartbeatResponse,
  ConversationTakeoverResponse,
} from '../../gateway/contracts.js';
import { requireOperator } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail } from '../../gateway/http.js';
import type { ConversationRouteDeps } from './conversations.js';

import {
  conversationResumeRouteSchema,
  conversationTakeoverHeartbeatRouteSchema,
  conversationTakeoverRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';
type ConversationPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type RequiredString = (body: unknown, field: string, max_length?: number) => string;
type Refuse = (reply: FastifyReply, request: FastifyRequest, runtime: GatewayRuntime, error: unknown) => FastifyReply;

interface ConversationTakeoverRouteHelpers {
  readonly requiredString: RequiredString;
  readonly refuse: Refuse;
}

/**
 * Registers R06, R07 and R08 on the `/api/v1` prefix.
 *
 * The façade supplies the shared authentication pre-handler and body/refusal helpers so the
 * extracted handlers retain the exact same tenant binding and error-envelope behavior as the
 * other conversation routes.
 */
export function registerConversationTakeoverRoutes(
  app: FastifyInstance,
  deps: ConversationRouteDeps,
  preHandler: ConversationPreHandler,
  helpers: ConversationTakeoverRouteHelpers,
): void {
  registerOpenApiSchemas(app);
  const { requiredString, refuse } = helpers;

  // -------------------------------------------------------------------------
  // R06 — POST /api/v1/conversations/{id}/takeover
  // -------------------------------------------------------------------------

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/takeover',
    { preHandler, schema: conversationTakeoverRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body;
        const reason = requiredString(body, 'reason');
        const takeover_mode = requiredString(body, 'takeover_mode');

        // The enum is `FULL_CONTROL`/`CO_PILOT`; `HUMAN_ACTIVE` is display wording and any other
        // value is a `400` rather than a silently accepted mode (`06` §8.3 C-2).
        if (takeover_mode !== 'FULL_CONTROL' && takeover_mode !== 'CO_PILOT') {
          fail('VALIDATION_FAILED', 'takeover_mode must be FULL_CONTROL or CO_PILOT');
        }

        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }

        const acquired = await runtime.takeover.acquire({
          tenant_id: principal.tenant_id,
          conversation_id,
          operator_id,
          ttl_seconds: 60,
        });

        if (acquired.outcome === 'HELD_BY_ANOTHER_OPERATOR') {
          fail('TAKEOVER_LEASE_HELD', 'another operator already holds the takeover lease for this conversation');
        }
        if (acquired.lease === null) {
          fail('TAKEOVER_LEASE_LOST', 'the takeover lease could not be established for this conversation');
        }

        const releaseNewLease = async () => {
          if (acquired.outcome === 'ACQUIRED') {
            await runtime.takeover.release({
              tenant_id: principal.tenant_id,
              conversation_id,
              operator_id,
            });
          }
        };
        let handoffClaim: CareHandoffClaimOutcome;
        try {
          handoffClaim = await runtime.handoffs.claim({
            tenant_id: principal.tenant_id,
            conversation_id,
            operator_id,
          });
          if (handoffClaim === 'NO_HANDOFF') {
            const transition = await runtime.conversations.setState(
              principal.tenant_id,
              conversation_id,
              conversation.state,
              conversation.takeover_operator_id,
              'paused_takeover',
              operator_id,
            );
            if (transition === 'CONFLICT') {
              fail('VERSION_CONFLICT', 'conversation state changed during takeover; reload before retrying');
            }
          }
        } catch (error) {
          await releaseNewLease();
          throw error;
        }
        if (handoffClaim === 'HELD_BY_ANOTHER_OPERATOR') {
          await releaseNewLease();
          fail('TAKEOVER_LEASE_HELD', 'another operator already owns this durable human handoff');
        }

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.takeover',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: { conversation_id, takeover_mode, reason, lease_outcome: acquired.outcome },
        });

        const response: ConversationTakeoverResponse = {
          conversation_id,
          status: 'HUMAN_TAKEOVER',
          operator_id,
          taken_over_at: runtime.clock().toISOString(),
          lease_expires_at: acquired.lease.expires_at,
        };

        return reply.code(200).send(response);
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // R07 — POST /api/v1/conversations/{id}/takeover/heartbeat
  // -------------------------------------------------------------------------

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/takeover/heartbeat',
    { preHandler, schema: conversationTakeoverHeartbeatRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body;
        const extend_seconds = typeof body === 'object' && body !== null && 'extend_seconds' in body
          ? body.extend_seconds
          : undefined;
        if (typeof extend_seconds !== 'number' || !Number.isInteger(extend_seconds) || extend_seconds < 1 || extend_seconds > 300) {
          fail('VALIDATION_FAILED', 'extend_seconds must be an integer between 1 and 300');
        }

        const renewed = await runtime.takeover.renew({
          tenant_id: principal.tenant_id,
          conversation_id,
          operator_id,
          extend_seconds,
        });

        if (renewed.outcome === 'EXPIRED' || renewed.outcome === 'NOT_HELD') {
          fail(
            'TAKEOVER_LEASE_EXPIRED',
            'this operator holds no live takeover lease for the conversation, so there is nothing to extend',
          );
        }
        if (renewed.outcome === 'HELD_BY_ANOTHER_OPERATOR') {
          fail('TAKEOVER_LEASE_HELD', 'another operator now holds the takeover lease for this conversation');
        }
        if (renewed.lease === null) {
          fail('TAKEOVER_LEASE_LOST', 'the takeover lease could not be extended for this conversation');
        }

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.takeover.heartbeat',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: { conversation_id, extend_seconds, lease_expires_at: renewed.lease.expires_at },
        });

        const response: ConversationTakeoverHeartbeatResponse = {
          conversation_id,
          status: 'HUMAN_TAKEOVER',
          operator_id,
          lease_expires_at: renewed.lease.expires_at,
        };

        return reply.code(200).send(response);
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // R08 — POST /api/v1/conversations/{id}/resume
  // -------------------------------------------------------------------------

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/resume',
    { preHandler, schema: conversationResumeRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body;
        const handoff_summary = typeof body === 'object' && body !== null && 'handoff_summary' in body && typeof body.handoff_summary === 'string'
          ? body.handoff_summary
          : null;
        const next_agent_id = typeof body === 'object' && body !== null && 'next_agent_id' in body && typeof body.next_agent_id === 'string'
          ? body.next_agent_id
          : undefined;

        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }

        const released = await runtime.takeover.release({
          tenant_id: principal.tenant_id,
          conversation_id,
          operator_id,
        });

        // A persisted paused marker is owned by this operator only when the durable row says so;
        // all expiry cleanup below is compare-and-clear against that owner.
        const persistedTakeoverBelongedToOperator =
          conversation.state === 'paused_takeover'
          && conversation.takeover_operator_id === operator_id;
        const staleLeaseBelongedToOperator =
          released.outcome === 'NOT_HELD' && persistedTakeoverBelongedToOperator;
        // A release is owner-checked and idempotent: a repeat by the operator who already handed the
        // conversation back is answered from the same terminal state, never as a double release.
        if (released.outcome === 'HELD_BY_ANOTHER_OPERATOR') {
          fail('TAKEOVER_LEASE_HELD', 'another operator holds the takeover lease for this conversation');
        }

        if (released.outcome === 'NOT_HELD' && conversation.state !== 'open' && !staleLeaseBelongedToOperator) {
          fail(
            'TAKEOVER_LEASE_EXPIRED',
            'this operator holds no live takeover lease, and the conversation is not already back under agent control',
          );
        }
        const handoffCompletion = await runtime.handoffs.complete({
          tenant_id: principal.tenant_id,
          conversation_id,
          operator_id,
          completion_summary: handoff_summary,
        });
        if (handoffCompletion === 'HELD_BY_ANOTHER_OPERATOR') {
          fail('TAKEOVER_LEASE_HELD', 'another operator owns this durable human handoff');
        }
        if (handoffCompletion === 'NOT_ASSIGNED') {
          fail('TAKEOVER_LEASE_LOST', 'this human handoff is not assigned to the authenticated operator');
        }
        if (handoffCompletion === 'NO_HANDOFF') {
          if (persistedTakeoverBelongedToOperator) {
            const cleared = await runtime.conversations.clearTakeoverIfOwned(
              principal.tenant_id,
              conversation_id,
              operator_id,
            );
            if (!cleared) {
              const liveLease = await runtime.takeover.holder(principal.tenant_id, conversation_id);
              if (liveLease !== null && liveLease.operator_id !== operator_id) {
                fail('TAKEOVER_LEASE_HELD', 'another operator now holds the takeover lease for this conversation');
              }
            }
          } else {
            const transition = await runtime.conversations.setState(
              principal.tenant_id,
              conversation_id,
              conversation.state,
              conversation.takeover_operator_id,
              'open',
              null,
            );
            if (transition === 'CONFLICT') {
              fail('VERSION_CONFLICT', 'conversation state changed during resume; reload before retrying');
            }
          }
        }

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.resume',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: {
            conversation_id,
            release_outcome: released.outcome,
            ...(handoff_summary === null ? {} : { handoff_summary }),
            ...(next_agent_id === undefined ? {} : { next_agent_id }),
          },
        });

        const response: ConversationResumeResponse = {
          conversation_id,
          status: 'ACTIVE',
          resumed_at: runtime.clock().toISOString(),
        };

        return reply.code(200).send(response);
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );
}

/** An operator principal always carries its identifier; a missing one is a refusal, not a default. */
function requireOperatorIdentifier(operator_id: string | undefined): string {
  if (operator_id === undefined || operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
  }
  return operator_id;
}

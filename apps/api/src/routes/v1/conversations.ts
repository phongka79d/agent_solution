/**
 * @file Conversation, task and conversation-control routes (implement/06 §8.1.1 R01–R03, R06–R08).
 *
 * Three rules decide this module's shape.
 *
 * 1. **The tenant is never read from the request.** Every port call takes `tenant_id` from
 *    `requirePrincipal(request)`, so a body or query `tenant_id` can only ever be a routing hint
 *    that `authenticate()` has already compared and refused on mismatch (`06` §8.0).
 * 2. **Authority comes from the resolved credential.** A takeover or a resume names an operator in
 *    its body, but the operator the platform acts as is `principal.operator_id`; the body field is
 *    not consulted for authority at all.
 * 3. **A turn is at-most-once.** R02's idempotency is expressed through the canonical effect key and
 *    the stored receipt beside it, so a replay answers from the receipt and a mutated payload under
 *    the same key is the one and only `409` (`TC-CON-011`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  type ConversationResumeResponse,
  type ConversationSessionResponse,
  type ConversationTakeoverHeartbeatResponse,
  type ConversationTakeoverResponse,
  type CreateConversationRequest,
  type PostMessageRequest,
  type TaskAcceptedResponse,
  type TaskStateResponse,
  type TaskStoredState,
  type TaskWireStatus,
} from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';

/** The skill identity a conversational turn is reserved under. */
const CONVERSATION_TURN_SKILL = 'conversation.turn';

/** `06` §8.3 C-8: the wire vocabulary differs from the stored one in exactly one value. */
export function toWireStatus(state: TaskStoredState): TaskWireStatus {
  return state === 'queued' ? 'accepted' : state;
}

/** Reads a required non-empty string field out of an unvalidated body. */
function requiredString(body: unknown, field: string, max_length?: number): string {
  if (typeof body !== 'object' || body === null) {
    fail('VALIDATION_FAILED', 'the request body must be a JSON object');
  }

  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('VALIDATION_FAILED', `${field} is required and must be a non-empty string`);
  }
  if (max_length !== undefined && value.length > max_length) {
    fail('VALIDATION_FAILED', `${field} exceeds the ${String(max_length)} character limit`);
  }

  return value;
}

/** A refusal that carries the code and nothing else: no value from the request is echoed back. */
function refuse(reply: FastifyReply, request: FastifyRequest, runtime: GatewayRuntime, error: unknown): FastifyReply {
  return replyFailure(reply, error, correlationIdOf(request, runtime));
}

/**
 * Registers R01, R02, R03, R06, R07 and R08 on the `/api/v1` prefix.
 *
 * @param app The Fastify instance.
 * @param deps The injected runtime and credential store.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  const preHandler = authenticate(deps);

  // -------------------------------------------------------------------------
  // R01 — POST /api/v1/conversations
  // -------------------------------------------------------------------------

  app.post('/conversations', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requirePrincipal(request);
      const body = request.body as Partial<CreateConversationRequest> | undefined;
      const channel = body?.channel;
      const customer_identifier = requiredString(body, 'customer_identifier');

      if (typeof channel !== 'string') {
        fail('VALIDATION_FAILED', 'channel is required and must name a supported channel');
      }

      // Identity is resolved server-side (`04` §5). An unresolved subject stays `null`: the platform
      // does not invent a customer from a client-asserted handle.
      const identity = await runtime.identity.resolveCustomer({
        tenant_id: principal.tenant_id,
        session_id: principal.session_id ?? customer_identifier,
        channel_type: channel,
        channel_identifier: customer_identifier,
      });

      const conversation = await runtime.conversations.bindOrCreate({
        tenant_id: principal.tenant_id,
        channel,
        external_thread_id: customer_identifier,
        customer_id: identity.customer_id,
      });

      const session_token = await runtime.conversations.issueSessionToken({
        tenant_id: principal.tenant_id,
        conversation_id: conversation.conversation_id,
        channel,
      });

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'conversations.create',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { conversation_id: conversation.conversation_id, bound: conversation.bound },
      });

      const response: ConversationSessionResponse = {
        conversation_id: conversation.conversation_id,
        session_token,
        status:
          conversation.state === 'open' ? 'ACTIVE' : conversation.state === 'closed' ? 'CLOSED' : 'HUMAN_TAKEOVER',
        created_at: conversation.created_at,
      };

      // A bind of an existing thread is a representation of the row that already existed, not the
      // creation of a new one, so it is answered `200` rather than `201`.
      return reply.code(conversation.bound ? 200 : 201).send(response);
    } catch (error) {
      return refuse(reply, request, runtime, error);
    }
  });

  // -------------------------------------------------------------------------
  // R02 — POST /api/v1/conversations/{conversation_id}/messages
  // -------------------------------------------------------------------------

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/messages',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requirePrincipal(request);
        const body = request.body as Partial<PostMessageRequest> | undefined;
        const conversation_id = request.params.conversation_id;

        const message = requiredString(body, 'message', MESSAGE_MAX_LENGTH);
        const idempotency_key = requiredString(body, 'idempotency_key', IDEMPOTENCY_KEY_MAX_LENGTH);
        if (body?.module !== 'support') {
          fail('CAPABILITY_NOT_ENABLED', 'only Customer Care turns are enabled');
        }

        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }
        if (principal.kind === 'CHANNEL_SESSION' && principal.conversation_id !== conversation_id) {
          fail('AUTHENTICATION_FAILED', 'this session credential does not own the requested conversation');
        }
        if (principal.kind === 'WIDGET_SESSION' && principal.session_id !== conversation.external_thread_id) {
          fail('AUTHENTICATION_FAILED', 'this widget session does not own the requested conversation');
        }
        if (conversation.channel !== 'WEB_CHAT') {
          fail('CAPABILITY_NOT_ENABLED', 'only WEB_CHAT Customer Care turns are enabled');
        }

        // A conversation held by another operator is locked: the message is refused rather than
        // queued behind a human who is answering it directly (`07` §6.2).
        if (conversation.state === 'paused_takeover') {
          const lease = await runtime.takeover.holder(principal.tenant_id, conversation_id);
          if (lease === null || lease.operator_id !== principal.operator_id) {
            fail(
              'CONVERSATION_LOCKED',
              'another operator holds the takeover lease for this conversation, so no new agent turn may start',
            );
          }
        }

        // One effect per immutable inbound identity. The key is derived by the canonical guard from
        // the idempotency key, so a replay of the same turn never reserves a second slot.
        const effect_key = runtime.effects.computeEffectKey({
          tenant_id: principal.tenant_id,
          skill_id: CONVERSATION_TURN_SKILL,
          step_index: 0,
          action_revision: 0,
          request_id: idempotency_key,
        });
        const request_fingerprint = runtime.effects.computeRequestFingerprint({
          message,
          module: body?.module ?? null,
          attachments: body?.attachments ?? null,
        });

        const stored = await runtime.receipts.receiptFor(principal.tenant_id, effect_key);
        if (stored !== null) {
          if (stored['request_fingerprint'] !== request_fingerprint) {
            // The same identity carrying different bytes: the only idempotency conflict there is.
            fail(
              'IDEMPOTENCY_CONFLICT',
              'this idempotency key was already claimed for a different payload; the turn is not started again',
            );
          }

          await runtime.audit.record({
            tenant_id: principal.tenant_id,
            correlation_id,
            operation: 'conversations.messages',
            principal_kind: principal.kind,
            ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
            outcome: 'ACCEPTED',
            detail: { replay: true, effect_key, conversation_id },
          });

          return reply.code(202).send(replayAccepted(stored, conversation_id));
        }

        const session_id = principal.session_id ?? conversation.external_thread_id;
        const verified_customer_id = conversation.customer_id;

        const started = await runtime.runs.start({
          tenant_id: principal.tenant_id,
          correlation_id,
          request_id: idempotency_key,
          source_channel: conversation.channel,
          event_type: 'message.received',
          session_id,
          channel_type: conversation.channel,
          channel_identifier: conversation.external_thread_id,
          ...(verified_customer_id === null ? {} : { verified_customer_id }),
          payload: {
            message,
            conversation_id,
            ...(body?.module === undefined ? {} : { module: body.module }),
            ...(body?.attachments === undefined ? {} : { attachments: [...body.attachments] }),
          },
        });
        await runtime.conversations.appendMessage({
          tenant_id: principal.tenant_id,
          conversation_id,
          sender_type: 'customer',
          sender_id: session_id,
          content: message,
        });

        const receipt: Record<string, unknown> = {
          task_id: started.run_id,
          conversation_id,
          status: toWireStatus(started.lifecycle_state),
          task_version: started.task_version,
          correlation_id: started.correlation_id,
          request_fingerprint,
        };

        await runtime.receipts.storeReceipt(principal.tenant_id, effect_key, receipt);

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.messages',
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { run_id: started.run_id, effect_key, conversation_id },
        });

        const accepted: TaskAcceptedResponse = {
          task_id: started.run_id,
          conversation_id,
          status: toWireStatus(started.lifecycle_state),
          task_version: started.task_version,
          correlation_id: started.correlation_id,
        };

        return reply.code(202).send(accepted);
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // R03 — GET /api/v1/tasks/{task_id}
  // -------------------------------------------------------------------------

  app.get<{ Params: { task_id: string } }>('/tasks/:task_id', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requirePrincipal(request);
      const task = await runtime.runs.read({ tenant_id: principal.tenant_id, run_id: request.params.task_id });

      if (task === null) {
        fail('TASK_NOT_FOUND', 'this tenant holds no durable task with that identifier');
      }

      const response: TaskStateResponse = {
        task_id: task.run_id,
        task_version: task.task_version,
        status: toWireStatus(task.lifecycle_state),
        ...(task.answer === undefined ? {} : { answer: task.answer }),
        ...(task.sources === undefined ? {} : { sources: task.sources }),
        ...(task.actions === undefined ? {} : { actions: task.actions }),
        ...(task.evidence_reference === undefined ? {} : { evidence_reference: task.evidence_reference }),
        correlation_id: task.correlation_id,
      };

      // A read writes its audit row and no evidence row (`06` §8.0).
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'tasks.read',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { run_id: task.run_id },
      });

      return reply.code(200).send(response);
    } catch (error) {
      return refuse(reply, request, runtime, error);
    }
  });

  // -------------------------------------------------------------------------
  // R06 — POST /api/v1/conversations/{id}/takeover
  // -------------------------------------------------------------------------

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/takeover',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body as Record<string, unknown> | undefined;
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

        await runtime.conversations.setState(principal.tenant_id, conversation_id, 'paused_takeover', operator_id);

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
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body as Record<string, unknown> | undefined;
        const extend_seconds = body?.['extend_seconds'];
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
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);

      try {
        const principal = requireOperator(request, 'conversation:takeover');
        const operator_id = requireOperatorIdentifier(principal.operator_id);
        const conversation_id = request.params.conversation_id;

        const body = request.body as Record<string, unknown> | undefined;
        const handoff_summary = typeof body?.['handoff_summary'] === 'string' ? body['handoff_summary'] : null;

        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }

        const released = await runtime.takeover.release({
          tenant_id: principal.tenant_id,
          conversation_id,
          operator_id,
        });

        // A release is owner-checked and idempotent: a repeat by the operator who already handed the
        // conversation back is answered from the same terminal state, never as a double release.
        if (released.outcome === 'HELD_BY_ANOTHER_OPERATOR') {
          fail('TAKEOVER_LEASE_HELD', 'another operator holds the takeover lease for this conversation');
        }

        if (released.outcome === 'NOT_HELD' && conversation.state !== 'open') {
          fail(
            'TAKEOVER_LEASE_EXPIRED',
            'this operator holds no live takeover lease, and the conversation is not already back under agent control',
          );
        }

        await runtime.conversations.setState(principal.tenant_id, conversation_id, 'open', null);

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
            ...(typeof body?.['next_agent_id'] === 'string' ? { next_agent_id: body['next_agent_id'] } : {}),
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

/** Renders a stored receipt as the R02 acceptance, so a replay reproduces the original answer. */
function replayAccepted(receipt: Record<string, unknown>, conversation_id: string): TaskAcceptedResponse {
  const task_id = receipt['task_id'];
  const task_version = receipt['task_version'];
  const correlation_id = receipt['correlation_id'];

  if (typeof task_id !== 'string' || typeof task_version !== 'number' || typeof correlation_id !== 'string') {
    fail('INTERNAL_ERROR', 'the receipt stored for this idempotency key is incomplete and cannot be returned');
  }

  return {
    task_id,
    conversation_id,
    status: 'accepted',
    task_version,
    correlation_id,
  };
}

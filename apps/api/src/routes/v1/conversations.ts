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
  type AgentModule,
  type ChannelId,
  type ConversationSessionResponse,
  type CreateConversationRequest,
  type PostMessageRequest,
  type TaskStateResponse,
  type TaskStoredState,
  type TaskWireStatus,
} from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import {
  admitCareTurn,
  InMemoryTurnRateLimiter,
  parseEnabledAgentModules,
  validateAdmissionEventType,
  type TurnRateLimiter,
} from './care-turn.js';
import { registerConversationTakeoverRoutes } from './conversations-takeover.js';
import type { TurnIntentPort } from '../../runtime/bindings/turn-intent.js';
import { classifyTurnModule } from './turn-classifier.js';

/** Runtime counterpart of the frozen `ChannelId` vocabulary; request channels are never guessed. */
const VALID_CHANNELS: readonly ChannelId[] = Object.freeze([
  'WEB_CHAT',
  'APP_CHAT',
  'MESSENGER',
  'INSTAGRAM',
  'TIKTOK',
  'ZALO',
  'EMAIL',
  'SMS',
  'LINE',
  'WHATSAPP',
]);

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

/** Reads `attachments`: an array of strings, or absent. Anything else fails validation. */
function attachmentsOf(body: unknown): readonly string[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const raw: unknown = (body as Record<string, unknown>)['attachments'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    fail('VALIDATION_FAILED', 'attachments must be an array of strings');
  }
  return raw as readonly string[];
}

/** A refusal that carries the code and nothing else: no value from the request is echoed back. */
function refuse(reply: FastifyReply, request: FastifyRequest, runtime: GatewayRuntime, error: unknown): FastifyReply {
  return replyFailure(reply, error, correlationIdOf(request, runtime));
}

/** Injected dependencies of the conversation routes: the gateway runtime, the credential store, and the agent modules the deployment enables. */
export interface ConversationRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly enabledModules?: readonly string[];
  readonly salesSignalEventTypes?: readonly string[];
  readonly marketingSignalEventTypes?: readonly string[];
  readonly intentProposer?: TurnIntentPort;
  readonly turnRateLimiter?: TurnRateLimiter;
}

/**
 * Registers R01, R02, R03, R06, R07 and R08 on the `/api/v1` prefix.
 *
 * @param app The Fastify instance.
 * @param deps The injected runtime, credential store and the enabled agent modules.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  deps: ConversationRouteDeps,
): void {
  const preHandler = authenticate(deps);

  const turnRateLimiter = deps.turnRateLimiter ?? new InMemoryTurnRateLimiter({
    clock: deps.runtime.clock,
  });

  // -------------------------------------------------------------------------
  // R01 — POST /api/v1/conversations
  // -------------------------------------------------------------------------

  app.post('/conversations', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requirePrincipal(request);
      const body = request.body as Partial<CreateConversationRequest> | undefined;
      const rawChannel = body?.channel;
      const customer_identifier = requiredString(body, 'customer_identifier', 128);

      if (typeof rawChannel !== 'string' || !VALID_CHANNELS.includes(rawChannel as ChannelId)) {
        fail('VALIDATION_FAILED', 'channel is required and must name a supported channel');
      }
      const channel = rawChannel as ChannelId;

      if (principal.kind === 'OPERATOR') {
        requireOperator(request, 'conversation:takeover');
      } else if (principal.kind === 'CHANNEL_SESSION') {
        if (
          principal.session_id === undefined ||
          principal.session_id !== customer_identifier ||
          principal.channel !== channel
        ) {
          fail(
            'INSUFFICIENT_AUTHORITY',
            'a session principal may create only its own channel-bound conversation thread',
          );
        }
      } else if (principal.kind === 'WIDGET_SESSION') {
        if (principal.session_id === undefined || principal.session_id !== customer_identifier || channel !== 'WEB_CHAT') {
          fail(
            'INSUFFICIENT_AUTHORITY',
            'a widget principal may create only its own WEB_CHAT conversation thread',
          );
        }
      } else {
        fail('INSUFFICIENT_AUTHORITY', 'this operation requires a customer session or authorized operator');
      }

      if (principal.kind === 'CHANNEL_SESSION') {
        const boundConversation = await runtime.conversations.get(
          principal.tenant_id,
          principal.conversation_id ?? '',
        );
        if (
          boundConversation === null ||
          boundConversation.external_thread_id !== customer_identifier ||
          boundConversation.channel !== channel
        ) {
          fail('INSUFFICIENT_AUTHORITY', 'this session credential is not bound to the requested conversation thread');
        }
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

      if (
        principal.kind === 'CHANNEL_SESSION' &&
        conversation.conversation_id !== principal.conversation_id
      ) {
        fail('INSUFFICIENT_AUTHORITY', 'this session credential is not bound to the requested conversation');
      }

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
        if (principal.kind !== 'CHANNEL_SESSION' && principal.kind !== 'WIDGET_SESSION') {
          fail(
            'INSUFFICIENT_AUTHORITY',
            'customer messages require a channel session or storefront widget principal',
          );
        }
        const body = request.body as Partial<PostMessageRequest> | undefined;
        const conversation_id = request.params.conversation_id;
        const message = requiredString(body, 'message', MESSAGE_MAX_LENGTH);
        const idempotency_key = requiredString(body, 'idempotency_key', IDEMPOTENCY_KEY_MAX_LENGTH);
        const rawModule = body?.module;
        const normalizedModule = classifyTurnModule(message, rawModule as AgentModule | undefined);
        const enabledModules = deps.enabledModules ?? parseEnabledAgentModules(process.env.ENABLED_AGENT_MODULES);
        if (!enabledModules.includes(normalizedModule)) {
          fail('CAPABILITY_NOT_ENABLED', 'the selected agent module is not enabled');
        }

        const rawEventType = (body as Record<string, unknown> | undefined)?.['event_type'];
        const eventTypeOptions = deps.salesSignalEventTypes !== undefined || deps.marketingSignalEventTypes !== undefined
          ? {
              ...(deps.salesSignalEventTypes === undefined ? {} : { salesSignalEventTypes: deps.salesSignalEventTypes }),
              ...(deps.marketingSignalEventTypes === undefined ? {} : { marketingSignalEventTypes: deps.marketingSignalEventTypes }),
            }
          : undefined;
        const event_type = validateAdmissionEventType(rawEventType, normalizedModule, eventTypeOptions);
        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }
        if (principal.kind === 'CHANNEL_SESSION' && principal.conversation_id !== conversation_id) {
          fail('INSUFFICIENT_AUTHORITY', 'this session credential does not own the requested conversation');
        }
        if (principal.kind === 'WIDGET_SESSION' && principal.session_id !== conversation.external_thread_id) {
          fail('INSUFFICIENT_AUTHORITY', 'this widget session does not own the requested conversation');
        }
        if (conversation.channel !== 'WEB_CHAT') {
          fail('CAPABILITY_NOT_ENABLED', 'only WEB_CHAT Customer Care turns are enabled');
        }

        const attachments = attachmentsOf(body);

        const admission = await admitCareTurn({
          runtime,
          principal,
          conversation,
          correlation_id,
          request_id: idempotency_key,
          message,
          module: normalizedModule as AgentModule,
          event_type,
          ...(attachments === undefined ? {} : { attachments }),
          ...(deps.intentProposer === undefined ? {} : { intentProposer: deps.intentProposer }),
          rateLimiter: turnRateLimiter,
          operation: 'conversations.messages',
        });

        return reply.code(202).send(admission.accepted);
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
      // Operator authority is checked before reading task state; an unauthorized operator must not
      // cause a tenant-scoped task lookup. Session principals still need the task row for ownership.
      if (principal.kind === 'OPERATOR') {
        requireOperator(request, 'run:read');
      }
      const task = await runtime.runs.read({ tenant_id: principal.tenant_id, run_id: request.params.task_id });

      if (task === null) {
        fail('TASK_NOT_FOUND', 'this tenant holds no durable task with that identifier');
      }
      if (
        principal.kind !== 'OPERATOR' &&
        ((principal.kind === 'CHANNEL_SESSION' &&
          (task.conversation_id !== principal.conversation_id || task.session_id !== principal.session_id)) ||
        (principal.kind === 'WIDGET_SESSION' && task.session_id !== principal.session_id) ||
        task.session_id === undefined)
      ) {
        fail('TASK_NOT_FOUND', 'this session does not own the requested task');
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

  registerConversationTakeoverRoutes(app, deps, preHandler, { requiredString, refuse });

}

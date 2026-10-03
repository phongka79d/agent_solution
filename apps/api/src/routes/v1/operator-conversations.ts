import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticate, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayPrincipal } from '../../gateway/contracts.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { toConversationListItem, toConversationSummary } from '../../projections/conversation-summary.js';
import {
  conversationListRouteSchema,
  conversationMessagesRouteSchema,
  conversationOperatorMessageRouteSchema,
  conversationSummaryRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MESSAGE_MAX_LENGTH = 4000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;


export interface OperatorConversationRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
}

function refuse(
  reply: FastifyReply,
  request: FastifyRequest,
  runtime: GatewayRuntime,
  error: unknown,
): FastifyReply {
  return replyFailure(reply, error, correlationIdOf(request, runtime));
}

function readLimit(query: unknown): number {
  if (query === undefined || query === null || typeof query !== 'object' || Array.isArray(query)) {
    return DEFAULT_LIMIT;
  }
  const raw: unknown = Reflect.get(query, 'limit');
  if (raw === undefined) return DEFAULT_LIMIT;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail('VALIDATION_FAILED', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function requiredMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('VALIDATION_FAILED', 'message is required');
  }
  // Any other field is ignored rather than refused: an `operator_id` in the body is a spoof attempt
  // that the route already answers by deriving attribution from the principal alone.
  const message: unknown = Reflect.get(body, 'message');
  if (typeof message !== 'string' || message.trim().length === 0 || message.length > MESSAGE_MAX_LENGTH) {
    fail('VALIDATION_FAILED', `message must be a non-empty string of at most ${MESSAGE_MAX_LENGTH} characters`);
  }
  return message;
}

/**
 * The optional replay key of one operator reply. When supplied, a repeated reply with the same key
 * returns the message the first one produced instead of appending a duplicate; the key carries no
 * authority and is never derived from the message text.
 */
function optionalIdempotencyKey(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('VALIDATION_FAILED', 'message is required');
  }
  const value: unknown = Reflect.get(body, 'idempotency_key');
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    fail('VALIDATION_FAILED', `idempotency_key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return value.trim();
}

function requireConversationReader(request: FastifyRequest): GatewayPrincipal {
  const principal = requirePrincipal(request);
  if (principal.kind !== 'OPERATOR') {
    fail('INSUFFICIENT_AUTHORITY', 'this operation requires an authenticated tenant operator');
  }
  if (
    !principal.permissions.includes('conversation:takeover') &&
    !principal.permissions.includes('customer:read')
  ) {
    fail(
      'INSUFFICIENT_AUTHORITY',
      'the authenticated operator needs conversation:takeover or customer:read to read conversations',
    );
  }
  return principal;
}

function requireOperatorId(principal: GatewayPrincipal): string {
  if (principal.kind !== 'OPERATOR' || principal.operator_id === undefined || principal.operator_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
  }
  return principal.operator_id;
}

async function handleConversationSummary(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OperatorConversationRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  try {
    const principal = requirePrincipal(request);
    if (principal.kind !== 'OPERATOR' || !principal.permissions.includes('conversation:takeover')) {
      fail('INSUFFICIENT_AUTHORITY', 'this operation requires conversation:takeover');
    }
    if (runtime.companyCrm === undefined) {
      fail('CAPABILITY_NOT_ENABLED', 'the company CRM projection is not configured');
    }
    const conversation_id = typeof request.params === 'object' && request.params !== null && 'id' in request.params
      ? request.params.id
      : undefined;
    if (typeof conversation_id !== 'string' || conversation_id.length === 0) {
      fail('VALIDATION_FAILED', 'conversation id is required in the path');
    }
    const summary = await runtime.companyCrm.getConversationSummary(principal.tenant_id, conversation_id);
    if (summary === null) fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
    const lease = await runtime.takeover.holder(principal.tenant_id, conversation_id);
    await runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id: correlationIdOf(request, runtime),
      operation: 'GET /api/v1/conversations/{id}/summary',
      principal_kind: principal.kind,
      outcome: 'ACCEPTED',
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      detail: { conversation_id },
    });
    return reply.code(200).send(toConversationSummary(summary, {
      lease,
      requesting_operator_id: requireOperatorId(principal),
      now: runtime.clock(),
    }));
  } catch (error) {
    return replyFailure(reply, error, correlationIdOf(request, runtime));
  }
}

/** Registers tenant-scoped operator conversation reads and the lease-owned human reply endpoint. */
export function registerOperatorConversationRoutes(
  app: FastifyInstance,
  deps: OperatorConversationRouteDeps,
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);
  app.get<{ Params: { id: string } }>(
    '/conversations/:id/summary',
    { preHandler, schema: conversationSummaryRouteSchema },
    (request, reply) => handleConversationSummary(request, reply, deps),
  );

  app.get('/conversations', { preHandler, schema: conversationListRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);
    try {
      const principal = requireConversationReader(request);
      const limit = readLimit(request.query);
      const operator_id = requireOperatorId(principal);
      const conversations = await runtime.conversations.list(principal.tenant_id, limit);
      const items = await Promise.all(conversations.map(async (conversation) => {
        const [lease, handoffs] = await Promise.all([
          runtime.takeover.holder(principal.tenant_id, conversation.conversation_id),
          runtime.conversations.handoffState(principal.tenant_id, conversation.conversation_id),
        ]);
        return toConversationListItem(conversation, {
          lease,
          requesting_operator_id: operator_id,
          now: runtime.clock(),
          ...handoffs,
        }, conversation.customer_display_name ?? null);
      }));
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'conversations.list',
        principal_kind: principal.kind,
        operator_id: requireOperatorId(principal),
        outcome: 'ACCEPTED',
        detail: { limit, result_count: items.length },
      });
      return reply.code(200).send({ items, next_cursor: null });
    } catch (error) {
      return refuse(reply, request, runtime, error);
    }
  });

  app.get<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/messages',
    { preHandler, schema: conversationMessagesRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const principal = requireConversationReader(request);
        const conversation_id = request.params.conversation_id;
        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }
        const limit = readLimit(request.query);
        const items = await runtime.conversations.listMessages({
          tenant_id: principal.tenant_id,
          conversation_id,
          limit,
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.messages.read',
          principal_kind: principal.kind,
          operator_id: requireOperatorId(principal),
          outcome: 'ACCEPTED',
          detail: { conversation_id, limit, result_count: items.length },
        });
        return reply.code(200).send({ conversation_id, items, next_cursor: null });
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );

  app.post<{ Params: { conversation_id: string } }>(
    '/conversations/:conversation_id/operator-messages',
    { preHandler, schema: conversationOperatorMessageRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const principal = requirePrincipal(request);
        if (principal.kind !== 'OPERATOR' || !principal.permissions.includes('conversation:takeover')) {
          fail('INSUFFICIENT_AUTHORITY', 'this operation requires conversation:takeover');
        }
        const operator_id = requireOperatorId(principal);
        const conversation_id = request.params.conversation_id;
        const message = requiredMessage(request.body);
        const idempotency_key = optionalIdempotencyKey(request.body);
        const conversation = await runtime.conversations.get(principal.tenant_id, conversation_id);
        if (conversation === null) {
          fail('CONVERSATION_NOT_FOUND', 'this tenant holds no conversation with that identifier');
        }
        if (conversation.state !== 'paused_takeover' || conversation.takeover_operator_id !== operator_id) {
          fail('CONVERSATION_LOCKED', 'this conversation is not paused under the authenticated operator');
        }

        const lease = await runtime.takeover.holder(principal.tenant_id, conversation_id);
        if (lease === null) {
          fail('TAKEOVER_LEASE_EXPIRED', 'the authenticated operator holds no live takeover lease');
        }
        if (lease.operator_id !== operator_id) {
          fail('TAKEOVER_LEASE_HELD', 'another operator holds the takeover lease for this conversation');
        }
        const expires_at = Date.parse(lease.expires_at);
        if (!Number.isFinite(expires_at) || expires_at <= runtime.clock().getTime()) {
          fail('TAKEOVER_LEASE_EXPIRED', 'the authenticated operator holds no live takeover lease');
        }

        // The sender identity is derived exclusively from the authenticated principal. Any
        // operator_id in the body is intentionally ignored and can never spoof attribution.
        let message_id: string;
        try {
          message_id = await runtime.conversations.appendMessage({
            tenant_id: principal.tenant_id,
            conversation_id,
            sender_type: 'operator',
            sender_id: operator_id,
            content: message,
            ...(idempotency_key === undefined ? {} : { request_id: `operator-reply:${idempotency_key}` }),
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('IDEMPOTENCY_CONFLICT')) {
            fail(
              'IDEMPOTENCY_CONFLICT',
              'this idempotency_key already produced a different operator message on this conversation',
            );
          }
          throw error;
        }

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'conversations.operator_message',
          principal_kind: principal.kind,
          operator_id,
          outcome: 'ACCEPTED',
          detail: { conversation_id, message_id, status: 'persisted' },
        });

        return reply.code(201).send({
          conversation_id,
          message_id,
          status: 'persisted',
        });
      } catch (error) {
        return refuse(reply, request, runtime, error);
      }
    },
  );
}

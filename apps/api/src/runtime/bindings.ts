/**
 * @file Durable bindings for the gateway and engine ports (implement/04 §3.2.3, `06` §8).
 *
 * Each port the routes declare is bound here to a repository that already owns the table, so no
 * layer re-implements policy, idempotency or schema that a foundation package owns. Two rules hold
 * throughout:
 *
 * - **Tenant first.** Every binding passes `tenant_id` from the authenticated principal into a
 *   tenant-scoped repository call, and the repository's RLS context is what isolates the row. No
 *   binding filters rows in memory after a cross-tenant read.
 * - **No synthetic values.** A binding maps stored values onto the wire shape; it never invents a
 *   missing one. Where a source is absent, the port answers with the contract's own empty or
 *   not-instrumented vocabulary rather than a plausible default (`06` §8.1.3).
 */

import { createHmac, randomUUID } from 'node:crypto';

import { computeEffectKey, computeRequestFingerprint } from '@agentos/core-engine';
import type { IEffectGuard, ReservationOutcome } from '@agentos/core-engine/contracts';
import {
  type AppendCustomerEventInput,
  type ConversationRepository,
  type CustomerEventRepository,
  type EffectReservationRepository,
  type TenantTransactionRunner,
} from '@agentos/database';

import type { ChannelId, EvidenceClassification, TimelineEntry } from '../gateway/contracts.js';
import type {
  ConversationPort,
  ConversationRecord,
  EventPort,
  ReceiptPort,
} from '../gateway/ports.js';

/** Encodes the canonical effect key and request fingerprint of one reservable effect. */
export function createEffectGuard(repository: EffectReservationRepository): IEffectGuard {
  return {
    computeEffectKey,
    computeRequestFingerprint,

    reserve: async (input): Promise<ReservationOutcome> => {
      const outcome = await repository.reserve({
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        request_id: input.request_id,
        effect_key: input.effect_key,
        request_fingerprint: input.request_fingerprint,
        skill_id: input.skill_id,
        step_index: input.step_index,
        action_revision: input.action_revision,
      });

      // The repository owns the reservation protocol; this binding only widens its outcome onto the
      // canonical union so the engine and the gateway see one vocabulary.
      return outcome;
    },

    resolve: async (input): Promise<void> => {
      await repository.resolve({
        tenant_id: input.tenant_id,
        effect_key: input.effect_key,
        status: input.status,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      });
    },

    reconcile: async (input) => {
      const stored = await repository.getReservation(input.tenant_id, input.effect_key);

      if (stored === null) {
        return { outcome: 'INDETERMINATE' };
      }

      if (stored.status === 'SUCCEEDED') {
        return stored.response_receipt === null || stored.response_receipt === undefined
          ? { outcome: 'SUCCEEDED' }
          : { outcome: 'SUCCEEDED', receipt: stored.response_receipt };
      }

      if (stored.status === 'FAILED') {
        return { outcome: 'FAILED' };
      }

      // A row still `RESERVED` is precisely the indeterminate case: the effect may or may not have
      // landed, so no receipt exists and no re-dispatch is authorized.
      return { outcome: 'INDETERMINATE' };
    },
  };
}

/**
 * Binds the conversation table to the gateway's conversation port.
 *
 * @param repository The durable conversation repository.
 * @param options.session_secret The tenant-session signing secret. A session token is an HMAC over
 *   the conversation binding, so it can be verified on a later request without a second store; a
 *   missing secret throws at composition rather than issuing an unsigned token.
 */
export function createConversationPort(
  repository: ConversationRepository,
  options: { readonly session_secret: string },
): ConversationPort {
  if (options.session_secret.length < 16) {
    throw new Error(
      'SESSION_SECRET: a session token is a signed binding and cannot be issued without a signing secret',
    );
  }

  return {
    bindOrCreate: async (input) => {
      const row = await repository.bindOrCreate({
        tenant_id: input.tenant_id,
        channel: input.channel,
        external_thread_id: input.external_thread_id,
        customer_id: input.customer_id,
        ...(input.active_agent === undefined ? {} : { active_agent: input.active_agent }),
      });

      return {
        conversation_id: row.conversation_id,
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        channel: row.channel as ChannelId,
        external_thread_id: row.external_thread_id,
        active_agent: row.active_agent,
        state: row.state,
        takeover_operator_id: row.takeover_operator_id,
        last_message_at: row.last_message_at,
        created_at: row.created_at,
        bound: row.bound,
      };
    },

    get: async (tenant_id, conversation_id): Promise<ConversationRecord | null> => {
      const row = await repository.get(tenant_id, conversation_id);
      if (row === null) return null;

      return {
        conversation_id: row.conversation_id,
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        channel: row.channel as ChannelId,
        external_thread_id: row.external_thread_id,
        active_agent: row.active_agent,
        state: row.state,
        takeover_operator_id: row.takeover_operator_id,
        last_message_at: row.last_message_at,
        created_at: row.created_at,
        bound: true,
      };
    },

    setState: async (tenant_id, conversation_id, state, takeover_operator_id) => {
      await repository.setState(tenant_id, conversation_id, state, takeover_operator_id);
    },

    appendMessage: async (input) => {
      await repository.appendMessage({
        tenant_id: input.tenant_id,
        conversation_id: input.conversation_id,
        sender_type: input.sender_type,
        sender_id: input.sender_id,
        content: input.content,
        ...(input.content_type === undefined ? {} : { content_type: input.content_type }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
    },

    issueSessionToken: async (input) => {
      // The token is the binding itself, signed. It carries no authority of its own: the gateway
      // still resolves the principal and re-checks the conversation on every request, and the
      // signature is what makes the binding unforgeable rather than merely opaque.
      const binding = `${input.tenant_id}.${input.conversation_id}.${input.channel}`;
      const signature = createHmac('sha256', options.session_secret)
        .update(binding, 'utf8')
        .digest('base64url');
      return `${Buffer.from(binding, 'utf8').toString('base64url')}.${signature}`;
    },
  };
}

/** Maps a stored event row onto the ten-stage timeline projection (`03` §8). */
function toTimelineEntry(item: {
  readonly event_id: string;
  readonly source_event_id: string;
  readonly event_name: string;
  readonly session_id: string;
  readonly channel: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}): TimelineEntry {
  const classification = item.payload['classification'];
  const verdict = item.payload['evidence_classification'];

  return {
    occurred_at: item.occurred_at,
    source_record_id: item.source_event_id,
    event_id: item.event_id,
    stage: item.event_name,
    canonical_event: item.event_name.startsWith('ext.') ? null : item.event_name,
    // The classification is carried by the producer; a row that predates the vocabulary is a
    // SIGNAL, its weakest truthful reading, never a FACT.
    classification:
      classification === 'FACT' || classification === 'HYPOTHESIS' || classification === 'DECISION' || classification === 'ACTION'
        ? classification
        : verdict === 'FACT' || verdict === 'HYPOTHESIS' || verdict === 'DECISION' || verdict === 'ACTION'
          ? verdict
          : ('SIGNAL' satisfies EvidenceClassification),
    evidence_reference:
      typeof item.payload['evidence_reference'] === 'string' ? item.payload['evidence_reference'] : null,
  };
}

/**
 * Binds the customer-event table to the gateway's event port.
 *
 * The port owns the durable append and the timeline read only: the canonical derivation belongs to
 * the connector layer and the `(tenant, source_event_id)` uniqueness constraint owns deduplication,
 * so a redelivery normalises here exactly as it did the first time and is then dropped by the store.
 */
export function createEventPort(repository: CustomerEventRepository): EventPort {
  return {
    append: async (input: AppendCustomerEventInput) => repository.append(input),

    receipt: async (tenant_id, source_event_id) => repository.findByIdempotencyKey(tenant_id, source_event_id),

    timeline: async (input) => {
      const page = await repository.listTimeline({
        tenant_id: input.tenant_id,
        customer_id: input.customer_id,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });

      return {
        items: page.items.map(toTimelineEntry),
        next_cursor: page.next_cursor,
      };
    },
  };
}

/**
 * The receipt the caller of a storefront turn or an event delivery re-reads (R11, R12, R04).
 *
 * The receipt lives beside the canonical effect reservation, never in a second store, so a replay
 * and an idempotency conflict are decided by the same row that decided the first dispatch.
 */
export function createReceiptPort(guard: IEffectGuard): ReceiptPort {
  return {
    receiptFor: async (tenant_id, effect_key) => {
      const outcome = await guard.reconcile({ tenant_id, effect_key, skill_id: 'gateway.receipt' });
      if (outcome.outcome !== 'SUCCEEDED') return null;

      const receipt = outcome.receipt;
      if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return null;

      return { ...receipt };
    },

    storeReceipt: async (tenant_id, effect_key, receipt) => {
      await guard.resolve({ tenant_id, effect_key, status: 'SUCCEEDED', receipt });
    },
  };
}

/** Identifier source for the composition root: every gateway-issued id is a real UUID. */
export const systemIdentifiers: () => string = () => randomUUID();

/** Clock source for the composition root: the only place a wall-clock instant is read. */
export const systemClock: () => Date = () => new Date();

/**
 * Transaction runner used by the gateway-side projections that need a tenant-scoped read beyond the
 * repositories. Exposed so a projection binds the same RLS context the repositories use.
 */
export interface ProjectionTransactionRunner {
  readonly run: TenantTransactionRunner;
}

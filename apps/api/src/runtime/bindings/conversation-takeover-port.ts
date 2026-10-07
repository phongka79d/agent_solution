import { createHmac } from 'node:crypto';

import {
  computeEffectKey,
  computeRequestFingerprint,
  EFFECT_RESERVATION_TTL_MS,
} from '@agentos/core-engine';
import type { IEffectGuard, ReservationOutcome } from '@agentos/core-engine/contracts';
import {
  acquireSessionTakeover,
  readSessionTakeover,
  releaseSessionTakeover,
  renewSessionTakeover,
  type CareHandoffRepository,
  type ConversationRepository,
  type EffectReservationRepository,
  type RedisInjectedClient,
} from '@agentos/database';

import type { ChannelId } from '../../gateway/contracts.js';
import type {
  CareHandoffPort,
  ConversationPort,
  ConversationRecord,
  TakeoverLeasePort,
} from '../../gateway/ports.js';
import { systemClock } from './run-port.js';

const CONVERSATION_SESSION_TTL_SECONDS = 60 * 60;

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
    reopenForRetry: async (input) => repository.reopenReservation({
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      expires_at: new Date(Date.now() + EFFECT_RESERVATION_TTL_MS).toISOString(),
    }),
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

    list: async (tenant_id, limit) => {
      const rows = await repository.list(tenant_id, limit);
      return rows.map((row) => ({
        ...row, channel: row.channel as ChannelId, bound: true,
      }));
    },

    listMessages: (input) => repository.listMessages(input),

    setState: async (tenant_id, conversation_id, state, takeover_operator_id) => {
      await repository.setState(tenant_id, conversation_id, state, takeover_operator_id);
    },
    clearTakeoverIfOwned: (tenant_id, conversation_id, operator_id) =>
      repository.clearTakeoverIfOwned(tenant_id, conversation_id, operator_id),

    appendMessage: (input) => repository.appendMessage({
      tenant_id: input.tenant_id,
      conversation_id: input.conversation_id,
      sender_type: input.sender_type,
      sender_id: input.sender_id,
      content: input.content,
      ...(input.content_type === undefined ? {} : { content_type: input.content_type }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
    }),

    issueSessionToken: async (input) => {
      const row = await repository.get(input.tenant_id, input.conversation_id);
      if (row === null) {
        throw new Error('CONVERSATION_NOT_FOUND: cannot issue a token for an unknown conversation');
      }
      const binding = JSON.stringify({
        tenant_id: input.tenant_id,
        conversation_id: input.conversation_id,
        session_id: row.external_thread_id,
        exp: Math.floor(Date.now() / 1000) + CONVERSATION_SESSION_TTL_SECONDS,
        channel: input.channel,
      });
      const encodedBinding = Buffer.from(binding, 'utf8').toString('base64url');
      const signature = createHmac('sha256', options.session_secret)
        .update(binding, 'utf8')
        .digest('base64url');
      return `${encodedBinding}.${signature}`;
    },
  };
}

/** Binds SCR-005 to the canonical tenant/conversation-scoped Redis lease helpers. */
export function createTakeoverLeasePort(
  redis: RedisInjectedClient,
  now: () => Date = systemClock,
): TakeoverLeasePort {
  return {
    acquire: async (input) => acquireSessionTakeover(redis, input, now),
    renew: async (input) => renewSessionTakeover(redis, input, now),
    release: async (input) => releaseSessionTakeover(redis, input),
    holder: async (tenant_id, conversation_id) =>
      readSessionTakeover(redis, tenant_id, conversation_id, now),
  };
}

/** Binds durable handoff ownership transitions to the PostgreSQL repository transaction. */
export function createCareHandoffPort(
  repository: Pick<CareHandoffRepository, 'claim' | 'complete'>,
): CareHandoffPort {
  return {
    claim: (input) => repository.claim(input),
    complete: (input) => repository.complete(input),
  };
}

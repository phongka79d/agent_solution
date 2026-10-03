import type { CompanyCrmConversationSummaryRow } from '@agentos/database';

import type { ConversationRecord } from '../gateway/ports.js';
import { normalizeClassification } from './customers.js';
import { maskEmail, maskPhone } from './masking.js';

export type ConversationOwnership =
  | 'AI_ACTIVE'
  | 'NEEDS_HUMAN'
  | 'HUMAN_ME'
  | 'HUMAN_OTHER'
  | 'PAUSED_ORPHAN'
  | 'CLOSED';

export interface ConversationOwnerProjection {
  readonly operator_id: string;
  readonly display_name: string | null;
  readonly lease_expires_at: string;
}

export interface ConversationOwnershipInput {
  readonly state: string;
  readonly has_enqueued_handoff: boolean;
  readonly has_assigned_handoff: boolean;
  readonly lease: { readonly operator_id: string; readonly expires_at: string } | null;
  readonly requesting_operator_id: string;
  readonly now: Date;
}

export interface ConversationOwnershipProjection {
  readonly ownership: ConversationOwnership;
  readonly owner: ConversationOwnerProjection | null;
}

/** Derives the thread owner from stored state, handoff status and a currently live lease. */
export function deriveConversationOwnership(
  input: ConversationOwnershipInput,
): ConversationOwnershipProjection {
  const expiry = input.lease === null ? Number.NaN : Date.parse(input.lease.expires_at);
  const liveLease = input.lease !== null && Number.isFinite(expiry) && expiry > input.now.getTime()
    ? input.lease
    : null;
  let ownership: ConversationOwnership;
  if (input.state === 'closed') ownership = 'CLOSED';
  else if (liveLease !== null) {
    ownership = liveLease.operator_id === input.requesting_operator_id ? 'HUMAN_ME' : 'HUMAN_OTHER';
  } else if (
    (input.state !== 'closed' && input.has_enqueued_handoff) ||
    (input.state === 'paused_takeover' && input.has_assigned_handoff)
  ) {
    ownership = 'NEEDS_HUMAN';
  } else if (input.state === 'paused_takeover') ownership = 'PAUSED_ORPHAN';
  else ownership = 'AI_ACTIVE';

  return {
    ownership,
    owner: liveLease !== null && (ownership === 'HUMAN_ME' || ownership === 'HUMAN_OTHER')
      ? {
          operator_id: liveLease.operator_id,
          display_name: null,
          lease_expires_at: liveLease.expires_at,
        }
      : null,
  };
}

export interface ConversationSummaryProjection extends ConversationOwnershipProjection {
  readonly conversation_id: string;
  readonly customer: {
    readonly customer_id: string | null;
    readonly display_name: string | null;
    readonly tier: string | null;
    readonly classification: string;
    readonly email: string | null;
    readonly phone: string | null;
  } | null;
  readonly escalation: {
    readonly state: string;
    readonly takeover_operator_id: string | null;
  };
  readonly channel: string;
  readonly last_message_at: string;
}

export interface ConversationListItemProjection extends ConversationOwnershipProjection {
  readonly conversation_id: string;
  readonly customer: { readonly customer_id: string | null; readonly display_name: string | null };
  readonly channel: string;
  readonly state: string;
  readonly last_message_at: string;
}

/** Maps the authoritative conversation row with masked customer contact values. */
export function toConversationSummary(
  row: CompanyCrmConversationSummaryRow,
  input: Omit<ConversationOwnershipInput, 'state' | 'has_enqueued_handoff' | 'has_assigned_handoff'>,
): ConversationSummaryProjection {
  const ownership = deriveConversationOwnership({
    ...input,
    state: row.state,
    has_enqueued_handoff: row.has_enqueued_handoff ?? false,
    has_assigned_handoff: row.has_assigned_handoff ?? false,
  });
  return {
    conversation_id: row.conversation_id,
    customer: row.customer_id === null
      ? null
      : {
          customer_id: row.customer_id,
          display_name: row.customer_display_name,
          tier: row.customer_tier,
          classification: normalizeClassification(row.customer_classification),
          email: maskEmail(row.verified_email),
          phone: maskPhone(row.verified_phone),
        },
    ...ownership,
    escalation: {
      state: row.state,
      takeover_operator_id: row.takeover_operator_id,
    },
    channel: row.channel,
    last_message_at: row.last_message_at instanceof Date
      ? row.last_message_at.toISOString()
      : new Date(row.last_message_at).toISOString(),
  };
}

/** Maps one inbox row with its caller-relative ownership and masked-safe customer display name. */
export function toConversationListItem(
  row: ConversationRecord,
  input: Omit<ConversationOwnershipInput, 'state'>,
  customer_display_name: string | null,
): ConversationListItemProjection {
  return {
    conversation_id: row.conversation_id,
    customer: { customer_id: row.customer_id, display_name: customer_display_name },
    channel: row.channel,
    state: row.state,
    last_message_at: new Date(row.last_message_at).toISOString(),
    ...deriveConversationOwnership({ ...input, state: row.state }),
  };

}


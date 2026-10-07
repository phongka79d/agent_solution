import type { CompanyCrmConversationSummaryRow } from '@agentos/database';

import { normalizeClassification } from './customers.js';
import { maskEmail, maskPhone } from './masking.js';

export interface ConversationOwnerProjection {
  readonly kind: 'AI' | 'HUMAN';
  readonly agent?: string;
  readonly operator_id?: string;
  readonly expires_at?: string;
}

export interface ConversationSummaryProjection {
  readonly conversation_id: string;
  readonly customer: {
    readonly customer_id: string | null;
    readonly display_name: string | null;
    readonly tier: string | null;
    readonly classification: string;
    readonly email: string | null;
    readonly phone: string | null;
  } | null;
  readonly owner: ConversationOwnerProjection;
  readonly escalation: {
    readonly state: string;
    readonly takeover_operator_id: string | null;
  };
  readonly channel: string;
  readonly last_message_at: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Maps the authoritative conversation row with masked customer contact values. */
export function toConversationSummary(
  row: CompanyCrmConversationSummaryRow,
  lease?: { readonly operator_id: string; readonly expires_at: string } | null,
): ConversationSummaryProjection {
  const humanOperator = lease?.operator_id ?? row.takeover_operator_id;
  const owner: ConversationOwnerProjection = humanOperator === null || humanOperator === undefined
    ? { kind: 'AI', agent: row.active_agent }
    : {
        kind: 'HUMAN',
        operator_id: humanOperator,
        ...(lease === null || lease === undefined ? {} : { expires_at: lease.expires_at }),
      };
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
    owner,
    escalation: {
      state: row.state,
      takeover_operator_id: row.takeover_operator_id,
    },
    channel: row.channel,
    last_message_at: iso(row.last_message_at),
  };
}

export const mapConversationSummary = toConversationSummary;

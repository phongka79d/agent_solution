import {
  findIdentity,
  getProfile,
  type ApprovalRepository,
} from '@agentos/database';

import type {
  ApprovalDetailResponse,
  ApprovalQueueItem,
} from '../../gateway/contracts.js';
import type { ApprovalPort, IdentityPort } from '../../gateway/ports.js';

/** Approval read surface. Decisions stay with the unavailable orchestrator resume graph. */
type ApprovalReadRepository = Pick<ApprovalRepository, 'getDetail' | 'listPending'>;
type ApprovalDecisionRepository = Pick<ApprovalRepository, 'queueDecision'>;

/** A JSON object as stored by PostgreSQL JSONB. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Structural approval row used by the gateway mapper without importing repository internals. */
interface ApprovalDetailRecordLike {
  readonly approval: {
    readonly id: string;
    readonly tenant_id: string;
    readonly run_id: string;
    readonly action_id: string;
    readonly effect_key: string;
    readonly payload: unknown;
    readonly payload_sha256: string;
    readonly reason: string;
    readonly operator_id: string | null;
    readonly decision: string;
    readonly is_paused: boolean;
    readonly review_comment: string | null;
    readonly decided_at: string | null;
    readonly expires_at: string;
    readonly created_at: string;
  };
}

/** Maps the single canonical approval row onto the queue contract. */
function toApprovalQueueItem(detail: ApprovalDetailRecordLike): ApprovalQueueItem {
  const { approval } = detail;
  if (approval.decision !== 'PENDING' && approval.decision !== 'EXPIRED') {
    throw new Error(
      'APPROVAL_DETAIL_STATUS_UNREPRESENTABLE: this gateway contract publishes the pending or expired approval detail',
    );
  }
  if (!plainRecord(approval.payload)) {
    throw new Error('APPROVAL_PAYLOAD_INVALID: the reviewed approval payload is not a JSON object');
  }

  return {
    approval_id: approval.id,
    run_id: approval.run_id,
    action_id: approval.action_id,
    effect_key: approval.effect_key,
    payload: approval.payload,
    reason: approval.reason,
    status: approval.decision === 'EXPIRED' ? 'EXPIRED' : 'PENDING',
    is_paused: approval.is_paused,
    decided_by: approval.operator_id,
    decided_at: approval.decided_at,
    decision_notes: approval.review_comment,
    created_at: approval.created_at,
    payload_sha256: approval.payload_sha256,
  };
}

/** Binds the approval queue and detail reads to their canonical PostgreSQL rows. */
export function createApprovalReadPort(
  repository: ApprovalReadRepository,
): Pick<ApprovalPort, 'list' | 'detail'> {
  return {
    list: async (input) => {
      const page = await repository.listPending({
        tenant_id: input.tenant_id,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map(toApprovalQueueItem),
        next_cursor: page.next_cursor,
      };
    },

    detail: async (tenant_id, approval_id): Promise<ApprovalDetailResponse | null> => {
      const detail = await repository.getDetail(tenant_id, approval_id);
      return detail === null
        ? null
        : {
            ...toApprovalQueueItem(detail),
            tenant_id: detail.approval.tenant_id,
            expires_at: detail.approval.expires_at,
          };
    },
  };
}

/** Queues an authenticated decision; the worker owns policy and lease-fenced consumption. */
export function createApprovalDecisionPort(
  repository: ApprovalDecisionRepository,
): Pick<ApprovalPort, 'decide'> {
  return {
    decide: (input) => repository.queueDecision(input),
  };
}

/** Function seam for the tenant-scoped verified channel-identity read. */
export type CustomerIdentityLookup = typeof findIdentity;

/** Tenant-scoped existence read used only for authenticated operator customer claims. */
export type CustomerOperatorCustomerLookup = typeof getProfile;

/**
 * Binds channel identity only from a verified exact tenant/channel row. An operator's claimed
 * customer id takes a separate, tenant-scoped existence path and is never reported as a channel
 * identity; all other callers remain unresolved when no channel identifier is present.
 */
export function createIdentityPort(
  lookup: CustomerIdentityLookup = findIdentity,
  operatorLookup: CustomerOperatorCustomerLookup = getProfile,
): IdentityPort {
  return {
    resolveCustomer: async (input) => {
      if (input.channel_type === 'OPERATOR') {
        if (input.claimed_customer_id === undefined || input.claimed_customer_id.length === 0) {
          return { customer_id: null, verdict: 'UNRESOLVED' };
        }
        const profile = await operatorLookup(input.tenant_id, input.claimed_customer_id);
        return profile === null
          ? { customer_id: null, verdict: 'UNRESOLVED' }
          : { customer_id: profile.customer_id, verdict: 'OPERATOR_VERIFIED' };
      }

      if (input.channel_identifier === undefined || input.channel_identifier.length === 0) {
        return { customer_id: null, verdict: 'UNRESOLVED' };
      }

      const identity = await lookup(
        input.tenant_id,
        input.channel_type,
        input.channel_identifier,
      );
      return identity === null || identity.verified_at === null
        ? { customer_id: null, verdict: 'UNRESOLVED' }
        : { customer_id: identity.customer_id, verdict: 'CHANNEL_IDENTIFIER_EXACT' };
    },
  };
}

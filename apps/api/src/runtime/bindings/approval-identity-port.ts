import { findIdentity, getProfile } from '@agentos/database';
import type { ApprovalRepository } from '@agentos/database';

import type {
  ApprovalDetailResponse,
  ApprovalQueueItem,
  ApprovalQueueStatus,
  ApprovalSummary,
} from '../../gateway/contracts.js';
import type { ApprovalPort, IdentityPort } from '../../gateway/ports.js';

/** Approval read surface. Decisions stay with the unavailable orchestrator resume graph. */
type ApprovalReadRepository = Pick<ApprovalRepository, 'getDetail' | 'listPending' | 'listDecided'>;
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
    readonly campaign_id: string | null;
    readonly campaign_name?: string | null;
    readonly effect_key: string;
    readonly authority_required: string;
    readonly payload: unknown;
    readonly payload_sha256: string;
    readonly original_payload?: unknown;
    readonly reason: string;
    readonly operator_id: string | null;
    readonly decision: string;
    readonly is_paused: boolean;
    readonly review_comment: string | null;
    readonly decided_at: string | null;
    readonly expires_at: string;
    readonly created_at: string;
  };
  readonly action: {
    readonly skill_name: string;
    readonly target_channel: string;
    readonly action_payload: unknown;
  } | null;
}

/** Business-domain rules mirrored from the attention projection (`T6.8`). */
const DOMAIN_RULES: readonly (readonly [RegExp, ApprovalSummary['domain']])[] = [
  [/market|mkt|campaign|promo/, 'marketing'],
  [/sales|price|order|quote/, 'sales'],
  [/care|support|ticket/, 'care'],
];

function domainOf(skillName: string): ApprovalSummary['domain'] {
  const text = skillName.toLowerCase();
  for (const [pattern, domain] of DOMAIN_RULES) {
    if (pattern.test(text)) return domain;
  }
  return 'platform';
}

/** First scalar among `keys`, or `undefined`; used to lift display params out of opaque payloads. */
function paramValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | number | boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

/** Publishes the stored decision as a reader-facing queue status. */
function queueStatusOf(decision: string): ApprovalQueueStatus {
  switch (decision) {
    case 'PENDING':
      return 'PENDING';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PAUSE':
      return 'PAUSED';
    case 'APPROVED':
      return 'APPROVED';
    case 'MODIFIED':
      return 'MODIFIED';
    case 'REJECTED':
      return 'REJECTED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

/** `T6.8`: the sentence, context, risk and evidence a reviewer needs before deciding. */
function buildSummary(detail: ApprovalDetailRecordLike): ApprovalSummary {
  const { approval, action } = detail;
  const payload: Record<string, unknown> = plainRecord(approval.payload) ? approval.payload : {};
  const actionPayload: Record<string, unknown> =
    action !== null && plainRecord(action.action_payload) ? action.action_payload : {};
  const skillName = action?.skill_name ?? '';

  const params: Record<string, string | number | boolean> = {};
  const campaignName =
    paramValue(actionPayload, ['campaign_name', 'campaignName']) ??
    paramValue(payload, ['campaign_name', 'campaignName']) ??
    (typeof approval.campaign_name === 'string' && approval.campaign_name.trim().length > 0
      ? approval.campaign_name
      : undefined);
  const audienceSize =
    paramValue(actionPayload, ['audience_size', 'audienceSize']) ??
    paramValue(payload, ['audience_size', 'audienceSize']);
  const channel = action?.target_channel ?? paramValue(actionPayload, ['channel']);
  const customerId =
    paramValue(payload, ['customer_id', 'customerId']) ??
    paramValue(actionPayload, ['customer_id', 'customerId']);
  const orderId = paramValue(payload, ['order_id', 'orderId']);

  if (campaignName !== undefined) params['campaign_name'] = campaignName;
  if (audienceSize !== undefined) params['audience_size'] = audienceSize;
  if (channel !== undefined && channel !== '') params['channel'] = channel;
  if (customerId !== undefined) params['customer_id'] = customerId;
  if (orderId !== undefined) params['order_id'] = orderId;

  const modification: ApprovalSummary['modification'] =
    approval.decision === 'MODIFIED'
      ? {
          ...(approval.original_payload == null ? {} : { before: approval.original_payload }),
          after: approval.payload,
        }
      : null;

  const titleKey =
    approval.decision === 'MODIFIED'
      ? 'approvals.title.modify'
      : campaignName !== undefined
        ? 'approvals.title.campaign'
        : customerId !== undefined
          ? 'approvals.title.customer'
          : 'approvals.title.action';

  return {
    title_key: titleKey,
    params,
    requesting_agent_key: skillName !== '' ? skillName : 'agentos.unknown_agent',
    domain: domainOf(skillName),
    campaign_id: approval.campaign_id,
    customer_id: typeof customerId === 'string' ? customerId : null,
    risk: approval.authority_required === 'AUTH-4' ? 'high' : 'medium',
    evidence_count: Array.isArray(payload['evidence']) ? payload['evidence'].length : 0,
    modification,
    expires_at: approval.expires_at,
  };
}

/** Maps the single canonical approval row onto the queue contract. */
function toApprovalQueueItem(detail: ApprovalDetailRecordLike): ApprovalQueueItem {
  const { approval } = detail;
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
    status: queueStatusOf(approval.decision),
    is_paused: approval.is_paused,
    decided_by: approval.operator_id,
    decided_at: approval.decided_at,
    decision_notes: approval.review_comment,
    created_at: approval.created_at,
    payload_sha256: approval.payload_sha256,
    summary: buildSummary(detail),
  };
}

/** Binds the approval queue and detail reads to their canonical PostgreSQL rows. */
export function createApprovalReadPort(
  repository: ApprovalReadRepository,
): Pick<ApprovalPort, 'list' | 'detail'> {
  return {
    list: async (input) => {
      const pageInput = {
        tenant_id: input.tenant_id,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      };
      const page =
        input.status === 'DECIDED'
          ? await repository.listDecided(pageInput)
          : await repository.listPending(pageInput);
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

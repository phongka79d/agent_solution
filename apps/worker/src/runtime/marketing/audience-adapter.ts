/**
 * @file Marketing audience reader over the tenant's own Customer360 rows.
 *
 * The reactivation audience is a server-side query, never an audience asserted by a caller or a
 * model: a customer is included only when their recorded last paid purchase is older than the
 * requested inactivity window, their derived RFM hypothesis matches, and they have channel-specific
 * consent without global suppression. The size is owner-policy bounded and overflow is refused.
 */

import type { ExecutionContext } from '@agentos/skills';
import { assertTenantContext, withTenantContext, type TenantTransactionRunner } from '@agentos/database';
import type { InputMktSegmentAudience, OutputMktSegmentAudience } from './skills/types.js';

const MARKETING_CONSENT_TYPE = 'marketing_messaging';
export const DEFAULT_MARKETING_AUDIENCE_LIMIT = 100;
const MARKETING_CHANNELS: Readonly<Record<NonNullable<InputMktSegmentAudience['channel']>, string>> = {
  LINE: 'line',
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
  SMS: 'sms',
  ZALO: 'zalo',
  TIKTOK: 'tiktok',
  MESSENGER: 'messenger',
  INSTAGRAM: 'instagram',
};

export interface MarketingAudiencePolicy {
  readonly getApprovedAudienceLimit: (tenant_id: string) => Promise<number | undefined>;
}

export interface MarketingAudienceReaderOptions {
  /** Injected tenant transaction runner; defaults to the canonical RLS-scoped runner. */
  readonly runInTenantTransaction?: TenantTransactionRunner;
  /** Injected clock for the deterministic `generated_at` stamp. */
  readonly now?: () => Date;
  /** Owner-approved per-tenant audience cap. */
  readonly audiencePolicy?: MarketingAudiencePolicy;
}

interface AudienceRow {
  readonly customer_id: string;
}

/**
 * Builds the `PostgreSQL.Customer360Store` audience reader used by `skill.mkt.segment_audience`.
 *
 * @param options Injected transaction runner and clock.
 * @returns A reader that refuses a mismatched tenant/context pair before touching the database.
 */
export function createMarketingAudienceReader(options: MarketingAudienceReaderOptions = {}) {
  const runInTenantTransaction = options.runInTenantTransaction ?? withTenantContext;
  const now = options.now ?? (() => new Date());

  return async function readAudience(
    input: InputMktSegmentAudience,
    context: ExecutionContext,
  ): Promise<OutputMktSegmentAudience> {
    const tenant_id = input.tenant_id;
    if (tenant_id !== context.tenant_id) {
      throw new Error('TENANT_CONTEXT_MISMATCH: audience input tenant does not match the execution context');
    }
    assertTenantContext(tenant_id);

    const minDaysInactive = input.min_days_inactive;
    if (!Number.isSafeInteger(minDaysInactive) || minDaysInactive < 0) {
      throw new Error('INVALID_SEGMENT_CRITERIA: min_days_inactive must be a non-negative integer');
    }
    const channel = input.channel === undefined ? undefined : MARKETING_CHANNELS[input.channel];
    if (channel === undefined) {
      throw new Error('INVALID_SEGMENT_CRITERIA: campaign channel is required and must be contactable');
    }
    const ownerLimit = await options.audiencePolicy?.getApprovedAudienceLimit(tenant_id);
    const audienceLimit = ownerLimit === undefined ? DEFAULT_MARKETING_AUDIENCE_LIMIT : ownerLimit;
    if (!Number.isSafeInteger(audienceLimit) || audienceLimit < 1) {
      throw new Error('ASM_003_UNAVAILABLE: owner-approved audience limit is unavailable or invalid');
    }
    const requestedSize = input.max_segment_size ?? audienceLimit;
    if (!Number.isSafeInteger(requestedSize) || requestedSize < 1) {
      throw new Error('INVALID_SEGMENT_CRITERIA: max_segment_size must be a positive integer');
    }
    if (requestedSize > audienceLimit) {
      throw new Error(
        `AUDIENCE_LIMIT_EXCEEDED: requested audience size ${requestedSize} exceeds owner-approved limit ${audienceLimit}`,
      );
    }

    const rows = await runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<AudienceRow>(
        `SELECT c.id::text AS customer_id
           FROM agentos.customer_360_profiles p
           JOIN agentos.customers c
             ON c.tenant_id = p.tenant_id AND c.id = p.customer_id
          WHERE p.tenant_id = $1
            AND p.rfm_segment_hypothesis = $2
            AND p.suppression_active = FALSE
            AND c.metadata->>'last_paid_purchase_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            AND (c.metadata->>'last_paid_purchase_at')::timestamptz
                <= CURRENT_TIMESTAMP - make_interval(days => $3::int)
            AND EXISTS (
                  SELECT 1
                    FROM agentos.customer_identities ci
                   WHERE ci.tenant_id = p.tenant_id
                     AND ci.customer_id = p.customer_id
                     AND ci.channel_type = $4
                     AND ci.verified_at IS NOT NULL
                )
            AND EXISTS (
                  SELECT 1
                    FROM agentos.consents k
                   WHERE k.tenant_id = p.tenant_id
                     AND k.customer_id = p.customer_id
                     AND k.consent_type = $5
                     AND k.channel = $4
                     AND k.is_granted = TRUE
                     AND k.opt_in_timestamp IS NOT NULL
                     AND k.opt_out_timestamp IS NULL
                )
          ORDER BY (c.metadata->>'last_paid_purchase_at')::timestamptz ASC, c.id ASC
          LIMIT $6::int`,
        [tenant_id, input.rfm_criteria, minDaysInactive, channel, MARKETING_CONSENT_TYPE, requestedSize + 1],
      );
      return result.rows;
    });

    if (rows.length > requestedSize) {
      throw new Error(
        `AUDIENCE_LIMIT_EXCEEDED: matching audience exceeds requested size ${requestedSize}; refusing to truncate`,
      );
    }
    const customer_ids = rows.map((row) => row.customer_id);
    return {
      segment_id: `inactive_${String(minDaysInactive)}d`,
      matched_customer_count: customer_ids.length,
      customer_ids,
      generated_at: now().toISOString(),
    };
  };
}

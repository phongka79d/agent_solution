import type {
  CompanyCrmCampaignEngagementRow,
  CompanyCrmCustomerProfileRow,
  CompanyCrmCustomerRow,
  CompanyCrmIdentityRow,
  CompanyCrmRecommendationRow,
} from '@agentos/database';
import { maskIdentity } from './masking.js';

export type EpistemicClassification = 'FACT' | 'SIGNAL' | 'HYPOTHESIS' | 'DECISION' | 'ACTION' | 'UNCLASSIFIED';

export interface CustomerIdentityProjection {
  readonly channel: string;
  readonly value: string;
  readonly primary: boolean;
  readonly verified_at: string | null;
}

export interface CustomerListItem {
  readonly customer_id: string;
  readonly display_name: string | null;
  readonly tier: string;
  readonly verification_status: string;
  readonly created_at: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly identities: readonly CustomerIdentityProjection[];
  readonly profile_available: boolean;
}

export interface CustomerRecommendationProjection {
  readonly recommendation_id: string;
  readonly recommendation_type: string;
  readonly reason: string;
  readonly evidence: unknown;
  readonly confidence: number | null;
  readonly expected_outcome: unknown;
  readonly status: string;
  readonly classification: 'HYPOTHESIS';
  readonly created_at: string;
  readonly expires_at: string;
}

export interface CustomerProfileProjection extends CustomerListItem {
  readonly total_spent?: string;
  readonly order_count?: number;
  readonly rfm_segment?: string;
  readonly consent_marketing?: boolean;
  readonly suppression_active?: boolean;
  readonly orders: readonly Record<string, unknown>[];
  readonly conversations: readonly Record<string, unknown>[];
  readonly campaign_engagement: readonly Record<string, unknown>[];
  readonly recommendations: readonly CustomerRecommendationProjection[];
  readonly service_cases: readonly Record<string, unknown>[];
}

/** Unknown evidence classes are explicit, never guessed as SIGNAL. */
export function normalizeClassification(value: unknown): EpistemicClassification {
  if (value === 'FACT' || value === 'SIGNAL' || value === 'HYPOTHESIS' || value === 'DECISION' || value === 'ACTION') {
    return value;
  }
  return 'UNCLASSIFIED';
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function identitiesOf(row: CompanyCrmCustomerRow): readonly CustomerIdentityProjection[] {
  const rows = Array.isArray(row.identities) ? row.identities : [];
  return rows.map((identity: CompanyCrmIdentityRow) => ({
    channel: identity.channel_type,
    value: maskIdentity(identity.channel_identifier, identity.channel_type) ?? '***',
    primary: identity.is_primary,
    verified_at: identity.verified_at === null ? null : iso(identity.verified_at),
  }));
}

/** Maps one customer list source row while masking every identity value. */
export function toCustomerListItem(row: CompanyCrmCustomerRow): CustomerListItem {
  return {
    customer_id: row.customer_id,
    display_name: row.display_name,
    tier: row.customer_tier,
    verification_status: row.verification_status,
    created_at: iso(row.created_at),
    email: maskIdentity(row.verified_email, 'email'),
    phone: maskIdentity(row.verified_phone, 'phone'),
    identities: identitiesOf(row),
    profile_available: row.verified_phone !== null || row.verified_email !== null || row.total_spent !== null,
  };
}

function engagementOf(rows: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: CompanyCrmCampaignEngagementRow) => ({
    outcome_id: row.outcome_id,
    campaign_id: row.campaign_id,
    conversion_type: row.conversion_type,
    gross_revenue: row.gross_revenue,
    net_margin: row.net_margin,
    recorded_at: iso(row.recorded_at),
    classification: 'FACT' as const,
  }));
}

function recommendationOf(row: CompanyCrmRecommendationRow): CustomerRecommendationProjection {
  const confidence = row.confidence === null ? null : Number(row.confidence);
  return {
    recommendation_id: row.recommendation_id,
    recommendation_type: row.recommendation_type,
    reason: row.reason,
    evidence: row.evidence,
    confidence: Number.isFinite(confidence) ? confidence : null,
    expected_outcome: row.expected_outcome,
    status: row.status,
    classification: 'HYPOTHESIS',
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
  };
}

function recordRows(rows: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

export function toCustomerProfile(row: CompanyCrmCustomerProfileRow): CustomerProfileProjection {
  const base = toCustomerListItem(row);
  return {
    ...base,
    ...(row.total_spent === null ? {} : { total_spent: row.total_spent }),
    ...(row.order_count === null ? {} : { order_count: row.order_count }),
    ...(row.rfm_segment_hypothesis === null ? {} : { rfm_segment: row.rfm_segment_hypothesis }),
    ...(row.consent_marketing === null ? {} : { consent_marketing: row.consent_marketing }),
    ...(row.suppression_active === null ? {} : { suppression_active: row.suppression_active }),
    orders: recordRows(row.orders),
    conversations: recordRows(row.conversations),
    campaign_engagement: engagementOf(row.campaign_engagement),
    recommendations: (Array.isArray(row.recommendations) ? row.recommendations : []).map(recommendationOf),
    service_cases: recordRows(row.service_cases),
  };
}

/** Alias used by routes and downstream projection consumers. */
export const mapCustomerProfile = toCustomerProfile;

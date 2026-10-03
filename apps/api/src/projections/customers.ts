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
  /**
   * Data class of the row's source, one of the `agentos.data_class` enum values
   * (`PRODUCTION | DEMO | TEST`). Rows from the tenant's production CRM are `PRODUCTION`;
   * a stored class on the row wins.
   */
  readonly data_class: string;
  readonly created_at: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly identities: readonly CustomerIdentityProjection[];
  readonly profile_available: boolean;
  /** RFM segment hypothesis (`HYPOTHESIS` by nature, never presented as a verified fact). */
  readonly segment: string | null;
  readonly total_spent: string | null;
  readonly order_count: number | null;
  readonly consent_marketing: boolean | null;
  /** Newest stored customer event, or `null` when the source row carries none. */
  readonly last_activity_at: string | null;
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

/**
 * Normalizes a stored data class onto the `agentos.data_class` enum
 * (`PRODUCTION | DEMO | TEST`) that `statusView('data_class', …)` renders. A row whose class is
 * absent is produced by the tenant's live CRM, so it is `PRODUCTION`; an unrecognised stored value
 * is passed through verbatim rather than silently relabelled.
 */
export function normalizeDataClass(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'PRODUCTION';
  return value.trim().toUpperCase();
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
    data_class: normalizeDataClass('data_class' in row ? row.data_class : undefined),
    created_at: iso(row.created_at),
    email: maskIdentity(row.verified_email, 'email'),
    phone: maskIdentity(row.verified_phone, 'phone'),
    identities: identitiesOf(row),
    profile_available: row.verified_phone !== null || row.verified_email !== null || row.total_spent !== null,
    segment: row.rfm_segment_hypothesis,
    total_spent: row.total_spent,
    order_count: row.order_count,
    consent_marketing: row.consent_marketing,
    last_activity_at:
      'last_activity_at' in row && (typeof row.last_activity_at === 'string' || row.last_activity_at instanceof Date)
        ? iso(row.last_activity_at)
        : null,
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

/** The five sources the Customer 360 timeline merges into one chronology (spec §7.4). */
export type CustomerTimelineKind =
  | 'EVENT'
  | 'CONVERSATION'
  | 'ORDER'
  | 'CAMPAIGN_ENGAGEMENT'
  | 'SERVICE_CASE';

export interface CustomerTimelineItem {
  readonly item_id: string;
  readonly kind: CustomerTimelineKind;
  /** `null` when the source row carries no usable timestamp — never a fabricated instant. */
  readonly occurred_at: string | null;
  readonly title: string;
  readonly summary: string;
  readonly classification: EpistemicClassification;
  readonly data_class: string;
  readonly source_record_id: string | null;
}

export interface CustomerTimelineSources {
  readonly events?: readonly unknown[];
  readonly conversations?: readonly unknown[];
  readonly orders?: readonly unknown[];
  readonly campaign_engagement?: readonly unknown[];
  readonly service_cases?: readonly unknown[];
}

/** Row shapes are projection-specific; an unknown row is read as a keyed record at this boundary. */
function keyedRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fieldText(row: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function occurredAtOf(row: Record<string, unknown>): string | null {
  const raw = fieldText(row, 'occurred_at', 'occurredAt', 'recorded_at', 'created_at', 'last_message_at', 'updated_at');
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Merges customer events with conversations, orders, campaign engagement and support cases into
 * one chronology, newest first.
 *
 * Every item keeps the epistemic class of its own source: stored engagement is `FACT`, an order is
 * `FACT`, and a row whose class is absent or unrecognised is `UNCLASSIFIED` — never silently
 * promoted to `SIGNAL`. Rows without a usable timestamp sort last rather than being dropped.
 */
export function mergeCustomerTimeline(sources: CustomerTimelineSources): readonly CustomerTimelineItem[] {
  const merged: CustomerTimelineItem[] = [];

  for (const eventRow of sources.events ?? []) {
    const event = keyedRecord(eventRow);
    merged.push({
      item_id: fieldText(event, 'event_id', 'eventId', 'id') ?? `event-${merged.length}`,
      kind: 'EVENT',
      occurred_at: occurredAtOf(event),
      title: fieldText(event, 'canonical_event', 'event_type', 'event_name') ?? 'Sự kiện',
      summary: fieldText(event, 'summary', 'description', 'message') ?? '',
      classification: normalizeClassification(event.classification),
      data_class: normalizeDataClass(event.data_class),
      source_record_id: fieldText(event, 'source_record_id', 'evidence_reference'),
    });
  }

  for (const conversationRow of sources.conversations ?? []) {
    const conversation = keyedRecord(conversationRow);
    merged.push({
      item_id: fieldText(conversation, 'conversation_id', 'id') ?? `conversation-${merged.length}`,
      kind: 'CONVERSATION',
      occurred_at: occurredAtOf(conversation),
      title: fieldText(conversation, 'channel') ?? 'Hội thoại',
      summary: fieldText(conversation, 'state', 'snippet', 'summary') ?? '',
      classification: normalizeClassification(conversation.classification),
      data_class: normalizeDataClass(conversation.data_class),
      source_record_id: fieldText(conversation, 'conversation_id', 'id'),
    });
  }

  for (const orderRow of sources.orders ?? []) {
    const order = keyedRecord(orderRow);
    merged.push({
      item_id: fieldText(order, 'order_id', 'id') ?? `order-${merged.length}`,
      kind: 'ORDER',
      occurred_at: occurredAtOf(order),
      title: fieldText(order, 'order_number', 'order_id', 'id') ?? 'Đơn hàng',
      summary: [fieldText(order, 'status'), fieldText(order, 'total_amount')].filter((part): part is string => part !== null).join(' · '),
      classification: order.classification === undefined ? 'FACT' : normalizeClassification(order.classification),
      data_class: normalizeDataClass(order.data_class),
      source_record_id: fieldText(order, 'order_id', 'id'),
    });
  }

  for (const engagementRow of sources.campaign_engagement ?? []) {
    const engagement = keyedRecord(engagementRow);
    merged.push({
      item_id: fieldText(engagement, 'outcome_id', 'id') ?? `engagement-${merged.length}`,
      kind: 'CAMPAIGN_ENGAGEMENT',
      occurred_at: occurredAtOf(engagement),
      title: fieldText(engagement, 'conversion_type') ?? 'Tương tác chiến dịch',
      summary: [fieldText(engagement, 'campaign_id'), fieldText(engagement, 'gross_revenue')].filter((part): part is string => part !== null).join(' · '),
      classification: engagement.classification === undefined ? 'FACT' : normalizeClassification(engagement.classification),
      data_class: normalizeDataClass(engagement.data_class),
      source_record_id: fieldText(engagement, 'outcome_id', 'id'),
    });
  }

  for (const serviceCaseRow of sources.service_cases ?? []) {
    const serviceCase = keyedRecord(serviceCaseRow);
    merged.push({
      item_id: fieldText(serviceCase, 'case_id', 'id') ?? `case-${merged.length}`,
      kind: 'SERVICE_CASE',
      occurred_at: occurredAtOf(serviceCase),
      title: fieldText(serviceCase, 'subject', 'case_type', 'title') ?? 'Yêu cầu hỗ trợ',
      summary: fieldText(serviceCase, 'status', 'summary', 'resolution') ?? '',
      classification: normalizeClassification(serviceCase.classification),
      data_class: normalizeDataClass(serviceCase.data_class),
      source_record_id: fieldText(serviceCase, 'case_id', 'id'),
    });
  }

  return merged.sort((left, right) => {
    if (left.occurred_at === null && right.occurred_at === null) return 0;
    if (left.occurred_at === null) return 1;
    if (right.occurred_at === null) return -1;
    return right.occurred_at.localeCompare(left.occurred_at);
  });
}

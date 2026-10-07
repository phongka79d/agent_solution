import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/** A masked-safe source row for one customer identity. Raw values never cross the API mapper. */
export interface CompanyCrmIdentityRow extends QueryResultRow {
  channel_type: string;
  channel_identifier: string;
  is_primary: boolean;
  verified_at: Date | null;
}

export interface CompanyCrmCustomerRow extends QueryResultRow {
  customer_id: string;
  tenant_id: string;
  display_name: string | null;
  customer_tier: string;
  verification_status: string;
  created_at: Date | string;
  verified_phone: string | null;
  verified_email: string | null;
  total_spent: string | null;
  order_count: number | null;
  rfm_segment_hypothesis: string | null;
  consent_marketing: boolean | null;
  suppression_active: boolean | null;
  identities: readonly CompanyCrmIdentityRow[] | null;
}

export interface CompanyCrmOrderRow extends QueryResultRow {
  order_id: string;
  order_number: string;
  status: string;
  currency: string;
  total_amount: string;
  created_at: Date | string;
}

export interface CompanyCrmConversationRow extends QueryResultRow {
  conversation_id: string;
  channel: string;
  state: string;
  active_agent: string;
  takeover_operator_id: string | null;
  last_message_at: Date | string;
  created_at: Date | string;
}

export interface CompanyCrmRecommendationRow extends QueryResultRow {
  recommendation_id: string;
  recommendation_type: string;
  reason: string;
  evidence: unknown;
  confidence: string | number | null;
  expected_outcome: unknown;
  status: string;
  created_at: Date | string;
  expires_at: Date | string;
  classification?: string | null;
}

export interface CompanyCrmServiceCaseRow extends QueryResultRow {
  case_id: string;
  case_number: string;
  state: string;
  priority: string;
  category: string;
  subject: string;
  assigned_agent: string;
  assigned_human_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}


export interface CompanyCrmCampaignRow extends QueryResultRow {
  campaign_id: string | null;
  run_id: string | null;
  name: string | null;
  objective: string | null;
  channels: unknown;
  campaign_status: string | null;
  campaign_created_at: Date | string | null;
  campaign_updated_at: Date | string | null;
  task_state: string | null;
  task_payload: unknown;
  task_created_at: Date | string | null;
  approval_id: string | null;
  approval_decision: string | null;
  approval_created_at: Date | string | null;
  approval_decided_at: Date | string | null;
  approval_payload: unknown;
}

export interface CompanyCrmCampaignEngagementRow extends QueryResultRow {
  outcome_id: string;
  campaign_id: string | null;
  conversion_type: string;
  gross_revenue: string;
  net_margin: string;
  recorded_at: Date | string;
}

/** One customer row plus source rows used by the profile projection. */
export interface CompanyCrmCustomerProfileRow extends CompanyCrmCustomerRow {
  orders: readonly CompanyCrmOrderRow[] | null;
  conversations: readonly CompanyCrmConversationRow[] | null;
  campaign_engagement: readonly CompanyCrmCampaignEngagementRow[] | null;
  recommendations: readonly CompanyCrmRecommendationRow[] | null;
  service_cases: readonly CompanyCrmServiceCaseRow[] | null;
}
export interface CompanyCrmConversationSummaryRow extends QueryResultRow {
  conversation_id: string;
  customer_id: string | null;
  channel: string;
  state: string;
  active_agent: string;
  takeover_operator_id: string | null;
  last_message_at: Date | string;
  verified_phone: string | null;
  verified_email: string | null;
  customer_display_name: string | null;
  customer_tier: string | null;
  customer_classification: string | null;
}

export interface CustomerListInput {
  readonly tenant_id: string;
  readonly query?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CustomerListPage {
  readonly items: readonly CompanyCrmCustomerRow[];
  readonly next_cursor: string | null;
}

export interface CampaignListInput {
  readonly tenant_id: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CampaignListPage {
  readonly items: readonly CompanyCrmCampaignRow[];
  readonly next_cursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CURSOR_SEPARATOR = '|';

function boundedLimit(limit: number | undefined, code: string): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`${code}: limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function decodeCursor(cursor: string | undefined, code: string): { created_at: string; id: string } | null {
  if (cursor === undefined) return null;
  const separator = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (separator <= 0 || separator === cursor.length - 1) {
    throw new Error(`${code}: cursor is invalid`);
  }
  const created_at = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(Date.parse(created_at)) || id.length === 0) {
    throw new Error(`${code}: cursor is invalid`);
  }
  return { created_at, id };
}

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value as readonly T[] : [];
}

/**
 * Read-only projections over authoritative CRM and control-plane rows. Every operation enters the
 * existing tenant transaction helper before issuing a statement, including reads of views.
 */
export class CompanyCrmProjectionRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  async listCustomers(input: CustomerListInput): Promise<CustomerListPage> {
    const limit = boundedLimit(input.limit, 'CUSTOMER_LIST_LIMIT_INVALID');
    const cursor = decodeCursor(input.cursor, 'CUSTOMER_LIST_CURSOR_INVALID');
    const query = input.query?.trim() ?? '';

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<CompanyCrmCustomerRow>(
        `SELECT c.id AS customer_id, c.tenant_id, c.display_name, c.customer_tier,
                c.verification_status, c.created_at,
                p.verified_phone, p.verified_email, p.total_spent,
                p.order_count, p.rfm_segment_hypothesis,
                p.consent_marketing, p.suppression_active,
                COALESCE(json_agg(json_build_object(
                  'channel_type', ci.channel_type,
                  'channel_identifier', ci.channel_identifier,
                  'is_primary', ci.is_primary,
                  'verified_at', ci.verified_at
                ) ORDER BY ci.channel_type) FILTER (WHERE ci.id IS NOT NULL), '[]'::json) AS identities
           FROM agentos.customers c
           LEFT JOIN agentos.customer_360_profiles p
             ON p.tenant_id = c.tenant_id AND p.customer_id = c.id
           LEFT JOIN agentos.customer_identities ci
             ON ci.tenant_id = c.tenant_id AND ci.customer_id = c.id
          WHERE c.tenant_id = $1
            AND ($2::text = '' OR c.display_name ILIKE '%' || $2::text || '%'
                 OR c.primary_email ILIKE '%' || $2::text || '%'
                 OR c.primary_phone ILIKE '%' || $2::text || '%'
                 OR c.external_crm_id ILIKE '%' || $2::text || '%')
            AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid))
          GROUP BY c.id, c.tenant_id, c.display_name, c.customer_tier,
                   c.verification_status, c.created_at, p.verified_phone,
                   p.verified_email, p.total_spent, p.order_count,
                   p.rfm_segment_hypothesis, p.consent_marketing,
                   p.suppression_active
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $5`,
        [input.tenant_id, query, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows,
        next_cursor: result.rows.length > limit && last !== undefined
          ? `${toIso(last.created_at)}${CURSOR_SEPARATOR}${last.customer_id}`
          : null,
      };
    });
  }

  /** A profile row is the existence boundary: no view row means the endpoint returns 404. */
  async getCustomerProfile(tenant_id: string, customer_id: string): Promise<CompanyCrmCustomerProfileRow | null> {
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<CompanyCrmCustomerProfileRow>(
        `SELECT c.id AS customer_id, c.tenant_id, c.display_name, c.customer_tier,
                c.verification_status, c.created_at,
                p.verified_phone, p.verified_email, p.total_spent,
                p.order_count, p.rfm_segment_hypothesis,
                p.consent_marketing, p.suppression_active,
                COALESCE((SELECT json_agg(json_build_object(
                  'channel_type', ci.channel_type,
                  'channel_identifier', ci.channel_identifier,
                  'is_primary', ci.is_primary,
                  'verified_at', ci.verified_at
                ) ORDER BY ci.channel_type) FROM agentos.customer_identities ci
                 WHERE ci.tenant_id = c.tenant_id AND ci.customer_id = c.id), '[]'::json) AS identities,
                COALESCE((SELECT json_agg(json_build_object(
                  'order_id', o.id, 'order_number', o.order_number, 'status', o.status,
                  'currency', o.currency, 'total_amount', o.total_amount, 'created_at', o.created_at
                ) ORDER BY o.created_at DESC) FROM agentos.orders o
                 WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id), '[]'::json) AS orders,
                COALESCE((SELECT json_agg(json_build_object(
                  'conversation_id', cv.id, 'channel', cv.channel, 'state', cv.state,
                  'active_agent', cv.active_agent, 'takeover_operator_id', cv.takeover_operator_id,
                  'last_message_at', cv.last_message_at, 'created_at', cv.created_at
                ) ORDER BY cv.last_message_at DESC) FROM agentos.conversations cv
                 WHERE cv.tenant_id = c.tenant_id AND cv.customer_id = c.id), '[]'::json) AS conversations,
                COALESCE((SELECT json_agg(json_build_object(
                  'outcome_id', o.id, 'campaign_id', o.campaign_id,
                  'conversion_type', o.conversion_type,
                  'gross_revenue', o.gross_revenue, 'net_margin', o.net_margin,
                  'recorded_at', o.recorded_at
                ) ORDER BY o.recorded_at DESC) FROM agentos.outcomes o
                 WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id), '[]'::json) AS campaign_engagement,
                COALESCE((SELECT json_agg(json_build_object(
                  'recommendation_id', r.id, 'recommendation_type', r.recommendation_type,
                  'reason', r.reason, 'evidence', r.evidence, 'confidence', r.confidence,
                  'expected_outcome', r.expected_outcome, 'status', r.status,
                  'created_at', r.created_at, 'expires_at', r.expires_at
                ) ORDER BY r.created_at DESC) FROM agentos.recommendations r
                 WHERE r.tenant_id = c.tenant_id AND r.customer_id = c.id), '[]'::json) AS recommendations,
                COALESCE((SELECT json_agg(json_build_object(
                  'case_id', sc.id, 'case_number', sc.case_number, 'state', sc.state,
                  'priority', sc.priority, 'category', sc.category, 'subject', sc.subject,
                  'assigned_agent', sc.assigned_agent, 'assigned_human_id', sc.assigned_human_id,
                  'created_at', sc.created_at, 'updated_at', sc.updated_at
                ) ORDER BY sc.updated_at DESC) FROM agentos.service_cases sc
                 WHERE sc.tenant_id = c.tenant_id AND sc.customer_id = c.id), '[]'::json) AS service_cases
           FROM agentos.customers c
           LEFT JOIN agentos.customer_360_profiles p ON c.tenant_id = p.tenant_id AND c.id = p.customer_id
          WHERE c.tenant_id = $1 AND c.id = $2
          GROUP BY c.id, c.tenant_id, c.display_name, c.customer_tier,
                   c.verification_status, c.created_at, p.verified_phone,
                   p.verified_email, p.total_spent, p.order_count,
                   p.rfm_segment_hypothesis, p.consent_marketing,
                   p.suppression_active`,
        [tenant_id, customer_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        ...row,
        identities: asArray<CompanyCrmIdentityRow>(row.identities),
        orders: asArray<CompanyCrmOrderRow>(row.orders),
        conversations: asArray<CompanyCrmConversationRow>(row.conversations),
        campaign_engagement: asArray<CompanyCrmCampaignEngagementRow>(row.campaign_engagement),
        recommendations: asArray<CompanyCrmRecommendationRow>(row.recommendations),
        service_cases: asArray<CompanyCrmServiceCaseRow>(row.service_cases),
      };
    });
  }

  async listCampaigns(input: CampaignListInput): Promise<CampaignListPage> {
    const limit = boundedLimit(input.limit, 'CAMPAIGN_LIST_LIMIT_INVALID');
    const cursor = decodeCursor(input.cursor, 'CAMPAIGN_LIST_CURSOR_INVALID');
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<CompanyCrmCampaignRow>(
        `SELECT c.id AS campaign_id, t.run_id, c.name, c.objective, c.channels,
                c.status AS campaign_status, c.created_at AS campaign_created_at,
                c.updated_at AS campaign_updated_at, t.state AS task_state,
                t.state_payload AS task_payload, t.created_at AS task_created_at,
                a.id AS approval_id, a.decision AS approval_decision,
                a.created_at AS approval_created_at, a.decided_at AS approval_decided_at,
                a.payload AS approval_payload
           FROM agentos.platform_durable_tasks t
           LEFT JOIN agentos.approvals a
             ON a.tenant_id = t.tenant_id AND a.run_id = t.run_id
           LEFT JOIN agentos.campaigns c
             ON c.tenant_id = t.tenant_id
            AND (c.id::text = t.state_payload->'signal'->'payload'->>'campaign_id'
                 OR c.id = a.campaign_id)
          WHERE t.tenant_id = $1
            AND t.state_payload->'signal'->'payload'->>'module' = 'marketing'
            AND ($2::timestamptz IS NULL OR (t.created_at, t.run_id) < ($2::timestamptz, $3::varchar))
          ORDER BY t.created_at DESC, t.run_id DESC
          LIMIT $4`,
        [input.tenant_id, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows,
        next_cursor: result.rows.length > limit && last !== undefined && last.task_created_at !== null
          ? `${toIso(last.task_created_at)}${CURSOR_SEPARATOR}${last.run_id ?? ''}`
          : null,
      };
    });
  }

  async getCampaign(tenant_id: string, run_id: string): Promise<CompanyCrmCampaignRow | null> {
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<CompanyCrmCampaignRow>(
        `SELECT c.id AS campaign_id, t.run_id, c.name, c.objective, c.channels,
                c.status AS campaign_status, c.created_at AS campaign_created_at,
                c.updated_at AS campaign_updated_at, t.state AS task_state,
                t.state_payload AS task_payload, t.created_at AS task_created_at,
                a.id AS approval_id, a.decision AS approval_decision,
                a.created_at AS approval_created_at, a.decided_at AS approval_decided_at,
                a.payload AS approval_payload
           FROM agentos.platform_durable_tasks t
           LEFT JOIN agentos.approvals a
             ON a.tenant_id = t.tenant_id AND a.run_id = t.run_id
           LEFT JOIN agentos.campaigns c
             ON c.tenant_id = t.tenant_id
            AND (c.id::text = t.state_payload->'signal'->'payload'->>'campaign_id'
                 OR c.id = a.campaign_id)
          WHERE t.tenant_id = $1
            AND t.run_id = $2
            AND t.state_payload->'signal'->'payload'->>'module' = 'marketing'`,
        [tenant_id, run_id],
      );
      return result.rows[0] ?? null;
    });
  }

  async getConversationSummary(tenant_id: string, conversation_id: string): Promise<CompanyCrmConversationSummaryRow | null> {
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<CompanyCrmConversationSummaryRow>(
        `SELECT cv.id AS conversation_id, cv.customer_id, cv.channel, cv.state,
                cv.active_agent, cv.takeover_operator_id, cv.last_message_at,
                p.verified_phone, p.verified_email,
                c.display_name AS customer_display_name, c.customer_tier,
                c.verification_status AS customer_classification
           FROM agentos.conversations cv
           LEFT JOIN agentos.customers c
             ON c.tenant_id = cv.tenant_id AND c.id = cv.customer_id
           LEFT JOIN agentos.customer_360_profiles p
             ON p.tenant_id = cv.tenant_id AND p.customer_id = cv.customer_id
          WHERE cv.tenant_id = $1 AND cv.id = $2`,
        [tenant_id, conversation_id],
      );
      return result.rows[0] ?? null;
    });
  }

  /** Alias retained for callers that use the API resource name. */
  getCustomer(tenant_id: string, customer_id: string): Promise<CompanyCrmCustomerProfileRow | null> {
    return this.getCustomerProfile(tenant_id, customer_id);
  }

  getCampaignDetail(tenant_id: string, run_id: string): Promise<CompanyCrmCampaignRow | null> {
    return this.getCampaign(tenant_id, run_id);
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Structural helper used by the binding tests without exposing a database client. */
export type CompanyCrmProjectionClient = Pick<PoolClient, 'query'>;

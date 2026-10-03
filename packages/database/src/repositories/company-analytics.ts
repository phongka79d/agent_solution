import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export const COMPANY_ANALYTICS_WINDOWS = ['24h', '7d', '30d'] as const;
export type CompanyAnalyticsWindow = (typeof COMPANY_ANALYTICS_WINDOWS)[number];

export type CompanyAnalyticsSourceStatus = 'OK' | 'NO_DATA' | 'NOT_INTEGRATED';

export interface CompanyAnalyticsBreakdownEntry {
  readonly key: string;
  readonly value: number;
}

export interface CompanyAnalyticsKpi {
  readonly key: string;
  readonly kind: 'NUMBER' | 'PERCENT' | 'DURATION_MS' | 'BREAKDOWN';
  readonly value: number | null;
  readonly unit: 'count' | 'percent' | 'ms';
  readonly source_status: CompanyAnalyticsSourceStatus;
  readonly as_of: string;
  readonly note?: string;
  readonly breakdown?: readonly CompanyAnalyticsBreakdownEntry[];
  readonly detail?: Readonly<Record<string, number>>;
}

export interface CompanyAnalyticsSnapshot {
  readonly window: CompanyAnalyticsWindow;
  readonly as_of: string;
  readonly kpis: readonly CompanyAnalyticsKpi[];
}

export interface CompanyAnalyticsQuery {
  readonly tenant_id: string;
  readonly window: CompanyAnalyticsWindow;
  readonly since: Date;
  readonly until: Date;
}

interface CountRow extends QueryResultRow { count: number }
interface FirstResponseRow extends QueryResultRow { avg_ms: number | null }
interface ApprovalRow extends QueryResultRow {
  pending: number;
  decided: number;
  avg_decision_ms: number | null;
}
interface StatusCountRow extends QueryResultRow { status: string; count: number }
interface CostRow extends QueryResultRow { currency: string | null; amount: string | null; records: number }
interface ReasonRow extends QueryResultRow { reason: string; count: number }

/** Hard cap so a pathological tenant cannot stream an unbounded grouping into a response. */
const GROUP_LIMIT = 20;

function statusOf(count: number): CompanyAnalyticsSourceStatus {
  return count > 0 ? 'OK' : 'NO_DATA';
}

function integer(value: number | string | null): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function millis(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Read-only, tenant-scoped analytics over durable runs, responses, handoffs, approvals,
 * campaigns, token costs and stage failures. Every query is bounded by the requested
 * window and by an explicit `LIMIT`; nothing is aggregated across tenants.
 */
export class CompanyAnalyticsRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  async snapshot(query: CompanyAnalyticsQuery): Promise<CompanyAnalyticsSnapshot> {
    const { tenant_id, window, since, until } = query;
    const as_of = until.toISOString();

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const params = [tenant_id, since, until];

      const conversations = await client.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM agentos.conversations
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      );

      const resolved = await client.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM agentos.run_responses
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
            AND response_kind = 'ANSWER'`,
        params,
      );

      const handoffs = await client.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM agentos.care_handoffs
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      );

      const firstResponse = await client.query<FirstResponseRow>(
        `SELECT avg(EXTRACT(EPOCH FROM (first_reply.first_at - c.created_at)) * 1000) AS avg_ms
           FROM agentos.conversations c
           JOIN LATERAL (
             SELECT min(m.created_at) AS first_at
               FROM agentos.conversation_messages m
              WHERE m.tenant_id = c.tenant_id
                AND m.conversation_id = c.id
                AND m.sender_type = 'agent'
           ) first_reply ON first_reply.first_at IS NOT NULL
          WHERE c.tenant_id = $1 AND c.created_at >= $2 AND c.created_at < $3`,
        params,
      );

      const approvals = await client.query<ApprovalRow>(
        `SELECT
            count(*) FILTER (WHERE decision = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE decision <> 'PENDING')::int AS decided,
            avg(EXTRACT(EPOCH FROM (decided_at - created_at)) * 1000)
              FILTER (WHERE decided_at IS NOT NULL) AS avg_decision_ms
           FROM agentos.approvals
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
        params,
      );

      const campaigns = await client.query<StatusCountRow>(
        `SELECT status, count(*)::int AS count
           FROM agentos.campaigns
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
          GROUP BY status
          ORDER BY count DESC, status ASC
          LIMIT ${GROUP_LIMIT}`,
        params,
      );

      const costs = await client.query<CostRow>(
        `SELECT currency, sum(estimated_cost_amount)::text AS amount, count(*)::int AS records
           FROM agentos.token_cost_records
          WHERE tenant_id = $1 AND recorded_at >= $2 AND recorded_at < $3
            AND cost_status = 'RECORDED'
          GROUP BY currency
          ORDER BY currency ASC NULLS LAST
          LIMIT ${GROUP_LIMIT}`,
        params,
      );

      const failures = await client.query<ReasonRow>(
        `SELECT COALESCE(NULLIF(error_class, ''), NULLIF(refusal_code, ''), 'UNKNOWN') AS reason,
                count(*)::int AS count
           FROM agentos.run_stage_results
          WHERE tenant_id = $1 AND completed_at >= $2 AND completed_at < $3
            AND status IN ('failed', 'refused')
          GROUP BY reason
          ORDER BY count DESC, reason ASC
          LIMIT ${GROUP_LIMIT}`,
        params,
      );

      const conversationCount = integer(conversations.rows[0]?.count ?? 0);
      const resolvedCount = integer(resolved.rows[0]?.count ?? 0);
      const handoffCount = integer(handoffs.rows[0]?.count ?? 0);
      const handledTotal = resolvedCount + handoffCount;
      const approvalRow = approvals.rows[0];
      const pendingApprovals = integer(approvalRow?.pending ?? 0);
      const decidedApprovals = integer(approvalRow?.decided ?? 0);
      const avgDecisionMs = millis(approvalRow?.avg_decision_ms ?? null);

      const kpis: CompanyAnalyticsKpi[] = [
        {
          key: 'conversations',
          kind: 'NUMBER',
          value: conversationCount,
          unit: 'count',
          source_status: statusOf(conversationCount),
          as_of,
        },
        {
          key: 'ai_resolved_rate',
          kind: 'PERCENT',
          value: handledTotal === 0 ? null : Math.round((resolvedCount / handledTotal) * 1000) / 10,
          unit: 'percent',
          source_status: statusOf(handledTotal),
          as_of,
          detail: { resolved: resolvedCount, handed_to_staff: handoffCount },
        },
        {
          key: 'handed_to_staff',
          kind: 'NUMBER',
          value: handoffCount,
          unit: 'count',
          source_status: statusOf(handoffCount),
          as_of,
        },
        {
          key: 'avg_first_response_ms',
          kind: 'DURATION_MS',
          value: millis(firstResponse.rows[0]?.avg_ms ?? null),
          unit: 'ms',
          source_status:
            firstResponse.rows[0]?.avg_ms === null || firstResponse.rows[0]?.avg_ms === undefined
              ? 'NO_DATA'
              : 'OK',
          as_of,
        },
        {
          key: 'approvals',
          kind: 'BREAKDOWN',
          value: pendingApprovals + decidedApprovals === 0 ? null : pendingApprovals + decidedApprovals,
          unit: 'count',
          source_status: statusOf(pendingApprovals + decidedApprovals),
          as_of,
          detail: {
            pending: pendingApprovals,
            decided: decidedApprovals,
            avg_decision_ms: avgDecisionMs ?? 0,
          },
        },
        {
          key: 'campaigns_by_state',
          kind: 'BREAKDOWN',
          value: campaigns.rows.length === 0 ? null : campaigns.rows.reduce((sum, row) => sum + integer(row.count), 0),
          unit: 'count',
          source_status: campaigns.rows.length === 0 ? 'NO_DATA' : 'OK',
          as_of,
          breakdown: campaigns.rows.map((row) => ({ key: row.status, value: integer(row.count) })),
        },
        {
          key: 'ai_cost_by_currency',
          kind: 'BREAKDOWN',
          value: costs.rows.length,
          unit: 'count',
          source_status: costs.rows.length === 0 ? 'NO_DATA' : 'OK',
          as_of,
          breakdown: costs.rows.map((row) => ({
            key: row.currency ?? 'UNKNOWN',
            value: costs.rows.length,
          })),
          detail: Object.fromEntries(
            costs.rows.map((row) => [row.currency ?? 'UNKNOWN', Math.round(Number(row.amount ?? 0) * 1_000_000) / 1_000_000]),
          ),
        },
        {
          key: 'failures_by_reason',
          kind: 'BREAKDOWN',
          value: failures.rows.length === 0 ? null : failures.rows.reduce((sum, row) => sum + integer(row.count), 0),
          unit: 'count',
          source_status: failures.rows.length === 0 ? 'NO_DATA' : 'OK',
          as_of,
          breakdown: failures.rows.map((row) => ({ key: row.reason, value: integer(row.count) })),
        },
        {
          key: 'revenue_attribution',
          kind: 'NUMBER',
          value: null,
          unit: 'count',
          source_status: 'NOT_INTEGRATED',
          as_of,
          note: 'revenue_attribution_requires_order_erp',
        },
      ];

      return { window, as_of, kpis };
    });
  }
}

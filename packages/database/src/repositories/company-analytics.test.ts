import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { CompanyAnalyticsRepository } from './company-analytics.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SINCE = new Date('2026-04-01T00:00:00.000Z');
const UNTIL = new Date('2026-04-08T00:00:00.000Z');

interface Query { readonly sql: string; readonly params: readonly unknown[] }

class ScriptedClient {
  readonly queries: Query[] = [];

  constructor(private readonly empty = false) {}

  async query<Row extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ sql, params });
    const rows = this.rowsFor(sql);
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<Row>;
  }

  private rowsFor(sql: string): QueryResultRow[] {
    if (this.empty) {
      return sql.includes('FROM agentos.approvals') ? [{ pending: 0, decided: 0, avg_decision_ms: null }] : [];
    }
    if (sql.includes('FROM agentos.conversations') && sql.includes('min(m.created_at)')) {
      return [{ avg_ms: 2500 }];
    }
    if (sql.includes('FROM agentos.conversations')) return [{ count: 12 }];
    if (sql.includes('FROM agentos.run_responses')) return [{ count: 5 }];
    if (sql.includes('FROM agentos.care_handoffs')) return [{ count: 5 }];
    if (sql.includes('FROM agentos.approvals')) return [{ pending: 3, decided: 2, avg_decision_ms: 90000 }];
    if (sql.includes('FROM agentos.campaigns')) {
      return [{ status: 'running', count: 2 }, { status: 'draft', count: 1 }];
    }
    if (sql.includes('FROM agentos.token_cost_records')) {
      return [{ currency: 'VND', amount: '125000.50', records: 4 }];
    }
    if (sql.includes('FROM agentos.run_stage_results')) {
      return [{ reason: 'FATAL', count: 3 }, { reason: 'RETRYABLE', count: 1 }];
    }
    return [];
  }
}

function repositoryWith(client: ScriptedClient): CompanyAnalyticsRepository {
  return new CompanyAnalyticsRepository(async (_tenantId, callback) =>
    callback(client as unknown as PoolClient),
  );
}

describe('CompanyAnalyticsRepository.snapshot', () => {
  it('bounds every query by tenant and the requested window', async () => {
    const client = new ScriptedClient();
    await repositoryWith(client).snapshot({ tenant_id: TENANT_ID, window: '7d', since: SINCE, until: UNTIL });

    expect(client.queries.length).toBe(8);
    for (const query of client.queries) {
      expect(query.params[0]).toBe(TENANT_ID);
      expect(query.params[1]).toBe(SINCE);
      expect(query.params[2]).toBe(UNTIL);
    }
    expect(client.queries.every((query) => query.sql.includes('LIMIT') || !query.sql.includes('GROUP BY'))).toBe(true);
  });

  it('derives KPI values and honest source statuses from fixtures', async () => {
    const snapshot = await repositoryWith(new ScriptedClient())
      .snapshot({ tenant_id: TENANT_ID, window: '7d', since: SINCE, until: UNTIL });

    expect(snapshot.window).toBe('7d');
    expect(snapshot.as_of).toBe(UNTIL.toISOString());
    expect(snapshot.kpis.find((kpi) => kpi.key === 'conversations')?.value).toBe(12);
    expect(snapshot.kpis.find((kpi) => kpi.key === 'conversations')?.source_status).toBe('OK');
    expect(snapshot.kpis.find((kpi) => kpi.key === 'ai_resolved_rate')?.value).toBe(50);
    expect(snapshot.kpis.find((kpi) => kpi.key === 'ai_resolved_rate')?.detail).toMatchObject({ resolved: 5, handed_to_staff: 5 });
    expect(snapshot.kpis.find((kpi) => kpi.key === 'avg_first_response_ms')?.value).toBe(2500);
    expect(snapshot.kpis.find((kpi) => kpi.key === 'approvals')?.detail).toMatchObject({ pending: 3, decided: 2, avg_decision_ms: 90000 });
    expect(snapshot.kpis.find((kpi) => kpi.key === 'campaigns_by_state')?.breakdown).toEqual([
      { key: 'running', value: 2 },
      { key: 'draft', value: 1 },
    ]);
    expect(snapshot.kpis.find((kpi) => kpi.key === 'ai_cost_by_currency')?.detail).toEqual({ VND: 125000.5 });
    expect(snapshot.kpis.find((kpi) => kpi.key === 'failures_by_reason')?.breakdown).toEqual([
      { key: 'FATAL', value: 3 },
      { key: 'RETRYABLE', value: 1 },
    ]);
    expect(snapshot.kpis.find((kpi) => kpi.key === 'revenue_attribution')?.source_status).toBe('NOT_INTEGRATED');
    expect(snapshot.kpis.find((kpi) => kpi.key === 'revenue_attribution')?.value).toBeNull();
  });

  it('reports NO_DATA rather than a fabricated zero when a source is empty', async () => {
    const snapshot = await repositoryWith(new ScriptedClient(true))
      .snapshot({ tenant_id: TENANT_ID, window: '24h', since: SINCE, until: UNTIL });

    expect(snapshot.kpis.find((kpi) => kpi.key === 'conversations')?.source_status).toBe('NO_DATA');
    expect(snapshot.kpis.find((kpi) => kpi.key === 'ai_resolved_rate')?.value).toBeNull();
    expect(snapshot.kpis.find((kpi) => kpi.key === 'ai_resolved_rate')?.source_status).toBe('NO_DATA');
    expect(snapshot.kpis.find((kpi) => kpi.key === 'failures_by_reason')?.source_status).toBe('NO_DATA');
  });
});

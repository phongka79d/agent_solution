import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { CompanyProjectionRepository } from './company-projections.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

type Row = QueryResultRow & Record<string, unknown>;

function result<T extends Row>(rows: readonly T[]): QueryResult<T> {
  return {
    command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: [...rows],
  };
}

class Client {
  readonly statements: string[] = [];
  readonly calls: { readonly sql: string; readonly values: readonly unknown[] | undefined }[] = [];
  parkedDraftRows: readonly Row[] = [];
  activityRows: readonly Row[] = [
    { run_id: 'run-new', domain: 'sales', state: 'failed', occurred_at: new Date('2026-10-01T00:00:00Z') },
    { run_id: 'run-old', domain: 'care', state: 'completed', occurred_at: new Date('2026-09-29T00:00:00Z') },
  ];

  async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.statements.push(sql);
    this.calls.push({ sql, values });
    if (sql.includes('DISTINCT ON (skill_id)')) {
      const response = result(this.parkedDraftRows) as unknown as QueryResult<T>;
      return response;
    }
    if (sql.includes('FROM agentos.approvals') && sql.includes('a.id::text AS id')) {
      return result([{ id: 'approval-1', run_id: 'run-1', skill_name: 'skill.sales.offer', decision: 'PENDING', created_at: new Date('2026-09-30T00:00:00Z'), decided_at: null }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.care_handoffs')) {
      return result([{ id: 'handoff-1', run_id: 'run-2', conversation_id: 'conversation-1', status: 'ENQUEUED', created_at: new Date('2026-09-30T00:00:00Z') }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.connector_configurations')) {
      return result([{ connector_id: 'SHOPIFY', status: 'UNBOUND', secret_ref: 'must-not-be-selected' }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.unresolved_owner_inputs')) {
      return result([{ input_id: 'careOnboardingItinerary', status: 'UNRESOLVED' }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.platform_durable_tasks t') && sql.includes('effect_key')) {
      return result([{ run_id: 'run-3', state: 'waiting', effect_key: 'effect-1', effect_status: 'FAILED', state_payload: {} }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('LIMIT $4')) return result(this.activityRows) as unknown as QueryResult<T>;
    if (sql.includes('FROM agentos.platform_durable_tasks t') && sql.includes('t.updated_at AS occurred_at')) {
      return result([{ run_id: 'run-3', domain: 'sales', state: 'completed', occurred_at: new Date('2026-09-30T00:00:00Z') }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.agents')) {
      return result([{ code: 'SAL-01', domain: 'sales', is_active: true }]) as unknown as QueryResult<T>;
    }
    return result([]) as unknown as QueryResult<T>;
  }
}

describe('CompanyProjectionRepository', () => {
  it('binds every source query to one tenant and does not select connector secrets', async () => {
    const client = new Client();
    const tenants: string[] = [];
    const repository = new CompanyProjectionRepository(async (tenant_id, callback) => {
      tenants.push(tenant_id);
      return callback(client as unknown as PoolClient);
    });

    const sources = await repository.getSources(TENANT);
    expect(tenants).toEqual([TENANT]);
    for (const sql of client.statements) expect(sql).toMatch(/tenant_id = \$1/);
    expect(sources.connectors).toEqual([{ connector_id: 'SHOPIFY', status: 'UNBOUND' }]);
    expect(JSON.stringify(sources)).not.toContain('must-not-be-selected');
    expect(sources.reconciliations[0]?.run_id).toBe('run-3');
    expect(sources.activity).toHaveLength(2);
    const runsQuery = client.calls.find((call) => call.sql.includes('SELECT DISTINCT t.run_id'));
    expect(runsQuery?.sql).toContain('t.domain AS domain');
    expect(sources.runs_today[0]?.domain).toBe('sales');
  });

  it('bounds run outcome activity in SQL and continues from a stable timestamp/run cursor', async () => {
    const client = new Client();
    const repository = new CompanyProjectionRepository(async (_tenant_id, callback) => callback(client as unknown as PoolClient));
    const cursor = Buffer.from('2026-09-30T00:00:00.000Z\nrun-cursor', 'utf8').toString('base64url');

    const sources = await repository.getSources(TENANT, { limit: 1, cursor });

    const activityQuery = client.calls.find((call) => call.sql.includes('LIMIT $4'));
    expect(activityQuery).toBeDefined();
    // Completed checkpoints retain plan.domain, not a top-level state_payload.domain.
    expect(activityQuery?.sql).toContain('t.domain AS domain');
    expect(activityQuery?.sql).not.toContain("state_payload->>'domain'");
    expect(activityQuery?.sql).toContain('t.updated_at < $2::timestamptz');
    expect(activityQuery?.sql).toContain('t.run_id < $3');
    expect(activityQuery?.values).toEqual([TENANT, '2026-09-30T00:00:00.000Z', 'run-cursor', 2]);
    expect(sources.activity).toEqual([{
      kind: 'RUN_OUTCOME',
      run_id: 'run-new',
      domain: 'sales',
      state: 'failed',
      occurred_at: '2026-10-01T00:00:00.000Z',
    }]);
    expect(Buffer.from(sources.activity_next_cursor ?? '', 'base64url').toString('utf8'))
      .toBe('2026-10-01T00:00:00.000Z\nrun-new');
  });

  it('projects a parked draft from a waiting checkpoint without an autonomy policy', async () => {
    const client = new Client();
    client.parkedDraftRows = [{
      skill_id: 'skill.mkt.generate_content', policy_version: '', run_id: 'run-parked-campaign',
    }];
    const poolClient = client as unknown as PoolClient;
    const tenants: string[] = [];
    const repository = new CompanyProjectionRepository(async (tenant_id, callback) => {
      tenants.push(tenant_id);
      return callback(poolClient);
    });

    const sources = await repository.getSources(TENANT);

    expect(sources.parked_drafts).toEqual([{
      skill_id: 'skill.mkt.generate_content', policy_version: '', run_id: 'run-parked-campaign',
    }]);
    expect(tenants).toEqual([TENANT]);
    const query = client.calls.find((call) => call.sql.includes('DISTINCT ON (skill_id)'));
    expect(query?.values).toEqual([TENANT]);
    expect(query?.sql).toContain('FROM agentos.platform_durable_tasks t');
    expect(query?.sql).toContain("t.tenant_id = $1 AND t.state = 'waiting'");
    expect(query?.sql).toContain("t.state_payload->'pending_action'->>'skill_id'");
    expect(query?.sql).toContain("IN ('skill.mkt.generate_content', 'skill.mkt.segment_audience')");
    expect(query?.sql).toContain('UNION ALL');
  });

  it('deduplicates policy and waiting-task sources by skill while retaining policy provenance', async () => {
    const client = new Client();
    client.parkedDraftRows = [{
      skill_id: 'skill.mkt.segment_audience', policy_version: 'v1', run_id: null,
    }];
    const poolClient = client as unknown as PoolClient;
    const repository = new CompanyProjectionRepository(async (_tenant_id, callback) => callback(poolClient));

    const sources = await repository.getSources(TENANT);

    expect(sources.parked_drafts).toEqual([{ skill_id: 'skill.mkt.segment_audience', policy_version: 'v1' }]);
    const query = client.calls.find((call) => call.sql.includes('DISTINCT ON (skill_id)'));
    expect(query?.sql).toContain("WHERE tenant_id = $1 AND state = 'MINIMUM'");
    expect(query?.sql).toContain('ORDER BY skill_id ASC, source_priority ASC, policy_version ASC, run_id ASC');
  });

  it('publishes no rows when all authoritative sources are empty', async () => {
    const client = new Client();
    client.query = async <T extends QueryResultRow>(): Promise<QueryResult<T>> => result([]) as unknown as QueryResult<T>;
    const repository = new CompanyProjectionRepository(async (_tenant_id, callback) => callback(client as unknown as PoolClient));
    const sources = await repository.snapshot(TENANT);
    expect(sources.approvals).toEqual([]);
    expect(sources.handoffs).toEqual([]);
    expect(sources.activity).toEqual([]);
  });
});

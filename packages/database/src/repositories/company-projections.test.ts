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

  async query<T extends QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql);
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
    if (sql.includes('FROM agentos.platform_durable_tasks t') && sql.includes('t.state::text AS state')) {
      return result([{ run_id: 'run-3', state: 'waiting', effect_key: 'effect-1', effect_status: 'FAILED', state_payload: {} }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.platform_durable_tasks t') && sql.includes('t.updated_at AS occurred_at')) {
      return result([{ run_id: 'run-3', domain: 'sales', occurred_at: new Date('2026-09-30T00:00:00Z') }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.agents')) {
      return result([{ code: 'SAL-01', domain: 'sales', is_active: true }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.run_responses')) {
      return result([{ run_id: 'run-1', occurred_at: new Date('2026-09-30T00:00:00Z'), domain: 'sales' }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.run_stage_events')) {
      return result([{ run_id: 'run-2', entered_at: new Date('2026-09-30T00:00:00Z'), stage: 'OUTCOME', domain: 'care' }]) as unknown as QueryResult<T>;
    }
    if (sql.includes('FROM agentos.approvals a')) {
      return result([{ run_id: 'run-1', decided_at: new Date('2026-09-30T00:00:00Z'), decision: 'APPROVED', domain: 'sales' }]) as unknown as QueryResult<T>;
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
    expect(client.statements).toHaveLength(10);
    expect(sources.connectors).toEqual([{ connector_id: 'SHOPIFY', status: 'UNBOUND' }]);
    expect(JSON.stringify(sources)).not.toContain('must-not-be-selected');
    expect(sources.reconciliations[0]?.run_id).toBe('run-3');
    expect(sources.activity).toHaveLength(3);
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

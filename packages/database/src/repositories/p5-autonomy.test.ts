import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { P5AutonomyRepository, type AppendTokenCostRecordInput } from './p5-autonomy.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const RECORDED_AT = new Date('2026-01-01T00:00:00.000Z');

class ScriptedClient {
  readonly queries: string[] = [];
  private inserted = false;

  async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql);
    const row = {
      tenant_id: TENANT,
      record_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      idempotency_key: 'provider-call-1',
      run_id: 'run-1',
      correlation_id: 'corr-1',
      model: 'model-1',
      provider: 'provider-1',
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      estimated_cost_amount: '0.25',
      currency: 'USD',
      cost_status: 'RECORDED' as const,
      provenance: { source: 'provider' },
      recorded_at: RECORDED_AT,
    };

    if (sql.startsWith('INSERT INTO agentos.token_cost_records')) {
      if (this.inserted) return { rows: [], rowCount: 0 } as unknown as QueryResult<R>;
      this.inserted = true;
      return { rows: [row] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.includes('idempotency_key')) {
      return { rows: [row] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    throw new Error(`UNKNOWN_SQL: ${sql}`);
  }
}

function input(overrides: Partial<AppendTokenCostRecordInput> = {}): AppendTokenCostRecordInput {
  return {
    tenant_id: TENANT,
    record_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    idempotency_key: 'provider-call-1',
    run_id: 'run-1',
    correlation_id: 'corr-1',
    model: 'model-1',
    provider: 'provider-1',
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    estimated_cost_amount: '0.25',
    currency: 'USD',
    cost_status: 'RECORDED',
    provenance: { source: 'provider' },
    recorded_at: RECORDED_AT.toISOString(),
    ...overrides,
  };
}

describe('P5AutonomyRepository token costs', () => {
  it('returns the first row on an idempotent retry instead of double-counting', async () => {
    const client = new ScriptedClient();
    const repository = new P5AutonomyRepository(async (_tenant, work) => work(client as unknown as PoolClient));

    const first = await repository.appendTokenCost(input());
    const second = await repository.appendTokenCost(input({ record_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }));

    expect(second).toEqual(first);
    expect(client.queries.some((sql) => sql.includes('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING'))).toBe(true);
  });
});

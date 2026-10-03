import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { AppendTokenCostRecordInput } from './p5-autonomy.js';
import { P5AutonomyRepository } from './p5-autonomy.js';

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

describe('P5AutonomyRepository promotion compare-and-set', () => {
  it('surfaces a stale expected_revision as P5_AUTONOMY_REVISION_CONFLICT', async () => {
    const client = {
      async query() {
        // A policy write guarded by `expected_revision` that matches no row: the revision moved.
        return { rows: [], rowCount: 0 };
      },
    };
    const repository = new P5AutonomyRepository(async (_tenant, work) => work(client as unknown as PoolClient));

    await expect(repository.commitPolicy({
      tenant_id: TENANT,
      skill_id: 'skill.mkt.generate_content',
      policy_version: 'v1',
      policy_id: 'policy-1',
      state: 'PROMOTED',
      previous_approved_state: 'MINIMUM',
      evidence_window_ref: 'run_stage_results:tenant-1:skill.mkt.generate_content:30d',
      approver_id: 'operator-b',
      reason: 'Promotion approved by operator-b.',
      parameters: { required_authority: 'AUTH-2' },
      provenance: { source: 'SERVER_POLICY' },
      effective_at: RECORDED_AT.toISOString(),
      rollback_policy_version: 'v1',
      rollback_state: 'MINIMUM',
      audit_ref: null,
      evidence_ref: null,
      expected_revision: 3,
    })).rejects.toThrow('P5_AUTONOMY_REVISION_CONFLICT');
  });
});

describe('P5AutonomyRepository promotion audit evidence', () => {
  it.each([
    { scenario: 'a completed step with its audit row', observations: 7, audit_gaps: 0, audit_complete: true },
    { scenario: 'an executed step with an effect-key-bound policy audit row', observations: 7, audit_gaps: 0, audit_complete: true },
    { scenario: 'a draft parked before execution without a reservation', observations: 3, audit_gaps: 0, audit_complete: true },
    { scenario: 'an executed step missing its audit row', observations: 7, audit_gaps: 1, audit_complete: false },
    { scenario: 'an executed step with only a different step audit', observations: 7, audit_gaps: 1, audit_complete: false },
    { scenario: 'an empty evidence window', observations: 0, audit_gaps: 0, audit_complete: false },
  ])('derives audit completeness for $scenario from the ledger aggregate', async ({
    observations,
    audit_gaps,
    audit_complete,
  }) => {
    const query = vi.fn<[sql: string, values?: readonly unknown[]], Promise<QueryResult>>().mockResolvedValue({
      command: 'SELECT',
      oid: 0,
      fields: [],
      rowCount: 1,
      rows: [{
        observations,
        audit_gaps,
        evidence_gaps: 0,
        authority_violations: 0,
        duplicate_effects: 0,
        latency_p95_ms: observations === 0 ? null : 10,
        cost_amount: '0',
        cost_currency: null,
      }],
    });
    // Client is never connected: only its typed pg surface is used by the injected transaction.
    const client = Object.assign(new Client(), { query, release: vi.fn() });
    const repository = new P5AutonomyRepository(async (_tenant, work) => work(client));

    const evidence = await repository.readPromotionEvidence(TENANT, 'skill.mkt.generate_content');

    expect(evidence.audit_complete).toBe(audit_complete);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AS audit_gaps'),
      [TENANT, 'skill.mkt.generate_content', expect.any(String)],
    );
    // Real terminal audit action JSON carries step_index (1-based). Policy action JSON carries
    // effect_key but no step_index; immutable evidence has run/step/effect columns and
    // raw_payload.action.skill_id. PLAN and parked ACTION/APPROVAL rows are not executions.
    const sql: string | undefined = query.mock.calls[0]?.[0];
    expect(sql).toContain('AND r.skill_id IS NOT NULL');
    expect(sql).toContain("AND r.stage = 'EXECUTION'");
    expect(sql).toContain('AND NOT EXISTS (');
    expect(sql).toContain('SELECT 1 FROM agentos.audit_records a');
    expect(sql).toContain('a.tenant_id = r.tenant_id AND a.run_id = r.run_id AND a.skill = r.skill_id');
    expect(sql).toContain("a.action->>'step_index' = r.step_index::text");
    expect(sql).toContain(`OR (
              a.action->>'step_index' IS NULL
              AND EXISTS (
                SELECT 1 FROM agentos.evidence_records e
                WHERE e.tenant_id = r.tenant_id AND e.run_id = r.run_id AND e.step_index = r.step_index
                  AND e.raw_payload#>>'{action,skill_id}' = r.skill_id
                  AND e.effect_key = a.action->>'effect_key'
              )
            )`);
    // Immutable evidence alone is never audit evidence; a wrong explicit step cannot use the fallback.
    expect(sql).not.toContain("r.step_index = 0 OR");
    expect(sql).not.toContain("detail->>'audit_ref'");
  });
});


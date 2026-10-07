import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  ProviderCallLedgerRepository,
  RunStageEventsRepository,
  type AppendProviderCallInput,
  type AppendRunStageEventInput,
} from './run-stage-events.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = 'run-trace-0001';
const ENTERED_AT = new Date('2026-09-28T10:00:00.000Z');
const RECORDED_AT = new Date('2026-09-28T10:00:01.000Z');

type IssuedStatement = { readonly sql: string; readonly params: readonly unknown[] };

interface StageRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  attempt_ordinal: number;
  step_index: number;
  stage: 'SIGNAL' | 'CONTEXT' | 'HYPOTHESIS' | 'DECISION' | 'PLAN' | 'ACTION' | 'APPROVAL' | 'EXECUTION' | 'EVIDENCE' | 'OUTCOME' | 'LEARNING';
  detail: unknown;
  evidence_refs: unknown;
  entered_at: Date;
}

interface ProviderRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  step_index: number;
  stage: StageRow['stage'];
  call_index: number;
  provider: string;
  model: string;
  observed_status: string;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  estimated_cost_amount: string | null;
  currency: string | null;
  cost_status: string | null;
  recorded_at: Date;
}

class ScriptedClient {
  readonly statements: IssuedStatement[] = [];
  stage: StageRow | null = null;
  provider: ProviderRow | null = null;
  attemptOrdinal = 0;

  async query<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push({ sql, params });

    if (sql.includes('FROM agentos.platform_durable_tasks') && sql.includes('FOR UPDATE')) {
      return { rows: [{ task_id: 'task-1' }] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.includes('agentos.run_attempt_ordinals')) {
      this.attemptOrdinal += 1;
      return {
        rows: [{ attempt_ordinal: this.attemptOrdinal }] as unknown as R[],
        rowCount: 1,
      } as unknown as QueryResult<R>;
    }

    if (sql.startsWith('INSERT INTO agentos.run_stage_events')) {
      if (this.stage !== null) return { rows: [], rowCount: 0 } as unknown as QueryResult<R>;
      this.stage = {
        tenant_id: String(params[0]),
        run_id: String(params[1]),
        attempt_ordinal: Number(params[2]),
        step_index: Number(params[3]),
        stage: params[4] as StageRow['stage'],
        detail: JSON.parse(String(params[5])),
        evidence_refs: JSON.parse(String(params[6])),
        entered_at: ENTERED_AT,
      };
      return { rows: [this.stage] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.startsWith('INSERT INTO agentos.provider_call_ledger')) {
      if (this.provider !== null) return { rows: [], rowCount: 0 } as unknown as QueryResult<R>;
      this.provider = {
        tenant_id: String(params[0]),
        run_id: String(params[1]),
        step_index: Number(params[2]),
        stage: params[3] as StageRow['stage'],
        call_index: Number(params[4]),
        provider: String(params[5]),
        model: String(params[6]),
        observed_status: String(params[7]),
        latency_ms: params[8] === null ? null : Number(params[8]),
        prompt_tokens: params[9] === null ? null : Number(params[9]),
        completion_tokens: params[10] === null ? null : Number(params[10]),
        cached_tokens: params[11] === null ? null : Number(params[11]),
        estimated_cost_amount: params[12] === null ? null : Number(params[12]).toFixed(8),
        currency: params[13] === null ? null : String(params[13]),
        cost_status: params[14] === null ? null : String(params[14]),
        recorded_at: RECORDED_AT,
      };
      return { rows: [this.provider] as unknown as R[], rowCount: 1 } as unknown as QueryResult<R>;
    }

    if (sql.includes('FROM agentos.run_stage_events')) {
      const matchesTenant = params[0] === TENANT;
      const rows = matchesTenant && this.stage !== null ? [this.stage] : [];
      return { rows: rows as unknown as R[], rowCount: rows.length } as QueryResult<R>;
    }

    if (sql.includes('FROM agentos.provider_call_ledger')) {
      const matchesTenant = params[0] === TENANT;
      const rows = matchesTenant && this.provider !== null ? [this.provider] : [];
      return { rows: rows as unknown as R[], rowCount: rows.length } as QueryResult<R>;
    }

    throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: ${sql}`);
  }
}

function harness(): {
  readonly repository: RunStageEventsRepository;
  readonly providerRepository: ProviderCallLedgerRepository;
  readonly client: ScriptedClient;
  readonly boundTenants: string[];
} {
  const client = new ScriptedClient();
  const boundTenants: string[] = [];
  const runner = async <T>(tenant_id: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
    boundTenants.push(tenant_id);
    return work(client as unknown as PoolClient);
  };
  return {
    repository: new RunStageEventsRepository(runner),
    providerRepository: new ProviderCallLedgerRepository(runner),
    client,
    boundTenants,
  };
}


function stageInput(overrides: Partial<AppendRunStageEventInput> = {}): AppendRunStageEventInput {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    attempt_ordinal: 1,
    step_index: 0,
    stage: 'CONTEXT',
    detail: { source: 'server' },
    evidence_refs: [{ evidence_id: 'ev-1' }],
    entered_at: ENTERED_AT.toISOString(),
    ...overrides,
  };
}

function providerInput(overrides: Partial<AppendProviderCallInput> = {}): AppendProviderCallInput {
  return {
    tenant_id: TENANT,
    run_id: RUN_ID,
    step_index: 1,
    stage: 'HYPOTHESIS',
    call_index: 0,
    provider: 'openai-compatible',
    model: 'demo-model',
    observed_status: 'LLM_INVALID_RESPONSE',
    latency_ms: 42,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    estimated_cost_amount: null,
    currency: null,
    cost_status: 'UNAVAILABLE',
    recorded_at: RECORDED_AT.toISOString(),
    ...overrides,
  };
}

describe('RunStageEventsRepository', () => {
  it('replays an identical stage event and refuses a conflicting replay', async () => {
    const { repository, client } = harness();

    const first = await repository.appendStageEvent(stageInput());
    const replay = await repository.appendStageEvent(stageInput());

    expect(replay).toEqual(first);
    expect(client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.run_stage_events'))).toHaveLength(2);
    await expect(
      repository.appendStageEvent(stageInput({ detail: { source: 'tampered' } })),
    ).rejects.toThrow('RUN_STAGE_EVENT_CONFLICT');
  });

  it('replays provider observations without inventing success or cost data', async () => {
    const { providerRepository, client } = harness();

    const first = await providerRepository.appendProviderCall(providerInput());
    const replay = await providerRepository.appendProviderCall(providerInput());

    expect(replay).toEqual(first);
    expect(first.observed_status).toBe('LLM_INVALID_RESPONSE');
    expect(first.prompt_tokens).toBeNull();
    expect(first.estimated_cost_amount).toBeNull();
    await expect(
      providerRepository.appendProviderCall(providerInput({ observed_status: 'SUCCESS' })),
    ).rejects.toThrow('PROVIDER_CALL_CONFLICT');
    expect(client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.provider_call_ledger'))).toHaveLength(3);
  });

  it('treats numerically equivalent NUMERIC lexical forms as an identical replay', async () => {
    const { providerRepository } = harness();

    const first = await providerRepository.appendProviderCall(
      providerInput({ estimated_cost_amount: '10.0', currency: 'USD', cost_status: 'OBSERVED' }),
    );
    expect(first.estimated_cost_amount).toBe('10.00000000');
    await expect(
      providerRepository.appendProviderCall(
        providerInput({ estimated_cost_amount: 10, currency: 'USD', cost_status: 'OBSERVED' }),
      ),
    ).resolves.toEqual(first);
  });

  it('allocates unique ordinals for concurrent starts through the durable cursor', async () => {
    const { repository, client } = harness();

    const ordinals = await Promise.all([
      repository.nextAttemptOrdinal(TENANT, RUN_ID),
      repository.nextAttemptOrdinal(TENANT, RUN_ID),
    ]);

    expect(ordinals.sort((left, right) => left - right)).toEqual([1, 2]);
    expect(client.statements.some(({ sql }) => sql.includes('agentos.run_attempt_ordinals'))).toBe(true);
  });

  it('binds reads to the requested tenant and does not expose another tenant rows', async () => {
    const { repository, providerRepository, boundTenants } = harness();

    expect(await repository.listStageEvents(OTHER_TENANT, RUN_ID)).toEqual([]);
    expect(await providerRepository.listProviderCalls(OTHER_TENANT, RUN_ID)).toEqual([]);
    expect(boundTenants).toEqual([OTHER_TENANT, OTHER_TENANT]);
  });
});

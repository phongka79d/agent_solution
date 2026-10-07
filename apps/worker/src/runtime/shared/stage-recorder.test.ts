import { describe, expect, it } from 'vitest';
import {
  RunStageEventsRepository,
  type TenantTransactionRunner,
} from '@agentos/database';

import { RunStageRecorderAdapter } from './stage-recorder.js';

/**
 * Minimal structural stand-ins for the `pg` types. The worker never depends on `pg` at runtime —
 * `@agentos/database` owns that driver — so this fake stays dependency-free while still matching
 * the repository's client surface.
 */
interface QueryResultRow {
  readonly [column: string]: unknown;
}
interface QueryResult<R extends QueryResultRow = QueryResultRow> {
  readonly rows: R[];
  readonly rowCount: number | null;
}
/** The client type the durable repositories receive, derived so this fake needs no driver import. */
type TenantClient = Parameters<TenantTransactionRunner>[1] extends (client: infer C) => unknown ? C : never;

const TENANT = '11111111-1111-4111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-2222-222222222222';
const RUN_ID = 'run-stage-recorder-1';
const ENTERED_AT = new Date('2026-09-28T10:00:00.000Z');

type Stage = 'SIGNAL' | 'CONTEXT' | 'HYPOTHESIS' | 'DECISION' | 'PLAN' | 'ACTION' | 'APPROVAL' | 'EXECUTION' | 'EVIDENCE' | 'OUTCOME' | 'LEARNING';

interface StageRow extends QueryResultRow {
  tenant_id: string;
  run_id: string;
  attempt_ordinal: number;
  step_index: number;
  stage: Stage;
  detail: unknown;
  evidence_refs: unknown;
  entered_at: Date;
}

class ScriptedStageClient {
  readonly statements: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  readonly rows: StageRow[] = [];
  readonly attemptOrdinals: Record<string, number> = {};

  async query<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push({ sql, params });

    if (sql.includes('FROM agentos.platform_durable_tasks') && sql.includes('FOR UPDATE')) {
      return { rows: [{ task_id: 'task-1' }] as unknown as R[], rowCount: 1 } as QueryResult<R>;
    }

    if (sql.includes('agentos.run_attempt_ordinals')) {
      const key = `${String(params[0])}:${String(params[1])}`;
      const attemptOrdinal = (this.attemptOrdinals[key] ?? 0) + 1;
      this.attemptOrdinals[key] = attemptOrdinal;
      return { rows: [{ attempt_ordinal: attemptOrdinal }] as unknown as R[], rowCount: 1 } as QueryResult<R>;
    }

    // Keep the legacy branch for tests that resolve the workspace package's pre-build dist output.
    if (sql.includes('COALESCE(MAX(attempt_ordinal)')) {
      const matching = this.rows.filter((row) => row.tenant_id === params[0] && row.run_id === params[1]);
      const max = matching.reduce((value, row) => Math.max(value, row.attempt_ordinal), 0);
      return { rows: [{ attempt_ordinal: max + 1 }] as unknown as R[], rowCount: 1 } as QueryResult<R>;
    }
    if (sql.startsWith('INSERT INTO agentos.run_stage_events')) {
      const existing = this.rows.find((row) => (
        row.tenant_id === params[0]
        && row.run_id === params[1]
        && row.attempt_ordinal === Number(params[2])
        && row.step_index === Number(params[3])
        && row.stage === params[4]
      ));
      if (existing !== undefined) {
        return { rows: [], rowCount: 0 } as QueryResult<R>;
      }
      const row: StageRow = {
        tenant_id: String(params[0]),
        run_id: String(params[1]),
        attempt_ordinal: Number(params[2]),
        step_index: Number(params[3]),
        stage: params[4] as Stage,
        detail: JSON.parse(String(params[5])),
        evidence_refs: JSON.parse(String(params[6])),
        entered_at: new Date(String(params[7])),
      };
      this.rows.push(row);
      return { rows: [row] as unknown as R[], rowCount: 1 } as QueryResult<R>;
    }

    if (sql.includes('FROM agentos.run_stage_events')) {
      const row = this.rows.find((candidate) => (
        candidate.tenant_id === params[0]
        && candidate.run_id === params[1]
        && candidate.attempt_ordinal === Number(params[2])
        && candidate.step_index === Number(params[3])
        && candidate.stage === params[4]
      ));
      return { rows: row === undefined ? [] : [row] as unknown as R[], rowCount: row === undefined ? 0 : 1 } as QueryResult<R>;
    }

    throw new Error(`UNEXPECTED_STAGE_SQL: ${sql}`);
  }
}

function createRecorder(): {
  readonly recorder: RunStageRecorderAdapter;
  readonly client: ScriptedStageClient;
  readonly boundTenants: string[];
} {
  const client = new ScriptedStageClient();
  const boundTenants: string[] = [];
  const runInTenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
    boundTenants.push(tenant_id);
    return work(client as unknown as TenantClient);
  };
  const repository = new RunStageEventsRepository(runInTenantTransaction);
  return {
    recorder: new RunStageRecorderAdapter(repository),
    client,
    boundTenants,
  };
}

describe('RunStageRecorderAdapter', () => {
  it('allocates attempts and appends replay-safe stages through tenant-scoped repository calls', async () => {
    const { recorder, client, boundTenants } = createRecorder();

    expect(await recorder.nextAttemptOrdinal(TENANT, RUN_ID)).toBe(1);
    await recorder.append({
      tenant_id: TENANT,
      run_id: RUN_ID,
      attempt_ordinal: 1,
      step_index: 0,
      stage: 'CONTEXT',
      entered_at: ENTERED_AT.toISOString(),
      detail: { source: 'context-aggregator' },
      evidence_refs: [{ evidence_id: 'evidence-context-1' }],
    });

    expect(await recorder.nextAttemptOrdinal(TENANT, RUN_ID)).toBe(2);
    await recorder.append({
      tenant_id: TENANT,
      run_id: RUN_ID,
      attempt_ordinal: 2,
      step_index: 1,
      stage: 'HYPOTHESIS',
      entered_at: ENTERED_AT.toISOString(),
      detail: { classification: 'HYPOTHESIS', intent: 'sales:search' },
      evidence_refs: [{ evidence_id: 'evidence-hypothesis-1' }],
    });
    await recorder.append({
      tenant_id: TENANT,
      run_id: RUN_ID,
      attempt_ordinal: 1,
      step_index: 0,
      stage: 'CONTEXT',
      entered_at: ENTERED_AT.toISOString(),
      detail: { source: 'context-aggregator' },
      evidence_refs: [{ evidence_id: 'evidence-context-1' }],
    });

    expect(client.rows).toHaveLength(2);
    expect(client.rows[0]).toMatchObject({
      tenant_id: TENANT,
      run_id: RUN_ID,
      stage: 'CONTEXT',
      detail: { source: 'context-aggregator' },
    });
    expect(boundTenants).toEqual([TENANT, TENANT, TENANT, TENANT, TENANT]);
    expect(client.statements.filter(({ sql }) => sql.startsWith('INSERT INTO agentos.run_stage_events'))).toHaveLength(3);

    expect(await recorder.nextAttemptOrdinal(OTHER_TENANT, RUN_ID)).toBe(1);
    expect(boundTenants.at(-1)).toBe(OTHER_TENANT);
  });
});

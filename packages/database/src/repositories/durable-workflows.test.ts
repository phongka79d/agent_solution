import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { DurableWorkflowRepository } from './durable-workflows.js';
import type {
  CreateDurableTaskInput,
  DurableTaskGuard,
  DurableTaskListInput,
  DurableTaskPage,
  DurableTaskRecord,
  DurableTaskState,
  RecordTaskFailureInput,
  RequeueFailedTaskInput,
} from './durable-workflows.js';

/**
 * Unit suite for durable workflow state (INT-FR-ORC-OPTIMISTIC-CAS, implement/04 §4.1-§4.4).
 *
 * The repository is exercised against a scripted `pg` client: every statement it issues is
 * classified, recorded, and answered from a per-transition script, so the `task_version`
 * compare-and-increment, the checkpoint rules and the fail-closed refusals are asserted as the
 * SQL-observable behavior the durable row actually shows — without a database and without
 * re-implementing the guards inside the test.
 *
 * What is asserted is what a caller observes: which statement a write takes (merge, replace, state
 * only, re-queue, operator requeue, terminal), which version it restates as the CAS base and which
 * version it publishes back, that a stale writer is refused instead of overwriting a newer
 * checkpoint, how the paged read is seeked, filtered and resumed, and that `UNKNOWN` and an
 * incomplete checkpoint never reach the row. The live half (RLS denial, enums, CHECK constraints)
 * belongs to `src/rls.test.ts` and is not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = 'RUN-1';
const SECOND_RUN_ID = 'RUN-2';
const CORRELATION_ID = 'CORR-1';
const AGENT_ID = 'agent-revenue';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-01-01T00:01:00.000Z');
const LEASE_EXPIRES_AT = new Date('2026-01-01T00:01:30.000Z');

/** Two neighbouring creation instants, so a page has a newest and a next key to resume from. */
const LATER_CREATED_AT = new Date('2026-01-01T00:02:00.000Z');
const EARLIER_CREATED_AT = new Date('2025-12-31T23:00:00.000Z');

/** An inclusive creation window, as the R16 read model accepts it. */
const LIST_FROM = '2025-12-01T00:00:00.000Z';
const LIST_TO = '2026-02-01T00:00:00.000Z';

/** Bare lowercase hex SHA-256 chain cursors: the genesis digest and a predecessor record. */
const GENESIS_HASH = '0'.repeat(64);
const EVIDENCE_HASH = 'feedface'.repeat(8);

/** One task row exactly as `pg` returns it, before the projection is published. */
interface TaskRow extends QueryResultRow {
  task_id: string;
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  current_step: number;
  state: DurableTaskState;
  task_version: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  retry_count: number;
  max_retries: number;
  last_error_class: 'RETRYABLE' | 'FATAL' | null;
  paused_for_approval_id: string | null;
  state_payload: unknown;
  error_details: unknown;
  created_at: Date;
  updated_at: Date;
}

/**
 * Which statement of the repository a SQL text is: the write discipline of §4.2 is a choice among
 * these, so a test names the transition instead of matching whole statements. An unrecognized
 * statement fails the test rather than being answered with an empty result.
 */
type StatementKind =
  | 'insert'
  | 'lock'
  | 'read'
  | 'list'
  | 'progress'
  | 'state'
  | 'park'
  | 'state_progress'
  | 'requeue'
  | 'operator_requeue'
  | 'fail';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.platform_durable_tasks')) {
    return 'insert';
  }

  // The paged read is the only statement correlated to a second relation, so it is named by its
  // aliased FROM before the plain read below claims every other SELECT.
  if (sql.includes('FROM agentos.platform_durable_tasks AS t')) {
    return 'list';
  }

  if (sql.includes('FOR UPDATE')) {
    return 'lock';
  }

  if (sql.startsWith('SELECT')) {
    return 'read';
  }

  if (sql.includes('retry_count = retry_count + 1')) {
    return 'requeue';
  }

  if (sql.includes('last_error_class = NULL')) {
    return 'operator_requeue';
  }

  if (sql.includes("SET state = 'failed'")) {
    return 'fail';
  }

  if (sql.includes('SET current_step = $3')) {
    return 'progress';
  }

  if (sql.includes('state_payload = state_payload || $4::jsonb')) {
    return 'state_progress';
  }

  if (sql.includes('state_payload = $4::jsonb')) {
    return 'park';
  }

  if (sql.includes('SET state = $3::agentos.task_lifecycle_state')) {
    return 'state';
  }

  throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: no test scripts the statement "${sql}".`);
}

/** The `pg` result of one statement, as a test scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` / `UPDATE ... RETURNING` returns. */
  readonly rows?: readonly TaskRow[];
  /** `rowCount` of an `UPDATE`; omitted means the number of scripted rows. */
  readonly rowCount?: number | null;
  /** Error `pg` raises for this statement instead of a result. */
  readonly fails?: unknown;
}

type ScriptedAnswers = Partial<
  Record<StatementKind, ScriptedAnswer | ((params: readonly unknown[]) => ScriptedAnswer)>
>;

/** One statement the repository issued, with the parameters `pg` would have received. */
interface IssuedStatement {
  readonly kind: StatementKind;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Deterministic stand-in for the `pg` client of one tenant transaction: records every statement and
 * answers it from the script.
 */
class ScriptedClient {
  readonly statements: IssuedStatement[] = [];

  private readonly answers: ScriptedAnswers;

  constructor(answers: ScriptedAnswers) {
    this.answers = answers;
  }

  async query<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const kind = classify(sql);
    this.statements.push({ kind, sql, params });

    const scripted = this.answers[kind];

    if (scripted === undefined) {
      throw new Error(`SCRIPTED_ANSWER_MISSING: no scripted answer for a ${kind} statement.`);
    }

    const answer = typeof scripted === 'function' ? scripted(params) : scripted;

    if (answer.fails !== undefined) {
      throw answer.fails;
    }

    const rows = (answer.rows ?? []) as unknown as R[];

    return {
      rows,
      rowCount: answer.rowCount === undefined ? rows.length : answer.rowCount,
    } as QueryResult<R>;
  }
}

/** One repository wired to its scripted client and to the tenants its transactions were bound to. */
interface RepositoryHarness {
  readonly repository: DurableWorkflowRepository;
  readonly client: ScriptedClient;
  /** Tenants passed to the injected binder, in call order. */
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];

  const repository = new DurableWorkflowRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  });

  return { repository, client, boundTenants };
}

/** One row carrying the canonical defaults of a fresh task; a case overrides what it is about. */
function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const row: TaskRow = {
    task_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    tenant_id: TENANT,
    run_id: RUN_ID,
    correlation_id: CORRELATION_ID,
    current_step: 1,
    state: 'queued',
    task_version: 1,
    lease_owner: null,
    lease_expires_at: null,
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    paused_for_approval_id: null,
    state_payload: {},
    error_details: {},
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  };

  return Object.assign(row, overrides);
}

/** A complete `DurableTaskCheckpoint` (`durable-workflows.ts` `CHECKPOINT_MEMBERS`). */
function completeCheckpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const checkpoint: Record<string, unknown> = {
    plan: { steps: [{ step: 1, skill: 'skill.echo' }] },
    current_step: 2,
    pending_action: { action_id: 'action-1', effect_key: 'EK-1' },
    context: { customer_id: 'customer-1' },
    previous_evidence_hash: EVIDENCE_HASH,
    request_id: 'REQ-1',
  };

  return Object.assign(checkpoint, overrides);
}

function createInput(overrides: Partial<CreateDurableTaskInput> = {}): CreateDurableTaskInput {
  const input: CreateDurableTaskInput = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    correlation_id: CORRELATION_ID,
  };

  return Object.assign(input, overrides);
}

function guardFor(overrides: Partial<DurableTaskGuard> = {}): DurableTaskGuard {
  const guard: DurableTaskGuard = { expected_task_version: 1 };

  return Object.assign(guard, overrides);
}

function failureInput(overrides: Partial<RecordTaskFailureInput> = {}): RecordTaskFailureInput {
  const input: RecordTaskFailureInput = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    error_class: 'RETRYABLE',
    error_details: { code: 'DISPATCH_TIMEOUT' },
  };

  return Object.assign(input, overrides);
}

function listQuery(overrides: Partial<DurableTaskListInput> = {}): DurableTaskListInput {
  const input: DurableTaskListInput = { tenant_id: TENANT };

  return Object.assign(input, overrides);
}

function requeueInput(overrides: Partial<RequeueFailedTaskInput> = {}): RequeueFailedTaskInput {
  const input: RequeueFailedTaskInput = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    reason: 'provider incident resolved',
  };

  return Object.assign(input, overrides);
}

/** The single statement of `kind` the repository issued; fails the test when it was never issued. */
function statementOf(client: ScriptedClient, kind: StatementKind): IssuedStatement {
  const statement = client.statements.find((candidate) => candidate.kind === kind);

  if (statement === undefined) {
    throw new Error(`SCRIPTED_STATEMENT_MISSING: no ${kind} statement was issued.`);
  }

  return statement;
}

/** The parameters bound to the single statement of `kind`; fails the test when it was never issued. */
function bindingsOf(client: ScriptedClient, kind: StatementKind): readonly unknown[] {
  return statementOf(client, kind).params;
}

/** The message of the error `work` failed with; fails the test when it did not fail. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('EXPECTED_REFUSAL: the call succeeded, but the durable rule must refuse it.');
}

describe('DurableWorkflowRepository.createTask', () => {
  it('creates the task with the durable defaults and binds the opening step and budget', async () => {
    const { repository, client, boundTenants } = harnessFor({ insert: { rows: [taskRow()] } });

    const record = await repository.createTask(createInput());

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['insert']);
    expect(bindingsOf(client, 'insert')).toEqual([
      TENANT,
      RUN_ID,
      CORRELATION_ID,
      1,
      'queued',
      3,
      '{}',
    ]);
    expect(record.task_version).toBe(1);
    expect(record.state).toBe('queued');
    expect(record.lease_expires_at).toBeNull();
    expect(record.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('requires a complete checkpoint when the task opens parked', async () => {
    const checkpoint = completeCheckpoint();
    const parked = harnessFor({
      insert: { rows: [taskRow({ state: 'waiting', state_payload: checkpoint })] },
    });
    const empty = harnessFor({});

    await expect(
      parked.repository.createTask(createInput({ state: 'waiting', state_payload: checkpoint })),
    ).resolves.toMatchObject({ state: 'waiting' });
    expect(bindingsOf(parked.client, 'insert')[6]).toBe(JSON.stringify(checkpoint));

    for (const partial of [undefined, { plan: {}, current_step: 2 }, completeCheckpoint({ request_id: '' })]) {
      await expect(
        empty.repository.createTask(createInput({ state: 'waiting', state_payload: partial })),
        JSON.stringify(partial),
      ).rejects.toThrow('CHECKPOINT_INCOMPLETE');
    }

    await expect(empty.repository.createTask(createInput({ state: 'awaiting_human' }))).rejects.toThrow(
      'CHECKPOINT_INCOMPLETE',
    );
    expect(empty.boundTenants).toEqual([]);
  });

  it('refuses a state outside the closed lifecycle, including UNKNOWN', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    for (const state of ['UNKNOWN', 'resuming', '']) {
      await expect(
        repository.createTask(createInput({ state: state as DurableTaskState })),
      ).rejects.toThrow('TASK_STATE_INVALID');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('validates the durable identifiers and column values before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const cases: readonly { readonly input: CreateDurableTaskInput; readonly code: string }[] = [
      { input: createInput({ tenant_id: '  ' }), code: 'TASK_TENANT_ID_REQUIRED' },
      { input: createInput({ run_id: 'R'.repeat(65) }), code: 'TASK_RUN_ID_REQUIRED' },
      { input: createInput({ correlation_id: '' }), code: 'TASK_CORRELATION_ID_REQUIRED' },
      { input: createInput({ current_step: 0 }), code: 'TASK_CURRENT_STEP_INVALID' },
      { input: createInput({ max_retries: -1 }), code: 'TASK_MAX_RETRIES_INVALID' },
    ];

    for (const { input, code } of cases) {
      await expect(repository.createTask(input), code).rejects.toThrow(code);
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses a second task for the same run instead of merging it', async () => {
    const { repository } = harnessFor({
      insert: {
        fails: Object.assign(
          new Error('duplicate key value violates unique constraint "uq_platform_tasks_run"'),
          { code: '23505' },
        ),
      },
    });

    await expect(repository.createTask(createInput())).rejects.toThrow('DURABLE_TASK_EXISTS');
  });
});

describe('DurableWorkflowRepository.getTask', () => {
  it('publishes the stored row with ISO-8601 timestamps and the lease it holds', async () => {
    const { repository, client, boundTenants } = harnessFor({
      read: {
        rows: [
          taskRow({
            state: 'running',
            current_step: 4,
            task_version: 7,
            lease_owner: 'worker-1',
            lease_expires_at: LEASE_EXPIRES_AT,
            retry_count: 1,
            last_error_class: 'RETRYABLE',
            state_payload: { cursor: 'step-4' },
            updated_at: UPDATED_AT,
          }),
        ],
      },
    });

    const record: DurableTaskRecord | null = await repository.getTask(TENANT, RUN_ID);

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['read']);
    expect(bindingsOf(client, 'read')).toEqual([TENANT, RUN_ID]);
    expect(record).toEqual({
      task_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      tenant_id: TENANT,
      run_id: RUN_ID,
      correlation_id: CORRELATION_ID,
      current_step: 4,
      state: 'running',
      task_version: 7,
      lease_owner: 'worker-1',
      lease_expires_at: '2026-01-01T00:01:30.000Z',
      retry_count: 1,
      max_retries: 3,
      last_error_class: 'RETRYABLE',
      paused_for_approval_id: null,
      state_payload: { cursor: 'step-4' },
      error_details: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
    });
  });

  it('reports null when this tenant holds no task for the run', async () => {
    const { repository } = harnessFor({ read: { rows: [] } });

    await expect(repository.getTask(TENANT, RUN_ID)).resolves.toBeNull();
  });
});

describe('DurableWorkflowRepository.listTasks', () => {
  it('reads the newest page with one row more than requested and publishes the cursor of its last item', async () => {
    const { repository, client, boundTenants } = harnessFor({
      list: {
        rows: [
          taskRow({ run_id: SECOND_RUN_ID, created_at: LATER_CREATED_AT, state: 'failed' }),
          taskRow({ run_id: RUN_ID, state: 'running', task_version: 4 }),
          taskRow({ run_id: 'RUN-0', created_at: EARLIER_CREATED_AT }),
        ],
      },
    });

    const page: DurableTaskPage = await repository.listTasks(listQuery({ limit: 2 }));

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['list']);
    // No filter was named, so each one binds SQL NULL and the page is read one row past its size.
    expect(bindingsOf(client, 'list')).toEqual([TENANT, null, null, null, null, null, null, 3]);
    expect(page.items.map((item) => item.run_id)).toEqual([SECOND_RUN_ID, RUN_ID]);
    // The items are the same published row `getTask()` returns, timestamps included.
    expect(page.items[0]).toMatchObject({
      run_id: SECOND_RUN_ID,
      state: 'failed',
      created_at: LATER_CREATED_AT.toISOString(),
      updated_at: UPDATED_AT.toISOString(),
    });
    expect(page.next_cursor).toBe(`${CREATED_AT.toISOString()}|${RUN_ID}`);
  });

  it('ends the page without a cursor when the tenant has no further task, and pages 50 by default', async () => {
    const { repository, client } = harnessFor({
      list: { rows: [taskRow({ run_id: SECOND_RUN_ID, created_at: LATER_CREATED_AT })] },
    });

    const page = await repository.listTasks(listQuery());

    expect(page.items.map((item) => item.run_id)).toEqual([SECOND_RUN_ID]);
    expect(page.next_cursor).toBeNull();
    expect(bindingsOf(client, 'list')[7]).toBe(51);
  });

  it('binds the state, window and agent filters and resumes strictly after the cursor key', async () => {
    const cursor = `${CREATED_AT.toISOString()}|${RUN_ID}`;
    const { repository, client } = harnessFor({ list: { rows: [] } });

    await expect(
      repository.listTasks(
        listQuery({ state: 'failed', agent_id: AGENT_ID, from: LIST_FROM, to: LIST_TO, cursor }),
      ),
    ).resolves.toEqual({ items: [], next_cursor: null });

    expect(bindingsOf(client, 'list')).toEqual([
      TENANT,
      'failed',
      LIST_FROM,
      LIST_TO,
      AGENT_ID,
      CREATED_AT.toISOString(),
      RUN_ID,
      51,
    ]);
  });

  it('filters the page through the step ledger of the agent, scoped to the task tenant and run', async () => {
    const { repository, client } = harnessFor({ list: { rows: [] } });

    await repository.listTasks(listQuery({ agent_id: AGENT_ID }));

    const { sql } = statementOf(client, 'list');

    // `agent_run_logs` has no column on the task row: the agent is bound by an EXISTS correlated to
    // the row being paged by tenant and run, so no other tenant's ledger row can make a task visible.
    expect(sql).toContain('FROM agentos.agent_run_logs AS log');
    expect(sql).toContain('log.tenant_id = t.tenant_id');
    expect(sql).toContain('log.run_id = t.run_id');
    expect(sql).toContain('log.agent_id = $5::varchar');
    // Newest first, keyset on the durable key of the page.
    expect(sql).toContain('ORDER BY t.created_at DESC, t.run_id DESC');
    expect(sql).toContain('(t.created_at, t.run_id) < ($6::timestamptz, $7::varchar)');
  });

  it('reads the page of the tenant its transaction was bound to', async () => {
    const { repository, client, boundTenants } = harnessFor({ list: { rows: [] } });

    await repository.listTasks(listQuery({ tenant_id: OTHER_TENANT }));

    expect(boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(client, 'list')[0]).toBe(OTHER_TENANT);
  });

  it('refuses a filter, a page size or a cursor it did not publish, before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const filters: readonly { readonly input: DurableTaskListInput; readonly code: string }[] = [
      { input: listQuery({ state: 'UNKNOWN' as DurableTaskState }), code: 'TASK_STATE_INVALID' },
      { input: listQuery({ agent_id: '   ' }), code: 'TASK_AGENT_ID_INVALID' },
      { input: listQuery({ agent_id: 'a'.repeat(33) }), code: 'TASK_AGENT_ID_INVALID' },
      { input: listQuery({ from: 'yesterday' }), code: 'TASK_LIST_RANGE_INVALID' },
      { input: listQuery({ to: '' }), code: 'TASK_LIST_RANGE_INVALID' },
      { input: listQuery({ limit: 0 }), code: 'TASK_LIST_LIMIT_INVALID' },
      { input: listQuery({ limit: 201 }), code: 'TASK_LIST_LIMIT_INVALID' },
      { input: listQuery({ limit: 2.5 }), code: 'TASK_LIST_LIMIT_INVALID' },
    ];
    // Cursors this module never published: a missing half, a blank or oversized run id, a run id
    // carrying the separator, and an instant that is not the canonical ISO-8601 string of the row.
    const malformed_cursors: readonly unknown[] = [
      '',
      'not-a-cursor',
      CREATED_AT.toISOString(),
      `${CREATED_AT.toISOString()}|`,
      `${CREATED_AT.toISOString()}|   `,
      `${CREATED_AT.toISOString()}|${RUN_ID}|extra`,
      `2026-01-01T00:00:00Z|${RUN_ID}`,
      `${CREATED_AT.toISOString()}|${'R'.repeat(65)}`,
    ];
    const cases = [
      ...filters,
      ...malformed_cursors.map((cursor) => ({
        input: listQuery({ cursor: cursor as string }),
        code: 'TASK_LIST_CURSOR_INVALID',
      })),
    ];

    for (const { input, code } of cases) {
      expect(
        await refusalOf(repository.listTasks(input)),
        `${code} ${JSON.stringify(input)}`,
      ).toContain(code);
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('DurableWorkflowRepository.updateTaskProgress', () => {
  it('locks the run, merges the progress blob and restates the guarded version as the CAS base', async () => {
    const payload = { cursor: 'step-5' };
    const { repository, client, boundTenants } = harnessFor({
      lock: {
        rows: [
          taskRow({
            state: 'running',
            task_version: 3,
            lease_owner: 'worker-1',
            lease_expires_at: LEASE_EXPIRES_AT,
          }),
        ],
      },
      progress: {
        rows: [
          taskRow({
            state: 'running',
            current_step: 5,
            task_version: 4,
            lease_owner: 'worker-1',
            state_payload: payload,
          }),
        ],
      },
    });

    const record = await repository.updateTaskProgress(
      TENANT,
      RUN_ID,
      5,
      payload,
      guardFor({ expected_task_version: 3, lease_owner: 'worker-1' }),
    );

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'progress']);
    expect(bindingsOf(client, 'lock')).toEqual([TENANT, RUN_ID]);
    expect(bindingsOf(client, 'progress')).toEqual([TENANT, RUN_ID, 5, JSON.stringify(payload), 3]);
    expect(record).toMatchObject({
      state: 'running',
      current_step: 5,
      task_version: 4,
      state_payload: payload,
    });
  });

  it('uses the locked version as the CAS base when the caller supplies no guard', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'queued', task_version: 4 })] },
      progress: {
        rows: [taskRow({ state: 'queued', current_step: 2, task_version: 5 })],
      },
    });

    await repository.updateTaskProgress(TENANT, RUN_ID, 2, { cursor: 'step-2' });

    expect(bindingsOf(client, 'progress')[4]).toBe(4);
  });

  it('refuses a stale writer while the row is locked, before any write is issued', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', task_version: 4, lease_owner: 'worker-1' })] },
    });

    const refusal = await refusalOf(
      repository.updateTaskProgress(
        TENANT,
        RUN_ID,
        5,
        { cursor: 'step-5' },
        guardFor({ expected_task_version: 3, lease_owner: 'worker-1' }),
      ),
    );

    expect(refusal).toContain('TASK_VERSION_CONFLICT');
    expect(refusal).toContain('task_version 4');
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('refuses a parked task: only the bound human decision may move it', async () => {
    const { repository, client } = harnessFor({
      lock: {
        rows: [taskRow({ state: 'awaiting_human', paused_for_approval_id: 'approval-1' })],
      },
    });

    const refusal = await refusalOf(
      repository.updateTaskProgress(TENANT, RUN_ID, 5, { cursor: 'step-5' }),
    );

    expect(refusal).toContain('TASK_NOT_PROGRESSABLE');
    expect(refusal).toContain('approval-1');
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('refuses a closed task, a missing task and a worker that holds no lease', async () => {
    const closed = harnessFor({ lock: { rows: [taskRow({ state: 'failed' })] } });
    const missing = harnessFor({ lock: { rows: [] } });
    const unleased = harnessFor({ lock: { rows: [taskRow({ state: 'queued' })] } });

    expect(
      await refusalOf(closed.repository.updateTaskProgress(TENANT, RUN_ID, 5, { cursor: 's' })),
    ).toContain('TASK_ALREADY_TERMINAL');
    expect(
      await refusalOf(missing.repository.updateTaskProgress(TENANT, RUN_ID, 5, { cursor: 's' })),
    ).toContain('DURABLE_TASK_NOT_FOUND');
    expect(
      await refusalOf(
        unleased.repository.updateTaskProgress(
          TENANT,
          RUN_ID,
          5,
          { cursor: 's' },
          guardFor({ lease_owner: 'worker-9' }),
        ),
      ),
    ).toContain('TASK_LEASE_NOT_HELD');

    for (const harness of [closed, missing, unleased]) {
      expect(harness.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
    }
  });

  it('validates the step, the payload shape and the JSON encoding before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const cases: readonly Promise<unknown>[] = [
      repository.updateTaskProgress(TENANT, RUN_ID, 0, { cursor: 'step-0' }),
      repository.updateTaskProgress(TENANT, RUN_ID, 5, null),
      repository.updateTaskProgress(TENANT, RUN_ID, 5, { cursor: 1n }),
    ];
    const codes = ['TASK_CURRENT_STEP_INVALID', 'TASK_PROGRESS_PAYLOAD_INVALID', 'TASK_PAYLOAD_UNSERIALIZABLE'];

    for (const [index, work] of cases.entries()) {
      expect(await refusalOf(work), codes[index]).toContain(codes[index]);
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('fails closed when the guarded write returns no row', async () => {
    const { repository } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', task_version: 1 })] },
      progress: { rows: [], rowCount: 0 },
    });

    expect(
      await refusalOf(repository.updateTaskProgress(TENANT, RUN_ID, 2, { cursor: 'step-2' })),
    ).toContain('TASK_WRITE_LOST');
  });
});

describe('DurableWorkflowRepository.transitionTask', () => {
  it('merges a transition payload onto an open task and restates the CAS base', async () => {
    const payload = { cursor: 'step-3' };
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', task_version: 2, lease_owner: 'worker-1' })] },
      state_progress: {
        rows: [taskRow({ state: 'running', task_version: 3, state_payload: payload })],
      },
    });

    const record = await repository.transitionTask(
      TENANT,
      RUN_ID,
      'running',
      'step 3 dispatched',
      payload,
      guardFor({ expected_task_version: 2, lease_owner: 'worker-1' }),
    );

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'state_progress']);
    expect(bindingsOf(client, 'state_progress')).toEqual([
      TENANT,
      RUN_ID,
      'running',
      JSON.stringify(payload),
      2,
    ]);
    expect(record.task_version).toBe(3);
  });

  it('moves the state without touching state_payload when the transition carries none', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', task_version: 2 })] },
      state: { rows: [taskRow({ state: 'completed', task_version: 3 })] },
    });

    await expect(
      repository.transitionTask(TENANT, RUN_ID, 'completed', 'plan finished'),
    ).resolves.toMatchObject({ state: 'completed', task_version: 3 });

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'state']);
    expect(bindingsOf(client, 'state')).toEqual([TENANT, RUN_ID, 'completed', 2]);
  });

  it('parks a waiting task on a complete checkpoint that REPLACES state_payload', async () => {
    // The genesis digest is the predecessor cursor of a first step, so it is a legal chain cursor.
    const checkpoint = completeCheckpoint({ previous_evidence_hash: GENESIS_HASH });
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', task_version: 5 })] },
      park: {
        rows: [taskRow({ state: 'waiting', task_version: 6, state_payload: checkpoint })],
      },
    });

    await expect(
      repository.transitionTask(TENANT, RUN_ID, 'waiting', 'provider window closed', checkpoint),
    ).resolves.toMatchObject({ state: 'waiting', task_version: 6 });

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'park']);
    expect(bindingsOf(client, 'park')).toEqual([
      TENANT,
      RUN_ID,
      'waiting',
      JSON.stringify(checkpoint),
      5,
    ]);
  });

  it('refuses to park on anything but a complete checkpoint', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const incomplete: readonly unknown[] = [
      undefined,
      { plan: {} },
      completeCheckpoint({ previous_evidence_hash: 'FEEDFACE'.repeat(8) }),
      completeCheckpoint({ previous_evidence_hash: 'f'.repeat(63) }),
      completeCheckpoint({ current_step: 0 }),
      completeCheckpoint({ pending_action: 'dispatch' }),
    ];

    for (const checkpoint of incomplete) {
      expect(
        await refusalOf(
          repository.transitionTask(TENANT, RUN_ID, 'waiting', 'provider window closed', checkpoint),
        ),
      ).toContain('CHECKPOINT_INCOMPLETE');
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses awaiting_human outside the approval transaction that can resume it', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    expect(
      await refusalOf(
        repository.transitionTask(TENANT, RUN_ID, 'awaiting_human', 'human review', completeCheckpoint()),
      ),
    ).toContain('TASK_PAUSE_REQUIRES_APPROVAL');

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('requires a reason and refuses a state outside the closed lifecycle', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    expect(
      await refusalOf(repository.transitionTask(TENANT, RUN_ID, 'stopped', '   ')),
    ).toContain('TASK_TRANSITION_REASON_REQUIRED');
    expect(
      await refusalOf(
        repository.transitionTask(TENANT, RUN_ID, 'UNKNOWN' as DurableTaskState, 'reconciled'),
      ),
    ).toContain('TASK_STATE_INVALID');

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('names the approval that owns a parked task and closes a terminal one', async () => {
    const parked = harnessFor({
      lock: {
        rows: [taskRow({ state: 'awaiting_human', paused_for_approval_id: 'approval-7' })],
      },
    });
    const terminal = harnessFor({ lock: { rows: [taskRow({ state: 'stopped' })] } });

    expect(
      await refusalOf(parked.repository.transitionTask(TENANT, RUN_ID, 'running', 'resume')),
    ).toContain('TASK_PAUSE_RESUME_REQUIRES_DECISION');
    expect(
      await refusalOf(terminal.repository.transitionTask(TENANT, RUN_ID, 'queued', 'requeue')),
    ).toContain('TASK_ALREADY_TERMINAL');

    expect(parked.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
    expect(terminal.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('refuses a non-object transition payload before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    expect(
      await refusalOf(repository.transitionTask(TENANT, RUN_ID, 'running', 'progress', 'cursor-9')),
    ).toContain('TASK_PROGRESS_PAYLOAD_INVALID');

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

describe('DurableWorkflowRepository.recordFailure', () => {
  it('re-queues a RETRYABLE failure inside the budget with retry_count + 1', async () => {
    const error_details = { code: 'DISPATCH_TIMEOUT' };
    const { repository, client, boundTenants } = harnessFor({
      lock: {
        rows: [
          taskRow({
            state: 'running',
            task_version: 3,
            retry_count: 0,
            max_retries: 3,
            lease_owner: 'worker-1',
          }),
        ],
      },
      requeue: {
        rows: [
          taskRow({
            state: 'queued',
            task_version: 4,
            retry_count: 1,
            last_error_class: 'RETRYABLE',
          }),
        ],
      },
    });

    const outcome = await repository.recordFailure(
      failureInput({ error_details, expected_task_version: 3 }),
    );

    expect(boundTenants).toEqual([TENANT]);
    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'requeue']);
    expect(bindingsOf(client, 'requeue')).toEqual([
      TENANT,
      RUN_ID,
      'RETRYABLE',
      JSON.stringify(error_details),
      3,
    ]);
    expect(outcome).toEqual({ requeued: true, state: 'queued', retry_count: 1, task_version: 4 });
  });

  it('terminates a RETRYABLE failure whose budget is spent', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', retry_count: 3, max_retries: 3 })] },
      fail: {
        rows: [
          taskRow({
            state: 'failed',
            task_version: 5,
            retry_count: 3,
            last_error_class: 'RETRYABLE',
          }),
        ],
      },
    });

    const outcome = await repository.recordFailure(failureInput());

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'fail']);
    expect(outcome).toEqual({ requeued: false, state: 'failed', retry_count: 3, task_version: 5 });
  });

  it('terminates a FATAL failure with the retry budget untouched', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'running', retry_count: 0, max_retries: 3 })] },
      fail: {
        rows: [taskRow({ state: 'failed', task_version: 4, last_error_class: 'FATAL' })],
      },
    });

    const outcome = await repository.recordFailure(failureInput({ error_class: 'FATAL' }));

    expect(client.statements.map((statement) => statement.kind)).toEqual(['lock', 'fail']);
    expect(outcome).toEqual({ requeued: false, state: 'failed', retry_count: 0, task_version: 4 });
  });

  it('refuses UNKNOWN and a diagnostics value that is not a JSON object, before any transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const cases: readonly Promise<unknown>[] = [
      repository.recordFailure(failureInput({ error_class: 'UNKNOWN' })),
      repository.recordFailure(
        failureInput({ error_details: null as unknown as Record<string, unknown> }),
      ),
    ];
    const codes = ['TASK_ERROR_CLASS_INVALID', 'TASK_ERROR_DETAILS_INVALID'];

    for (const [index, work] of cases.entries()) {
      expect(await refusalOf(work), codes[index]).toContain(codes[index]);
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });

  it('refuses a failure recorded against a parked task or a stale version', async () => {
    const parked = harnessFor({
      lock: {
        rows: [taskRow({ state: 'awaiting_human', paused_for_approval_id: 'approval-2' })],
      },
    });
    const stale = harnessFor({ lock: { rows: [taskRow({ state: 'running', task_version: 6 })] } });

    expect(await refusalOf(parked.repository.recordFailure(failureInput()))).toContain(
      'TASK_NOT_PROGRESSABLE',
    );
    expect(
      await refusalOf(stale.repository.recordFailure(failureInput({ expected_task_version: 5 }))),
    ).toContain('TASK_VERSION_CONFLICT');

    expect(parked.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
    expect(stale.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });
});

describe('DurableWorkflowRepository.requeueFailed', () => {
  it('re-enters a failed run in place, clearing the failure and the lease and keeping the checkpoint', async () => {
    const checkpoint = { plan: { steps: [] }, current_step: 4, request_id: 'REQ-1' };
    const { repository, client, boundTenants } = harnessFor({
      lock: {
        rows: [
          taskRow({
            state: 'failed',
            current_step: 4,
            task_version: 6,
            retry_count: 2,
            last_error_class: 'FATAL',
            error_details: { code: 'PROVIDER_REJECTED' },
            lease_owner: 'worker-1',
            lease_expires_at: LEASE_EXPIRES_AT,
            state_payload: checkpoint,
          }),
        ],
      },
      operator_requeue: {
        rows: [
          taskRow({
            state: 'queued',
            current_step: 4,
            task_version: 7,
            retry_count: 2,
            error_details: null,
            state_payload: checkpoint,
          }),
        ],
      },
    });

    const record = await repository.requeueFailed(
      requeueInput({ reason: 'provider incident resolved', expected_task_version: 6 }),
    );

    expect(boundTenants).toEqual([TENANT]);
    // One lock and one transition: the requeue creates no task and issues no second write.
    expect(client.statements.map((statement) => statement.kind)).toEqual([
      'lock',
      'operator_requeue',
    ]);
    expect(bindingsOf(client, 'operator_requeue')).toEqual([TENANT, RUN_ID, 6]);
    expect(record).toMatchObject({
      state: 'queued',
      task_version: 7,
      current_step: 4,
      retry_count: 2,
      last_error_class: null,
      error_details: null,
      lease_owner: null,
      lease_expires_at: null,
      state_payload: checkpoint,
    });

    // Only the transition, the failure classification and the lease are written: the checkpoint, the
    // cursor, the retry budget and the effect identity of the failed attempt are not restated, so the
    // re-entered step runs on the SAME effect_key.
    const { sql } = statementOf(client, 'operator_requeue');
    const written = sql.slice(sql.indexOf('SET '), sql.indexOf('WHERE'));

    expect(written).toContain("state = 'queued'");
    expect(written).toContain('last_error_class = NULL');
    expect(written).toContain('error_details = NULL');
    expect(written).toContain('lease_owner = NULL');
    expect(written).toContain('lease_expires_at = NULL');
    expect(written).toContain('task_version = task_version + 1');

    for (const untouched of [
      'state_payload',
      'current_step',
      'retry_count',
      'max_retries',
      'correlation_id',
      'paused_for_approval_id',
    ]) {
      expect(written, untouched).not.toContain(untouched);
    }
  });

  it('uses the locked version as the CAS base when the operator supplies no guard', async () => {
    const { repository, client } = harnessFor({
      lock: { rows: [taskRow({ state: 'failed', task_version: 9 })] },
      operator_requeue: { rows: [taskRow({ state: 'queued', task_version: 10 })] },
    });

    const record = await repository.requeueFailed(requeueInput());

    expect(bindingsOf(client, 'operator_requeue')).toEqual([TENANT, RUN_ID, 9]);
    expect(record.task_version).toBe(10);
  });

  it('refuses every state but failed, naming the approval that owns a parked run', async () => {
    const states: readonly DurableTaskState[] = ['queued', 'running', 'waiting', 'completed', 'stopped'];

    for (const state of states) {
      const { repository, client } = harnessFor({ lock: { rows: [taskRow({ state })] } });

      expect(await refusalOf(repository.requeueFailed(requeueInput())), state).toContain(
        'TASK_REQUEUE_NOT_FAILED',
      );
      // The state is verified on the locked row, so no transition is issued for any of them.
      expect(client.statements.map((statement) => statement.kind)).toEqual(['lock']);
    }

    const parked = harnessFor({
      lock: {
        rows: [taskRow({ state: 'awaiting_human', paused_for_approval_id: 'approval-3' })],
      },
    });

    const refusal = await refusalOf(parked.repository.requeueFailed(requeueInput()));

    expect(refusal).toContain('TASK_REQUEUE_NOT_FAILED');
    expect(refusal).toContain('approval-3');
    expect(parked.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
  });

  it('refuses a stale operator version and a run the bound tenant does not hold', async () => {
    const stale = harnessFor({ lock: { rows: [taskRow({ state: 'failed', task_version: 6 })] } });
    const missing = harnessFor({ lock: { rows: [] } });

    expect(
      await refusalOf(stale.repository.requeueFailed(requeueInput({ expected_task_version: 5 }))),
    ).toContain('TASK_VERSION_CONFLICT');
    expect(
      await refusalOf(missing.repository.requeueFailed(requeueInput({ tenant_id: OTHER_TENANT }))),
    ).toContain('DURABLE_TASK_NOT_FOUND');

    expect(stale.client.statements.map((statement) => statement.kind)).toEqual(['lock']);
    expect(missing.boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(missing.client, 'lock')).toEqual([OTHER_TENANT, RUN_ID]);
  });

  it('requires the operator reason and the addressed run before opening a transaction', async () => {
    const { repository, client, boundTenants } = harnessFor({});

    const cases: readonly { readonly input: RequeueFailedTaskInput; readonly code: string }[] = [
      { input: requeueInput({ reason: '   ' }), code: 'TASK_REQUEUE_REASON_REQUIRED' },
      { input: requeueInput({ run_id: '' }), code: 'TASK_RUN_ID_REQUIRED' },
      { input: requeueInput({ tenant_id: ' ' }), code: 'TASK_TENANT_ID_REQUIRED' },
    ];

    for (const { input, code } of cases) {
      expect(await refusalOf(repository.requeueFailed(input)), code).toContain(code);
    }

    expect(boundTenants).toEqual([]);
    expect(client.statements).toEqual([]);
  });
});

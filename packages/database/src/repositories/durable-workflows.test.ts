import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { DurableWorkflowRepository } from './durable-workflows.js';
import type {
  CreateDurableTaskInput,
  DurableTaskGuard,
  DurableTaskRecord,
  DurableTaskState,
  RecordTaskFailureInput,
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
 * only, re-queue, terminal), which version it restates as the CAS base and which version it
 * publishes back, that a stale writer is refused instead of overwriting a newer checkpoint, and
 * that `UNKNOWN` and an incomplete checkpoint never reach the row. The live half (RLS denial,
 * enums, CHECK constraints) belongs to `src/rls.test.ts` and is not duplicated here.
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const RUN_ID = 'RUN-1';
const CORRELATION_ID = 'CORR-1';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-01-01T00:01:00.000Z');
const LEASE_EXPIRES_AT = new Date('2026-01-01T00:01:30.000Z');

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
  | 'progress'
  | 'state'
  | 'park'
  | 'state_progress'
  | 'requeue'
  | 'fail';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.platform_durable_tasks')) {
    return 'insert';
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

/** The parameters bound to the single statement of `kind`; fails the test when it was never issued. */
function bindingsOf(client: ScriptedClient, kind: StatementKind): readonly unknown[] {
  const statement = client.statements.find((candidate) => candidate.kind === kind);

  if (statement === undefined) {
    throw new Error(`SCRIPTED_STATEMENT_MISSING: no ${kind} statement was issued.`);
  }

  return statement.params;
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

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { ApprovalRepository, sha256CanonicalJson } from './approvals.js';
import type {
  ActionStatus,
  ApprovalActionDraft,
  ApprovalDecision,
  ApprovalListInput,
  ApprovalStatus,
  ClaimApprovalAndResumeInput,
  QueueApprovalDecisionInput,
  PauseForApprovalInput,
} from './approvals.js';
import type { DurableTaskRow } from './durable-workflows.js';

/**
 * Unit suite for the AUTH-4 pause, the human decision that releases it, and the two console reads
 * over the same rows (implement/04 §4.2, implement/06 §8.1.3 R14 / §8.2.1, implement/08 §7.2).
 *
 * The repository is exercised against a scripted `pg` client instead of PostgreSQL: every statement
 * it issues is classified, recorded, and answered from a per-transition script. That keeps the
 * binding the gate commits - the locked task, one PENDING row per effect revision, the exact run /
 * action / effect key / payload digest a decision restates, and the single use of a decision - as
 * the SQL-observable behavior the durable rows actually show, without a database and without
 * re-implementing those rules inside the test.
 *
 * What is asserted is what a caller observes: which statements a pause or a decision takes (and in
 * which order, so the lock order is part of the contract), the parameters that reach the rows
 * (tenant, run, action, effect key, the reviewed bytes, the version each write restates), the digest
 * an approval publishes, the checkpoint a MODIFIED resume stores for the next claim to read, and
 * which refusals happen before a transaction opens at all. The live half - RLS denial, the
 * `ck_approvals_decided` CHECK, the `ON CONFLICT` behavior of the real index - needs PostgreSQL and
 * is not scriptable here (`implement/09` §3.1).
 */

/** Tenant bound to every statement; the repository is tenant-scoped by construction. */
const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const RUN_ID = 'RUN-1';
const OTHER_RUN_ID = 'RUN-2';
const CORRELATION_ID = 'CORR-1';
const REQUEST_ID = 'REQ-1';
const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACTION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_ACTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const APPROVAL_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OTHER_APPROVAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SKILL_ID = 'skill.echo';
const ADAPTER_TARGET = 'slack';
const STEP_INDEX = 3;
const EFFECT_KEY = 'EK-REQ-1-SKILL-ECHO-STEP-3';
const MODIFIED_EFFECT_KEY = 'EK-REQ-1-SKILL-ECHO-STEP-3-R1';
const OTHER_EFFECT_KEY = 'EK-REQ-1-SKILL-ECHO-STEP-4';
const OPERATOR_ID = 'operator.ada';
const REASON = 'The outbound message needs an operator decision before it leaves.';
const COMMENT = 'Reviewed the drafted payload and approved it.';
/** The version the caller read; the pause restates it as the compare-and-increment base. */
const TASK_VERSION = 7;
/** The version the pause committed: one increment above the base. */
const PARKED_TASK_VERSION = 8;
/** The version the resume or the hold committed. */
const MOVED_TASK_VERSION = 9;
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-01-01T00:05:00.000Z');
const DECIDED_AT = new Date('2026-01-01T00:10:00.000Z');
/** The 64-zero digest the evidence chain starts from (implement/04 §6.1). */
const GENESIS_HASH = '0'.repeat(64);

/** The payload the operator reviews; two members, so member order is observable. */
const PAYLOAD: Record<string, unknown> = { channel: '#ops', text: 'deploy release 42' };
/** The same members in another order: the same bytes once canonicalized. */
const REORDERED_PAYLOAD: Record<string, unknown> = { text: 'deploy release 42', channel: '#ops' };
/** Other bytes under the same effect revision: never the same digest. */
const OTHER_PAYLOAD: Record<string, unknown> = { channel: '#ops', text: 'deploy release 43' };
/** The payload a MODIFIED decision authorizes in place of the reviewed one. */
const AUTHORIZED_PAYLOAD: Record<string, unknown> = {
  channel: '#ops',
  text: 'deploy release 42 (edited)',
};
const PAYLOAD_SHA256 = sha256CanonicalJson(PAYLOAD);

/** One approval row exactly as `pg` returns it, before the projection is published. */
interface ApprovalRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  run_id: string;
  action_id: string;
  campaign_id: string | null;
  effect_key: string;
  authority_required: 'AUTH-4';
  payload: unknown;
  reason: string;
  operator_id: string | null;
  decision: ApprovalStatus;
  is_paused: boolean;
  review_comment: string | null;
  decided_at: Date | null;
  created_at: Date;
}

/** One action row exactly as `pg` returns it, before the projection is published. */
interface ActionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  decision_id: string | null;
  skill_name: string;
  effect_key: string;
  action_revision: number;
  target_channel: string;
  action_payload: unknown;
  status: ActionStatus;
  created_at: Date;
}

/**
 * Which statement of the repository a SQL text is. The script answers per kind, so a test states one
 * transition at a time instead of matching whole statements; an unrecognized statement fails the
 * test rather than being answered with an empty result.
 */
type StatementKind =
  | 'lock_task'
  | 'insert_action'
  | 'lock_action'
  | 'read_actions'
  | 'insert_approval'
  | 'lock_approval'
  | 'read_approval'
  | 'list_pending'
  | 'lock_approval_by_effect_key'
  | 'pause_task'
  | 'hold_task'
  | 'resume_task'
  | 'resume_revised'
  | 'stop_task'
  | 'pause_approval'
  | 'decide_approval'
  | 'modify_action'
  | 'modify_approval'
  | 'queue_resume_event';

function classify(sql: string): StatementKind {
  if (sql.startsWith('INSERT INTO agentos.actions')) {
    return 'insert_action';
  }

  if (sql.startsWith('INSERT INTO agentos.approvals')) {
    return 'insert_approval';
  }

  if (sql.startsWith('UPDATE agentos.actions')) {
    return 'modify_action';
  }

  if (
    sql.includes('SET state_payload = $3::jsonb') &&
    sql.includes('paused_for_approval_id = $5::uuid')
  ) {
    return 'queue_resume_event';
  }

  if (sql.includes("SET state = 'awaiting_human'")) {
    return sql.includes('state_payload = $4::jsonb') ? 'pause_task' : 'hold_task';
  }

  if (sql.includes("SET state = 'running'")) {
    return sql.includes('state_payload = $3::jsonb') ? 'resume_revised' : 'resume_task';
  }

  if (sql.includes("SET state = 'stopped'")) {
    return 'stop_task';
  }

  if (sql.includes('SET is_paused = TRUE')) {
    return 'pause_approval';
  }

  if (sql.includes("SET decision = 'MODIFIED'")) {
    return 'modify_approval';
  }

  if (sql.includes('SET decision = $3')) {
    return 'decide_approval';
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM agentos.platform_durable_tasks')) {
    return 'lock_task';
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM agentos.actions')) {
    return sql.includes('ANY(') ? 'read_actions' : 'lock_action';
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM agentos.approvals')) {
    if (sql.includes("decision = 'PENDING'")) {
      return 'list_pending';
    }

    if (sql.includes('effect_key = $2')) {
      return 'lock_approval_by_effect_key';
    }

    return sql.includes('FOR UPDATE') ? 'lock_approval' : 'read_approval';
  }

  throw new Error(`SCRIPTED_STATEMENT_UNKNOWN: no test scripts the statement "${sql}".`);
}

/** The `pg` result of one statement, as a test scripts it. */
interface ScriptedAnswer {
  /** Rows a `SELECT` / `INSERT ... RETURNING` / `UPDATE ... RETURNING` returns. */
  readonly rows?: readonly QueryResultRow[];
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
  readonly repository: ApprovalRepository;
  readonly client: ScriptedClient;
  /** Tenants passed to the injected binder, in call order. */
  readonly boundTenants: string[];
}

function harnessFor(answers: ScriptedAnswers): RepositoryHarness {
  const client = new ScriptedClient(answers);
  const boundTenants: string[] = [];

  const repository = new ApprovalRepository(async (tenant_id, work) => {
    boundTenants.push(tenant_id);

    return work(client as unknown as PoolClient);
  });

  return { repository, client, boundTenants };
}

/** The kinds of the statements issued so far, in order; the lock order is part of the contract. */
function statementsOf(client: ScriptedClient): readonly StatementKind[] {
  return client.statements.map((statement) => statement.kind);
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

  throw new Error('EXPECTED_REFUSAL: the call succeeded, but the approval gate must refuse it.');
}

/** The drafted AUTH-4 action of the paused step, exactly as the checkpoint carries it. */
function draft(overrides: Partial<ApprovalActionDraft> = {}): ApprovalActionDraft {
  const action: ApprovalActionDraft = {
    action_id: ACTION_ID,
    tenant_id: TENANT,
    run_id: RUN_ID,
    skill_id: SKILL_ID,
    adapter_target: ADAPTER_TARGET,
    step_index: STEP_INDEX,
    request_id: REQUEST_ID,
    action_revision: 0,
    effect_key: EFFECT_KEY,
    required_authority: 'AUTH-4',
    payload: PAYLOAD,
  };

  return Object.assign(action, overrides);
}

/** A COMPLETE `DurableTaskCheckpoint` (implement/04 §3.3), as a parked task must store it. */
function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: { steps: [{ index: STEP_INDEX, skill_id: SKILL_ID }], next_step: STEP_INDEX },
    current_step: STEP_INDEX,
    pending_action: draft(),
    context: { 'run.correlation_id': CORRELATION_ID },
    previous_evidence_hash: GENESIS_HASH,
    request_id: REQUEST_ID,
    ...overrides,
  };
}

/** The checkpoint every case in this suite pauses on and resumes from. */
const CHECKPOINT = checkpoint();

/** The revision a MODIFIED decision authorizes in place of the paused one. */
const MODIFIED_DRAFT = draft({
  action_revision: 1,
  effect_key: MODIFIED_EFFECT_KEY,
  payload: AUTHORIZED_PAYLOAD,
});

/** One approval row carrying the canonical PENDING binding; a case overrides what it is about. */
function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  const row: ApprovalRow = {
    id: APPROVAL_ID,
    tenant_id: TENANT,
    run_id: RUN_ID,
    action_id: ACTION_ID,
    campaign_id: null,
    effect_key: EFFECT_KEY,
    authority_required: 'AUTH-4',
    payload: PAYLOAD,
    reason: REASON,
    operator_id: null,
    decision: 'PENDING',
    is_paused: false,
    review_comment: null,
    decided_at: null,
    created_at: CREATED_AT,
  };

  return Object.assign(row, overrides);
}

/** One action row carrying the prepared command of the default binding. */
function actionRow(overrides: Partial<ActionRow> = {}): ActionRow {
  const row: ActionRow = {
    id: ACTION_ID,
    tenant_id: TENANT,
    decision_id: null,
    skill_name: SKILL_ID,
    effect_key: EFFECT_KEY,
    action_revision: 1,
    target_channel: ADAPTER_TARGET,
    action_payload: PAYLOAD,
    status: 'pending',
    created_at: CREATED_AT,
  };

  return Object.assign(row, overrides);
}

/** One instant, so the `(created_at, id)` order of two queue rows is observable. */
const LATER_CREATED_AT = new Date('2026-01-01T00:01:00.000Z');

/** A second PENDING approval, one queue position behind the default binding. */
function pendingApprovalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return approvalRow({
    id: OTHER_APPROVAL_ID,
    action_id: OTHER_ACTION_ID,
    run_id: OTHER_RUN_ID,
    effect_key: OTHER_EFFECT_KEY,
    payload: OTHER_PAYLOAD,
    created_at: LATER_CREATED_AT,
    ...overrides,
  });
}

/** The action of the second PENDING approval. */
function pendingActionRow(overrides: Partial<ActionRow> = {}): ActionRow {
  return actionRow({
    id: OTHER_ACTION_ID,
    effect_key: OTHER_EFFECT_KEY,
    action_revision: 2,
    action_payload: OTHER_PAYLOAD,
    ...overrides,
  });
}

/** One durable task row, running by default; a case overrides the state it is about. */
function taskRow(overrides: Partial<DurableTaskRow> = {}): DurableTaskRow {
  const row: DurableTaskRow = {
    task_id: TASK_ID,
    tenant_id: TENANT,
    run_id: RUN_ID,
    correlation_id: CORRELATION_ID,
    current_step: STEP_INDEX,
    state: 'running',
    task_version: TASK_VERSION,
    lease_owner: null,
    lease_expires_at: null,
    retry_count: 0,
    max_retries: 3,
    last_error_class: null,
    paused_for_approval_id: null,
    state_payload: CHECKPOINT,
    error_details: null,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  };

  return Object.assign(row, overrides);
}

/** The parked row of a run waiting on the canonical approval. */
function parkedTaskRow(overrides: Partial<DurableTaskRow> = {}): DurableTaskRow {
  return taskRow({
    state: 'awaiting_human',
    task_version: PARKED_TASK_VERSION,
    paused_for_approval_id: APPROVAL_ID,
    ...overrides,
  });
}

/** The approval half of a pause: one action, one effect revision, one reviewed payload. */
function approvalBinding(
  overrides: Partial<PauseForApprovalInput['approval']> = {},
): PauseForApprovalInput['approval'] {
  const binding: PauseForApprovalInput['approval'] = {
    action_id: ACTION_ID,
    effect_key: EFFECT_KEY,
    payload: PAYLOAD,
    reason: REASON,
  };

  return Object.assign(binding, overrides);
}

/** A pause of the default binding; a case overrides the field it is about. */
function pauseInput(overrides: Partial<PauseForApprovalInput> = {}): PauseForApprovalInput {
  const input: PauseForApprovalInput = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    expected_task_version: TASK_VERSION,
    checkpoint: CHECKPOINT,
    approval: approvalBinding(),
  };

  return Object.assign(input, overrides);
}

/** A decision on the default binding; a case overrides the field it is about. */
function claimInput(
  overrides: Partial<ClaimApprovalAndResumeInput> = {},
): ClaimApprovalAndResumeInput {
  const input: ClaimApprovalAndResumeInput = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    approval_id: APPROVAL_ID,
    effect_key: EFFECT_KEY,
    expected_payload_sha256: PAYLOAD_SHA256,
    authorized_action: null,
    decision: 'APPROVED',
    operator_id: OPERATOR_ID,
    review_comment: COMMENT,
  };

  return Object.assign(input, overrides);
}
/** A durable approval decision event; it is not an approval claim. */
function queueInput(
  overrides: Partial<QueueApprovalDecisionInput> = {},
): QueueApprovalDecisionInput {
  const input: QueueApprovalDecisionInput = {
    tenant_id: TENANT,
    approval_id: APPROVAL_ID,
    run_id: RUN_ID,
    effect_key: EFFECT_KEY,
    expected_payload_sha256: PAYLOAD_SHA256,
    decision: 'APPROVE',
    operator_id: OPERATOR_ID,
    reason: COMMENT,
  };

  return Object.assign(input, overrides);
}

function queueAnswers(task: DurableTaskRow = parkedTaskRow()): ScriptedAnswers {
  return {
    lock_task: { rows: [task] },
    lock_action: { rows: [actionRow()] },
    lock_approval: { rows: [approvalRow()] },
    queue_resume_event: { rows: [task] },
  };
}

/** The two approvals-side locks of a decision: the action of the key and the approval row. */
function heldAnswers(
  action: ActionRow = actionRow(),
  approval: ApprovalRow = approvalRow(),
): ScriptedAnswers {
  return { lock_action: { rows: [action] }, lock_approval: { rows: [approval] } };
}

/** A decided approval row carrying the decision, the operator and the review note it recorded. */
function decidedApprovalRow(
  decision: Exclude<ApprovalStatus, 'PENDING'>,
  overrides: Partial<ApprovalRow> = {},
): ApprovalRow {
  return approvalRow({
    decision,
    operator_id: OPERATOR_ID,
    review_comment: COMMENT,
    decided_at: DECIDED_AT,
    ...overrides,
  });
}

/** The scripted answers of one pause that commits the default binding. */
function pauseAnswers(): ScriptedAnswers {
  return {
    lock_task: { rows: [taskRow()] },
    insert_action: { rows: [actionRow()] },
    insert_approval: { rows: [approvalRow()] },
    pause_task: { rows: [parkedTaskRow()] },
  };
}

/** The scripted answers of one decision that reaches the task write of the default binding. */
function decisionAnswers(stop_or_resume: ScriptedAnswers = {}): ScriptedAnswers {
  return {
    lock_task: { rows: [parkedTaskRow()] },
    ...heldAnswers(),
    ...stop_or_resume,
  };
}

describe('ApprovalRepository.pauseForApproval', () => {
  it('parks the run on one PENDING AUTH-4 approval and stores the complete checkpoint', async () => {
    const { repository, client, boundTenants } = harnessFor(pauseAnswers());

    const result = await repository.pauseForApproval(pauseInput());

    expect(boundTenants).toEqual([TENANT]);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'insert_action',
      'insert_approval',
      'pause_task',
    ]);

    expect(result.approval_id).toBe(APPROVAL_ID);
    expect(result.approval.decision).toBe('PENDING');
    expect(result.approval.authority_required).toBe('AUTH-4');
    expect(result.approval.payload).toEqual(PAYLOAD);
    expect(result.approval.payload_sha256).toBe(PAYLOAD_SHA256);
    expect(result.action.effect_key).toBe(EFFECT_KEY);
    expect(result.task.state).toBe('awaiting_human');
    expect(result.task.paused_for_approval_id).toBe(APPROVAL_ID);
    expect(result.task.task_version).toBe(PARKED_TASK_VERSION);

    expect(bindingsOf(client, 'insert_action')).toEqual([
      ACTION_ID,
      TENANT,
      SKILL_ID,
      EFFECT_KEY,
      1,
      ADAPTER_TARGET,
      JSON.stringify(PAYLOAD),
    ]);
    expect(bindingsOf(client, 'insert_approval')).toEqual([
      TENANT,
      RUN_ID,
      ACTION_ID,
      EFFECT_KEY,
      JSON.stringify(PAYLOAD),
      REASON,
    ]);
    expect(bindingsOf(client, 'pause_task')).toEqual([
      TENANT,
      RUN_ID,
      APPROVAL_ID,
      JSON.stringify(CHECKPOINT),
      TASK_VERSION,
    ]);
  });

  it('binds the reviewed bytes by canonical digest, not by member order', async () => {
    const reordered = checkpoint({ pending_action: draft({ payload: REORDERED_PAYLOAD }) });
    const { repository, client } = harnessFor(pauseAnswers());

    const result = await repository.pauseForApproval(pauseInput({ checkpoint: reordered }));

    expect(result.approval.payload_sha256).toBe(PAYLOAD_SHA256);
    expect(bindingsOf(client, 'insert_action')[6]).toBe(JSON.stringify(PAYLOAD));

    const other = checkpoint({ pending_action: draft({ payload: OTHER_PAYLOAD }) });
    const refused = harnessFor({});

    await expect(
      refused.repository.pauseForApproval(pauseInput({ checkpoint: other })),
    ).rejects.toThrow('APPROVAL_BINDING_MISMATCH');
    expect(statementsOf(refused.client)).toEqual([]);
  });

  it('refuses a pause that cannot open the gate, before any transaction opens', async () => {
    const cases: readonly (readonly [string, PauseForApprovalInput])[] = [
      ['CHECKPOINT_INCOMPLETE', pauseInput({ checkpoint: { current_step: STEP_INDEX } })],
      ['APPROVAL_ACTION_INVALID', pauseInput({ checkpoint: checkpoint({ pending_action: null }) })],
      [
        'AUTH5_NEVER_APPROVABLE',
        pauseInput({
          checkpoint: checkpoint({ pending_action: draft({ required_authority: 'AUTH-5' }) }),
        }),
      ],
      [
        'APPROVAL_REQUIRES_AUTH4',
        pauseInput({
          checkpoint: checkpoint({ pending_action: draft({ required_authority: 'AUTH-2' }) }),
        }),
      ],
      ['APPROVAL_REASON_REQUIRED', pauseInput({ approval: approvalBinding({ reason: '  ' }) })],
      ['APPROVAL_PAYLOAD_INVALID', pauseInput({ approval: approvalBinding({ payload: 'text' }) })],
      ['APPROVAL_TASK_VERSION_INVALID', pauseInput({ expected_task_version: 0 })],
      [
        'APPROVAL_ACTION_ID_INVALID',
        pauseInput({ approval: approvalBinding({ action_id: 'action-1' }) }),
      ],
    ];

    for (const [code, input] of cases) {
      const { repository, client, boundTenants } = harnessFor({});

      await expect(repository.pauseForApproval(input)).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual([]);
      expect(boundTenants).toEqual([]);
    }
  });

  it('refuses a pause whose approval and drafted action describe different commands', async () => {
    const cases: readonly PauseForApprovalInput[] = [
      pauseInput({ approval: approvalBinding({ action_id: OTHER_ACTION_ID }) }),
      pauseInput({ approval: approvalBinding({ effect_key: OTHER_EFFECT_KEY }) }),
      pauseInput({ tenant_id: OTHER_TENANT }),
      pauseInput({ run_id: OTHER_RUN_ID }),
    ];

    for (const input of cases) {
      const { repository, client } = harnessFor({});

      await expect(repository.pauseForApproval(input)).rejects.toThrow(
        'APPROVAL_BINDING_MISMATCH',
      );
      expect(statementsOf(client)).toEqual([]);
    }
  });

  it('refuses a pause whose guarded task version is stale, before any write', async () => {
    const { repository, client } = harnessFor({ lock_task: { rows: [taskRow()] } });

    await expect(
      repository.pauseForApproval(pauseInput({ expected_task_version: TASK_VERSION - 1 })),
    ).rejects.toThrow('TASK_VERSION_CONFLICT');
    expect(statementsOf(client)).toEqual(['lock_task']);
  });

  it('refuses to park a run that holds no task or is not running', async () => {
    const missing = harnessFor({ lock_task: { rows: [] } });

    await expect(missing.repository.pauseForApproval(pauseInput())).rejects.toThrow(
      'DURABLE_TASK_NOT_FOUND',
    );
    expect(statementsOf(missing.client)).toEqual(['lock_task']);

    for (const state of ['queued', 'stopped', 'completed'] as const) {
      const unreleased = harnessFor({ lock_task: { rows: [taskRow({ state })] } });

      await expect(unreleased.repository.pauseForApproval(pauseInput())).rejects.toThrow(
        'TASK_PAUSE_REQUIRES_RUNNING',
      );
      expect(statementsOf(unreleased.client)).toEqual(['lock_task']);
    }
  });

  it('reads the committed binding back when the run is parked on it', async () => {
    const { repository, client } = harnessFor({
      lock_task: { rows: [parkedTaskRow()] },
      lock_action: { rows: [actionRow()] },
      lock_approval_by_effect_key: { rows: [approvalRow()] },
    });

    const result = await repository.pauseForApproval(pauseInput());

    expect(result.approval_id).toBe(APPROVAL_ID);
    expect(result.approval.payload_sha256).toBe(PAYLOAD_SHA256);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval_by_effect_key',
    ]);
    expect(bindingsOf(client, 'lock_approval_by_effect_key')).toEqual([TENANT, EFFECT_KEY]);
  });

  it('refuses a redelivered pause whose parked approval binds other bytes, is decided, or is not its own', async () => {
    const cases: readonly ScriptedAnswers[] = [
      {
        lock_task: { rows: [parkedTaskRow()] },
        lock_action: { rows: [actionRow()] },
        lock_approval_by_effect_key: { rows: [] },
      },
      {
        lock_task: { rows: [parkedTaskRow()] },
        lock_action: { rows: [] },
        lock_approval_by_effect_key: { rows: [approvalRow()] },
      },
      {
        lock_task: { rows: [parkedTaskRow()] },
        lock_action: { rows: [actionRow()] },
        lock_approval_by_effect_key: { rows: [decidedApprovalRow('REJECTED')] },
      },
      {
        lock_task: { rows: [parkedTaskRow()] },
        lock_action: { rows: [actionRow()] },
        lock_approval_by_effect_key: { rows: [approvalRow({ payload: OTHER_PAYLOAD })] },
      },
      {
        lock_task: { rows: [parkedTaskRow()] },
        lock_action: { rows: [actionRow()] },
        lock_approval_by_effect_key: { rows: [approvalRow({ id: OTHER_APPROVAL_ID })] },
      },
    ];

    const expected = [
      'TASK_PAUSE_RESUME_REQUIRES_DECISION',
      'TASK_PAUSE_RESUME_REQUIRES_DECISION',
      'APPROVAL_ALREADY_DECIDED',
      'APPROVAL_BINDING_MISMATCH',
      'TASK_PAUSE_RESUME_REQUIRES_DECISION',
    ];

    for (const [index, answers] of cases.entries()) {
      const { repository, client } = harnessFor(answers);

      await expect(repository.pauseForApproval(pauseInput())).rejects.toThrow(expected[index]);
      expect(statementsOf(client)).toEqual([
        'lock_task',
        'lock_action',
        'lock_approval_by_effect_key',
      ]);
    }
  });

  it('refuses a second pause whose effect revision already carries a decided approval', async () => {
    const { repository, client } = harnessFor({
      lock_task: { rows: [taskRow()] },
      insert_action: { rows: [actionRow()] },
      insert_approval: { rows: [] },
      lock_approval_by_effect_key: { rows: [decidedApprovalRow('MODIFIED')] },
    });

    await expect(repository.pauseForApproval(pauseInput())).rejects.toThrow(
      'APPROVAL_ALREADY_DECIDED',
    );
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'insert_action',
      'insert_approval',
      'lock_approval_by_effect_key',
    ]);
  });

  it('reuses the action and approval rows a redelivered pause collided with', async () => {
    const { repository, client } = harnessFor({
      lock_task: { rows: [taskRow()] },
      insert_action: { rows: [] },
      lock_action: { rows: [actionRow()] },
      insert_approval: { rows: [] },
      lock_approval_by_effect_key: { rows: [approvalRow()] },
      pause_task: { rows: [parkedTaskRow()] },
    });

    const result = await repository.pauseForApproval(pauseInput());

    expect(result.approval_id).toBe(APPROVAL_ID);
    expect(result.action.action_revision).toBe(1);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'insert_action',
      'lock_action',
      'insert_approval',
      'lock_approval_by_effect_key',
      'pause_task',
    ]);
    expect(bindingsOf(client, 'pause_task')).toEqual([
      TENANT,
      RUN_ID,
      APPROVAL_ID,
      JSON.stringify(CHECKPOINT),
      TASK_VERSION,
    ]);
  });

  it('refuses a colliding effect key that names another command, and translates a unique violation', async () => {
    const cases: readonly (readonly [
      string,
      ScriptedAnswers,
      readonly StatementKind[],
    ])[] = [
      [
        'ACTION_EFFECT_KEY_CONFLICT',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [] },
          lock_action: { rows: [actionRow({ id: OTHER_ACTION_ID })] },
        },
        ['lock_task', 'insert_action', 'lock_action'],
      ],
      [
        'ACTION_EFFECT_KEY_CONFLICT',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [] },
          lock_action: { rows: [actionRow({ action_revision: 2 })] },
        },
        ['lock_task', 'insert_action', 'lock_action'],
      ],
      [
        'ACTION_EFFECT_KEY_CONFLICT',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [] },
          lock_action: { rows: [actionRow({ action_payload: OTHER_PAYLOAD })] },
        },
        ['lock_task', 'insert_action', 'lock_action'],
      ],
      [
        'ACTION_ID_IN_USE',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: {
            fails: Object.assign(
              new Error('duplicate key value violates unique constraint "actions_pkey"'),
              { code: '23505' },
            ),
          },
        },
        ['lock_task', 'insert_action'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [actionRow()] },
          insert_approval: { rows: [] },
          lock_approval_by_effect_key: { rows: [approvalRow({ run_id: OTHER_RUN_ID })] },
        },
        ['lock_task', 'insert_action', 'insert_approval', 'lock_approval_by_effect_key'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [actionRow()] },
          insert_approval: { rows: [] },
          lock_approval_by_effect_key: { rows: [approvalRow({ payload: OTHER_PAYLOAD })] },
        },
        ['lock_task', 'insert_action', 'insert_approval', 'lock_approval_by_effect_key'],
      ],
      [
        'APPROVAL_UNSTABLE',
        {
          lock_task: { rows: [taskRow()] },
          insert_action: { rows: [actionRow()] },
          insert_approval: { rows: [] },
          lock_approval_by_effect_key: { rows: [] },
        },
        ['lock_task', 'insert_action', 'insert_approval', 'lock_approval_by_effect_key'],
      ],
    ];

    for (const [code, answers, statements] of cases) {
      const { repository, client } = harnessFor(answers);

      await expect(repository.pauseForApproval(pauseInput())).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual(statements);
      expect(statementsOf(client)).not.toContain('pause_task');
    }
  });

  it('rethrows a driver failure untouched instead of reporting an approval outcome', async () => {
    const { repository, client } = harnessFor({
      lock_task: { rows: [taskRow()] },
      insert_action: {
        fails: Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01',
        }),
      },
    });

    expect(await refusalOf(repository.pauseForApproval(pauseInput()))).toBe(
      'terminating connection due to administrator command',
    );
    expect(statementsOf(client)).toEqual(['lock_task', 'insert_action']);
  });
});

describe('ApprovalRepository.queueDecision', () => {
  const resumeEvent = {
    tenant_id: TENANT,
    run_id: RUN_ID,
    effect_key: EFFECT_KEY,
    event_type: 'human.approval',
    approval_id: APPROVAL_ID,
    expected_payload_sha256: PAYLOAD_SHA256,
    operator_id: OPERATOR_ID,
    reason: COMMENT,
  };

  it('queues a durable event without deciding or consuming the approval', async () => {
    const { repository, client, boundTenants } = harnessFor(queueAnswers());

    const result = await repository.queueDecision(queueInput());

    expect(boundTenants).toEqual([TENANT]);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'queue_resume_event',
    ]);
    expect(result).toEqual({
      approval_id: APPROVAL_ID,
      task_id: TASK_ID,
      status: 'QUEUED',
      queued_at: UPDATED_AT.toISOString(),
    });
    const queuedParams = bindingsOf(client, 'queue_resume_event');
    expect(queuedParams[0]).toBe(TENANT);
    expect(queuedParams[1]).toBe(RUN_ID);
    expect(JSON.parse(String(queuedParams[2]))).toEqual({
      ...CHECKPOINT,
      resume_event: resumeEvent,
    });
    expect(queuedParams[3]).toBe(PARKED_TASK_VERSION);
    expect(queuedParams[4]).toBe(APPROVAL_ID);
  });

  it('replays an identical queued decision without writing a second event', async () => {
    const task = parkedTaskRow({
      state_payload: { ...CHECKPOINT, resume_event: resumeEvent },
    });
    const { repository, client } = harnessFor(queueAnswers(task));

    const result = await repository.queueDecision(queueInput());

    expect(result.status).toBe('QUEUED');
    expect(statementsOf(client)).toEqual(['lock_task', 'lock_action', 'lock_approval']);
  });

  it('rejects a different decision already queued for the same approval', async () => {
    const task = parkedTaskRow({
      state_payload: { ...CHECKPOINT, resume_event: resumeEvent },
    });
    const { repository, client } = harnessFor(queueAnswers(task));

    await expect(
      repository.queueDecision(queueInput({
        decision: 'REJECT',
        reason: 'operator changed the decision',
      })),
    ).rejects.toThrow('APPROVAL_DECISION_CONFLICT');
    expect(statementsOf(client)).toEqual(['lock_task', 'lock_action', 'lock_approval']);
  });
});
describe('ApprovalRepository.claimApprovalAndResume', () => {
  it('releases the parked run on one APPROVED decision, in task -> action -> approval lock order', async () => {
    const { repository, client, boundTenants } = harnessFor(
      decisionAnswers({
        decide_approval: { rows: [decidedApprovalRow('APPROVED')] },
        resume_task: {
          rows: [
            taskRow({
              state: 'running',
              task_version: MOVED_TASK_VERSION,
              paused_for_approval_id: null,
            }),
          ],
        },
      }),
    );

    const result = await repository.claimApprovalAndResume(claimInput());

    expect(boundTenants).toEqual([TENANT]);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'decide_approval',
      'resume_task',
    ]);

    expect(result.claimed).toBe(true);
    expect(result.approval.decision).toBe('APPROVED');
    expect(result.approval.operator_id).toBe(OPERATOR_ID);
    expect(result.approval.review_comment).toBe(COMMENT);
    expect(result.approval.is_paused).toBe(false);
    expect(result.approval.decided_at).toBe(DECIDED_AT.toISOString());
    expect(result.action.effect_key).toBe(EFFECT_KEY);
    expect(result.action.action_revision).toBe(1);
    expect(result.task.state).toBe('running');
    expect(result.task.paused_for_approval_id).toBeNull();
    expect(result.task.task_version).toBe(MOVED_TASK_VERSION);

    expect(bindingsOf(client, 'lock_task')).toEqual([TENANT, RUN_ID]);
    expect(bindingsOf(client, 'lock_action')).toEqual([TENANT, EFFECT_KEY]);
    expect(bindingsOf(client, 'lock_approval')).toEqual([TENANT, APPROVAL_ID]);
    expect(bindingsOf(client, 'decide_approval')).toEqual([
      TENANT,
      APPROVAL_ID,
      'APPROVED',
      OPERATOR_ID,
      COMMENT,
    ]);
    expect(bindingsOf(client, 'resume_task')).toEqual([TENANT, RUN_ID, PARKED_TASK_VERSION]);
  });

  it('authorizes a MODIFIED revision in place and stores it in the parked checkpoint', async () => {
    const revised_checkpoint = { ...CHECKPOINT, pending_action: MODIFIED_DRAFT };
    const { repository, client, boundTenants } = harnessFor(
      decisionAnswers({
        modify_action: {
          rows: [
            actionRow({
              action_revision: 2,
              effect_key: MODIFIED_EFFECT_KEY,
              action_payload: AUTHORIZED_PAYLOAD,
            }),
          ],
        },
        modify_approval: {
          rows: [
            decidedApprovalRow('MODIFIED', {
              effect_key: MODIFIED_EFFECT_KEY,
              payload: AUTHORIZED_PAYLOAD,
            }),
          ],
        },
        resume_revised: {
          rows: [
            taskRow({
              state: 'running',
              task_version: MOVED_TASK_VERSION,
              paused_for_approval_id: null,
              state_payload: revised_checkpoint,
            }),
          ],
        },
      }),
    );

    const result = await repository.claimApprovalAndResume(
      claimInput({ decision: 'MODIFIED', authorized_action: MODIFIED_DRAFT }),
    );

    expect(boundTenants).toEqual([TENANT]);
    expect(statementsOf(client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'modify_action',
      'modify_approval',
      'resume_revised',
    ]);

    expect(bindingsOf(client, 'modify_action')).toEqual([
      TENANT,
      ACTION_ID,
      2,
      MODIFIED_EFFECT_KEY,
      JSON.stringify(AUTHORIZED_PAYLOAD),
    ]);
    expect(bindingsOf(client, 'modify_approval')).toEqual([
      TENANT,
      APPROVAL_ID,
      OPERATOR_ID,
      COMMENT,
      MODIFIED_EFFECT_KEY,
      JSON.stringify(AUTHORIZED_PAYLOAD),
    ]);
    expect(bindingsOf(client, 'resume_revised')).toEqual([
      TENANT,
      RUN_ID,
      JSON.stringify(revised_checkpoint),
      PARKED_TASK_VERSION,
    ]);

    expect(result.approval.decision).toBe('MODIFIED');
    expect(result.approval.payload_sha256).toBe(sha256CanonicalJson(AUTHORIZED_PAYLOAD));
    expect(result.approval.payload_sha256).not.toBe(PAYLOAD_SHA256);
    expect(result.action.effect_key).toBe(MODIFIED_EFFECT_KEY);
    expect(result.action.action_revision).toBe(2);
    expect(result.task.state).toBe('running');
    expect(result.task.state_payload).toEqual(revised_checkpoint);
    expect(result.task.task_version).toBe(MOVED_TASK_VERSION);
  });

  it('closes the run on REJECTED and CANCELLED without authorizing the prepared command', async () => {
    for (const decision of ['REJECTED', 'CANCELLED'] as const) {
      const { repository, client } = harnessFor(
        decisionAnswers({
          decide_approval: { rows: [decidedApprovalRow(decision)] },
          stop_task: {
            rows: [
              taskRow({
                state: 'stopped',
                task_version: MOVED_TASK_VERSION,
                paused_for_approval_id: null,
              }),
            ],
          },
        }),
      );

      const result = await repository.claimApprovalAndResume(claimInput({ decision }));

      expect(statementsOf(client)).toEqual([
        'lock_task',
        'lock_action',
        'lock_approval',
        'decide_approval',
        'stop_task',
      ]);
      expect(bindingsOf(client, 'decide_approval')).toEqual([
        TENANT,
        APPROVAL_ID,
        decision,
        OPERATOR_ID,
        COMMENT,
      ]);
      expect(bindingsOf(client, 'stop_task')).toEqual([TENANT, RUN_ID, PARKED_TASK_VERSION]);

      expect(result.approval.decision).toBe(decision);
      expect(result.action.effect_key).toBe(EFFECT_KEY);
      expect(result.action.status).toBe('pending');
      expect(result.task.state).toBe('stopped');
      expect(result.task.paused_for_approval_id).toBeNull();
    }
  });

  it('records an explicit PAUSE as a hold: the row stays PENDING and no checkpoint is rewritten', async () => {
    const { repository, client } = harnessFor(
      decisionAnswers({
        pause_approval: { rows: [approvalRow({ is_paused: true })] },
        hold_task: { rows: [parkedTaskRow({ task_version: MOVED_TASK_VERSION })] },
      }),
    );

    const result = await repository.claimApprovalAndResume(claimInput({ decision: 'PAUSE' }));

    expect(statementsOf(client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'pause_approval',
      'hold_task',
    ]);

    expect(bindingsOf(client, 'pause_approval')).toEqual([TENANT, APPROVAL_ID]);
    expect(bindingsOf(client, 'hold_task')).toEqual([
      TENANT,
      RUN_ID,
      APPROVAL_ID,
      PARKED_TASK_VERSION,
    ]);

    expect(result.approval.decision).toBe('PENDING');
    expect(result.approval.is_paused).toBe(true);
    expect(result.task.state).toBe('awaiting_human');
    expect(result.task.paused_for_approval_id).toBe(APPROVAL_ID);
    expect(result.task.task_version).toBe(MOVED_TASK_VERSION);
  });

  it('accepts an APPROVED decision that restates the reviewed action and refuses a contradictory one', async () => {
    const restated = harnessFor(
      decisionAnswers({
        decide_approval: { rows: [decidedApprovalRow('APPROVED')] },
        resume_task: {
          rows: [
            taskRow({
              state: 'running',
              task_version: MOVED_TASK_VERSION,
              paused_for_approval_id: null,
            }),
          ],
        },
      }),
    );

    const result = await restated.repository.claimApprovalAndResume(
      claimInput({ authorized_action: draft() }),
    );

    expect(result.approval.decision).toBe('APPROVED');
    expect(statementsOf(restated.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'decide_approval',
      'resume_task',
    ]);

    const contradictory: readonly ApprovalActionDraft[] = [
      draft({ action_id: OTHER_ACTION_ID }),
      draft({ effect_key: OTHER_EFFECT_KEY }),
      draft({ payload: OTHER_PAYLOAD }),
    ];

    for (const authorized_action of contradictory) {
      const { repository, client } = harnessFor(decisionAnswers());

      await expect(
        repository.claimApprovalAndResume(claimInput({ authorized_action })),
      ).rejects.toThrow('APPROVAL_BINDING_MISMATCH');
      expect(statementsOf(client)).toEqual(['lock_task', 'lock_action', 'lock_approval']);
    }
  });

  it('refuses a decision whose reviewed digest, effect key, action or run is not the locked binding', async () => {
    const cases: readonly (readonly [
      string,
      ScriptedAnswers,
      readonly StatementKind[],
    ])[] = [
      [
        'APPROVAL_STALE_PAYLOAD',
        decisionAnswers({ lock_approval: { rows: [approvalRow({ payload: OTHER_PAYLOAD })] } }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        decisionAnswers({ lock_action: { rows: [] } }),
        ['lock_task', 'lock_action'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        decisionAnswers({
          lock_approval: { rows: [approvalRow({ effect_key: OTHER_EFFECT_KEY })] },
        }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        decisionAnswers({
          lock_approval: { rows: [approvalRow({ action_id: OTHER_ACTION_ID })] },
        }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        { lock_task: { rows: [parkedTaskRow({ paused_for_approval_id: OTHER_APPROVAL_ID })] } },
        ['lock_task'],
      ],
      [
        'APPROVAL_NOT_FOUND',
        decisionAnswers({ lock_approval: { rows: [] } }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
    ];

    for (const [code, answers, statements] of cases) {
      const { repository, client } = harnessFor(answers);

      await expect(repository.claimApprovalAndResume(claimInput())).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual(statements);
    }
  });

  it('refuses a second decision, a second pause, a released run and a missing task', async () => {
    const cases: readonly (readonly [
      string,
      ClaimApprovalAndResumeInput,
      ScriptedAnswers,
      readonly StatementKind[],
    ])[] = [
      [
        'APPROVAL_NOT_CLAIMABLE',
        claimInput(),
        decisionAnswers({ lock_approval: { rows: [decidedApprovalRow('APPROVED')] } }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      [
        'APPROVAL_NOT_CLAIMABLE',
        claimInput({ decision: 'MODIFIED', authorized_action: MODIFIED_DRAFT }),
        decisionAnswers({ lock_approval: { rows: [decidedApprovalRow('MODIFIED')] } }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      [
        'APPROVAL_NOT_CLAIMABLE',
        claimInput({ decision: 'PAUSE' }),
        decisionAnswers({ lock_approval: { rows: [approvalRow({ is_paused: true })] } }),
        ['lock_task', 'lock_action', 'lock_approval'],
      ],
      ['APPROVAL_NOT_CLAIMABLE', claimInput(), { lock_task: { rows: [taskRow()] } }, ['lock_task']],
      ['DURABLE_TASK_NOT_FOUND', claimInput(), { lock_task: { rows: [] } }, ['lock_task']],
    ];

    for (const [code, input, answers, statements] of cases) {
      const { repository, client } = harnessFor(answers);

      await expect(repository.claimApprovalAndResume(input)).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual(statements);
    }
  });

  it('refuses a decision that cannot address a claim, before any transaction opens', async () => {
    const cases: readonly (readonly [string, ClaimApprovalAndResumeInput])[] = [
      ['APPROVAL_TENANT_ID_REQUIRED', claimInput({ tenant_id: ' ' })],
      ['APPROVAL_RUN_ID_REQUIRED', claimInput({ run_id: '' })],
      ['APPROVAL_ID_INVALID', claimInput({ approval_id: 'approval-1' })],
      ['APPROVAL_EFFECT_KEY_REQUIRED', claimInput({ effect_key: ' ' })],
      [
        'APPROVAL_DIGEST_INVALID',
        claimInput({ expected_payload_sha256: `sha256:${PAYLOAD_SHA256}` }),
      ],
      [
        'APPROVAL_DIGEST_INVALID',
        claimInput({ expected_payload_sha256: PAYLOAD_SHA256.slice(0, 63) }),
      ],
      [
        'APPROVAL_DECISION_INVALID',
        claimInput({ decision: 'PENDING' as unknown as ApprovalDecision }),
      ],
      ['APPROVAL_OPERATOR_REQUIRED', claimInput({ operator_id: ' ' })],
      ['APPROVAL_REVIEW_COMMENT_INVALID', claimInput({ review_comment: 7 as unknown as string })],
      ['MODIFICATION_REQUIRED', claimInput({ decision: 'MODIFIED' })],
      [
        'APPROVAL_DECISION_ACTION_MISMATCH',
        claimInput({ decision: 'REJECTED', authorized_action: MODIFIED_DRAFT }),
      ],
      [
        'APPROVAL_ACTION_INVALID',
        claimInput({
          decision: 'MODIFIED',
          authorized_action: draft({ payload: 'text' as unknown as Record<string, unknown> }),
        }),
      ],
    ];

    for (const [code, input] of cases) {
      const { repository, client, boundTenants } = harnessFor({});

      await expect(repository.claimApprovalAndResume(input)).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual([]);
      expect(boundTenants).toEqual([]);
    }
  });

  it('compares the reviewed digest over canonical bytes, not over the spelling that arrived', async () => {
    const { repository, client } = harnessFor(
      decisionAnswers({
        lock_approval: { rows: [approvalRow({ payload: REORDERED_PAYLOAD })] },
        decide_approval: { rows: [decidedApprovalRow('APPROVED')] },
        resume_task: {
          rows: [
            taskRow({
              state: 'running',
              task_version: MOVED_TASK_VERSION,
              paused_for_approval_id: null,
            }),
          ],
        },
      }),
    );

    const result = await repository.claimApprovalAndResume(
      claimInput({ expected_payload_sha256: PAYLOAD_SHA256.toUpperCase() }),
    );

    expect(result.approval.decision).toBe('APPROVED');
    expect(result.approval.payload_sha256).toBe(PAYLOAD_SHA256);
    expect(statementsOf(client)).toContain('resume_task');
  });

  it('refuses a MODIFIED decision that does not revise the paused command in place', async () => {
    const cases: readonly (readonly [string, ApprovalActionDraft, ScriptedAnswers])[] = [
      [
        'APPROVAL_BINDING_MISMATCH',
        draft({ ...MODIFIED_DRAFT, action_id: OTHER_ACTION_ID }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        draft({ ...MODIFIED_DRAFT, tenant_id: OTHER_TENANT }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_BINDING_MISMATCH',
        draft({ ...MODIFIED_DRAFT, run_id: OTHER_RUN_ID }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_IDENTITY_CHANGED',
        draft({ ...MODIFIED_DRAFT, skill_id: 'skill.other' }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_IDENTITY_CHANGED',
        draft({ ...MODIFIED_DRAFT, adapter_target: 'email' }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_IDENTITY_CHANGED',
        draft({ ...MODIFIED_DRAFT, step_index: STEP_INDEX + 1 }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_IDENTITY_CHANGED',
        draft({ ...MODIFIED_DRAFT, request_id: 'REQ-2' }),
        decisionAnswers(),
      ],
      [
        'AUTH5_NEVER_APPROVABLE',
        draft({ ...MODIFIED_DRAFT, required_authority: 'AUTH-5' }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_REQUIRES_AUTH4',
        draft({ ...MODIFIED_DRAFT, required_authority: 'AUTH-3' }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_REVISION_INVALID',
        draft({ ...MODIFIED_DRAFT, action_revision: 0 }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_REVISION_INVALID',
        draft({ ...MODIFIED_DRAFT, action_revision: 2 }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_EFFECT_KEY_UNCHANGED',
        draft({ ...MODIFIED_DRAFT, effect_key: EFFECT_KEY }),
        decisionAnswers(),
      ],
      [
        'APPROVAL_ACTION_DISPATCHED',
        MODIFIED_DRAFT,
        decisionAnswers({ lock_action: { rows: [actionRow({ status: 'dispatched' })] } }),
      ],
      [
        'APPROVAL_REVISION_INVALID',
        MODIFIED_DRAFT,
        decisionAnswers({ lock_action: { rows: [actionRow({ action_revision: 3 })] } }),
      ],
      [
        'CHECKPOINT_INCOMPLETE',
        MODIFIED_DRAFT,
        decisionAnswers({
          lock_task: { rows: [parkedTaskRow({ state_payload: { current_step: STEP_INDEX } })] },
        }),
      ],
      [
        'APPROVAL_REQUIRES_AUTH4',
        MODIFIED_DRAFT,
        decisionAnswers({
          lock_task: {
            rows: [
              parkedTaskRow({
                state_payload: checkpoint({
                  pending_action: draft({ required_authority: 'AUTH-2' }),
                }),
              }),
            ],
          },
        }),
      ],
    ];

    for (const [code, authorized_action, answers] of cases) {
      const { repository, client } = harnessFor(answers);

      await expect(
        repository.claimApprovalAndResume(claimInput({ decision: 'MODIFIED', authorized_action })),
      ).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual(['lock_task', 'lock_action', 'lock_approval']);
    }
  });

  it('translates a taken effect key on the revised action, and refuses a revision that was not persisted', async () => {
    const taken = harnessFor(
      decisionAnswers({
        modify_action: {
          fails: Object.assign(
            new Error('duplicate key value violates unique constraint "uq_actions_effect_key"'),
            { code: '23505' },
          ),
        },
      }),
    );

    await expect(
      taken.repository.claimApprovalAndResume(
        claimInput({ decision: 'MODIFIED', authorized_action: MODIFIED_DRAFT }),
      ),
    ).rejects.toThrow('APPROVAL_EFFECT_KEY_CONFLICT');
    expect(statementsOf(taken.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'modify_action',
    ]);

    const lost_revision = harnessFor(
      decisionAnswers({
        modify_action: { rows: [] },
        modify_approval: {
          rows: [
            decidedApprovalRow('MODIFIED', {
              effect_key: MODIFIED_EFFECT_KEY,
              payload: AUTHORIZED_PAYLOAD,
            }),
          ],
        },
      }),
    );

    await expect(
      lost_revision.repository.claimApprovalAndResume(
        claimInput({ decision: 'MODIFIED', authorized_action: MODIFIED_DRAFT }),
      ),
    ).rejects.toThrow('APPROVAL_WRITE_LOST');
    expect(statementsOf(lost_revision.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'modify_action',
      'modify_approval',
    ]);
  });

  it('refuses to report a decision or a resume that matched no row', async () => {
    const lost_decision = harnessFor(decisionAnswers({ decide_approval: { rows: [] } }));

    await expect(lost_decision.repository.claimApprovalAndResume(claimInput())).rejects.toThrow(
      'APPROVAL_WRITE_LOST',
    );
    expect(statementsOf(lost_decision.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'decide_approval',
    ]);

    const lost_resume = harnessFor(
      decisionAnswers({
        decide_approval: { rows: [decidedApprovalRow('APPROVED')] },
        resume_task: { rows: [] },
      }),
    );

    await expect(lost_resume.repository.claimApprovalAndResume(claimInput())).rejects.toThrow(
      'TASK_WRITE_LOST',
    );
    expect(statementsOf(lost_resume.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'decide_approval',
      'resume_task',
    ]);
  });

  it('lets a driver failure through untouched instead of reporting an approval outcome', async () => {
    const connection_lost = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    );

    const lost_at_decision = harnessFor(
      decisionAnswers({ decide_approval: { fails: connection_lost } }),
    );

    expect(
      await refusalOf(lost_at_decision.repository.claimApprovalAndResume(claimInput())),
    ).toBe('terminating connection due to administrator command');
    expect(statementsOf(lost_at_decision.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'decide_approval',
    ]);

    const lost_at_revision = harnessFor(
      decisionAnswers({ modify_action: { fails: connection_lost } }),
    );

    expect(
      await refusalOf(
        lost_at_revision.repository.claimApprovalAndResume(
          claimInput({ decision: 'MODIFIED', authorized_action: MODIFIED_DRAFT }),
        ),
      ),
    ).toBe('terminating connection due to administrator command');
    expect(statementsOf(lost_at_revision.client)).toEqual([
      'lock_task',
      'lock_action',
      'lock_approval',
      'modify_action',
    ]);
  });
});

describe('ApprovalRepository.listPending', () => {
  it('publishes the queue oldest-first with the action of each item and its reviewed digest', async () => {
    const { repository, client, boundTenants } = harnessFor({
      list_pending: { rows: [approvalRow(), pendingApprovalRow()] },
      read_actions: { rows: [actionRow(), pendingActionRow()] },
    });

    const page = await repository.listPending({ tenant_id: TENANT });

    expect(boundTenants).toEqual([TENANT]);
    expect(statementsOf(client)).toEqual(['list_pending', 'read_actions']);

    const [first, second] = page.items;

    expect(first?.approval).toEqual({
      id: APPROVAL_ID,
      tenant_id: TENANT,
      run_id: RUN_ID,
      action_id: ACTION_ID,
      campaign_id: null,
      effect_key: EFFECT_KEY,
      authority_required: 'AUTH-4',
      payload: PAYLOAD,
      payload_sha256: PAYLOAD_SHA256,
      reason: REASON,
      operator_id: null,
      decision: 'PENDING',
      is_paused: false,
      review_comment: null,
      decided_at: null,
      created_at: CREATED_AT.toISOString(),
    });
    expect(first?.action).toEqual({
      id: ACTION_ID,
      tenant_id: TENANT,
      decision_id: null,
      skill_name: SKILL_ID,
      effect_key: EFFECT_KEY,
      action_revision: 1,
      target_channel: ADAPTER_TARGET,
      action_payload: PAYLOAD,
      status: 'pending',
      created_at: CREATED_AT.toISOString(),
    });
    expect(second?.approval.id).toBe(OTHER_APPROVAL_ID);
    expect(second?.approval.payload_sha256).toBe(sha256CanonicalJson(OTHER_PAYLOAD));
    expect(second?.action.id).toBe(OTHER_ACTION_ID);
    expect(second?.action.action_revision).toBe(2);

    // The page is read one row past the page size (default 50), and the actions are read by the
    // identities the page published, in one statement under the same tenant.
    expect(bindingsOf(client, 'list_pending')).toEqual([TENANT, null, null, 51]);
    expect(bindingsOf(client, 'read_actions')).toEqual([TENANT, [ACTION_ID, OTHER_ACTION_ID]]);
  });

  it('pages by (created_at, id) and resumes strictly after the row the previous page ended on', async () => {
    const { repository, client } = harnessFor({
      // The first read answers one row more than it publishes: the extra row is what tells the page
      // it is not the last one, and it must not be published or have its action read.
      list_pending: (params) =>
        params[1] === null
          ? { rows: [approvalRow(), pendingApprovalRow()] }
          : { rows: [pendingApprovalRow()] },
      read_actions: (params) => ({
        rows: (params[1] as readonly string[]).map((id) =>
          id === ACTION_ID ? actionRow() : pendingActionRow(),
        ),
      }),
    });

    const first = await repository.listPending({ tenant_id: TENANT, limit: 1 });
    const cursor = first.next_cursor;

    expect(first.items.map((item) => item.approval.id)).toEqual([APPROVAL_ID]);
    expect(cursor).toBe(`${CREATED_AT.toISOString()}|${APPROVAL_ID}`);
    expect(bindingsOf(client, 'read_actions')).toEqual([TENANT, [ACTION_ID]]);

    if (cursor === null) {
      throw new Error('the first page of two rows must hand back the cursor of its last row');
    }

    const second = await repository.listPending({
      tenant_id: TENANT,
      limit: 1,
      cursor,
    });

    expect(second.items.map((item) => item.approval.id)).toEqual([OTHER_APPROVAL_ID]);
    expect(second.next_cursor).toBeNull();

    const pages = client.statements.filter((statement) => statement.kind === 'list_pending');

    expect(pages.map((statement) => statement.params)).toEqual([
      [TENANT, null, null, 2],
      [TENANT, CREATED_AT.toISOString(), APPROVAL_ID, 2],
    ]);
  });

  it('lists a paused-but-undecided item once, as the PENDING row it still is', async () => {
    const { repository, client } = harnessFor({
      list_pending: { rows: [approvalRow({ is_paused: true })] },
      read_actions: { rows: [actionRow()] },
    });

    const page = await repository.listPending({ tenant_id: TENANT });
    const [statement] = client.statements;

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.approval.decision).toBe('PENDING');
    expect(page.items[0]?.approval.is_paused).toBe(true);
    expect(page.items[0]?.action.id).toBe(ACTION_ID);

    // The queue IS the PENDING projection: the predicate is the decision alone, so a parked item is
    // never filtered out of the console it was parked for, and the projected `is_paused` column is
    // what renders it as PAUSED (`06` §8.1.3 R14).
    expect(statement?.sql).toContain("decision = 'PENDING'");
    expect(statement?.sql).not.toContain('is_paused =');
  });

  it('binds every statement to the calling tenant and answers another tenant with an empty queue', async () => {
    const { repository, client, boundTenants } = harnessFor({ list_pending: { rows: [] } });

    const page = await repository.listPending({ tenant_id: OTHER_TENANT });

    expect(page).toEqual({ items: [], next_cursor: null });
    expect(boundTenants).toEqual([OTHER_TENANT]);
    // No row was published, so no action is read: an empty tenant costs one statement, not two.
    expect(statementsOf(client)).toEqual(['list_pending']);
    expect(bindingsOf(client, 'list_pending')).toEqual([OTHER_TENANT, null, null, 51]);
  });

  it('refuses a limit or a cursor it cannot honor, before any transaction opens', async () => {
    const cases: readonly (readonly [string, ApprovalListInput])[] = [
      ['APPROVAL_LIMIT_INVALID', { tenant_id: TENANT, limit: 0 }],
      ['APPROVAL_LIMIT_INVALID', { tenant_id: TENANT, limit: 201 }],
      ['APPROVAL_LIMIT_INVALID', { tenant_id: TENANT, limit: 1.5 }],
      ['APPROVAL_LIMIT_INVALID', { tenant_id: TENANT, limit: Number.NaN }],
      ['APPROVAL_LIMIT_INVALID', { tenant_id: TENANT, limit: '10' as unknown as number }],
      ['APPROVAL_CURSOR_INVALID', { tenant_id: TENANT, cursor: 'not-a-cursor' }],
      ['APPROVAL_CURSOR_INVALID', { tenant_id: TENANT, cursor: '' }],
      [
        'APPROVAL_CURSOR_INVALID',
        { tenant_id: TENANT, cursor: `${CREATED_AT.toISOString()}|approval-1` },
      ],
      ['APPROVAL_CURSOR_INVALID', { tenant_id: TENANT, cursor: `${CREATED_AT.toISOString()}|` }],
      // The same instant in another spelling is not the cursor this module published.
      [
        'APPROVAL_CURSOR_INVALID',
        { tenant_id: TENANT, cursor: `2026-01-01T00:00:00Z|${APPROVAL_ID}` },
      ],
      ['APPROVAL_TENANT_ID_REQUIRED', { tenant_id: '   ' }],
    ];

    for (const [code, input] of cases) {
      const { repository, client, boundTenants } = harnessFor({});

      await expect(repository.listPending(input)).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual([]);
      expect(boundTenants).toEqual([]);
    }
  });

  it('refuses to publish an item whose action is not visible in the tenant', async () => {
    const { repository, client } = harnessFor({
      list_pending: { rows: [approvalRow()] },
      read_actions: { rows: [] },
    });

    await expect(repository.listPending({ tenant_id: TENANT })).rejects.toThrow(
      'APPROVAL_ACTION_MISSING',
    );
    expect(statementsOf(client)).toEqual(['list_pending', 'read_actions']);
  });
});

describe('ApprovalRepository.getDetail', () => {
  it('reads one approval with its action and the digest of the reviewed payload', async () => {
    const { repository, client, boundTenants } = harnessFor({
      read_approval: { rows: [approvalRow()] },
      read_actions: { rows: [actionRow()] },
    });

    const detail = await repository.getDetail(TENANT, APPROVAL_ID);

    expect(boundTenants).toEqual([TENANT]);
    // A read locks nothing: neither statement is a locking read, and no write is issued.
    expect(statementsOf(client)).toEqual(['read_approval', 'read_actions']);
    expect(bindingsOf(client, 'read_approval')).toEqual([TENANT, APPROVAL_ID]);
    expect(bindingsOf(client, 'read_actions')).toEqual([TENANT, [ACTION_ID]]);

    expect(detail?.approval.id).toBe(APPROVAL_ID);
    expect(detail?.approval.run_id).toBe(RUN_ID);
    expect(detail?.approval.payload).toEqual(PAYLOAD);
    expect(detail?.approval.payload_sha256).toBe(PAYLOAD_SHA256);
    expect(detail?.approval.reason).toBe(REASON);
    expect(detail?.approval.decision).toBe('PENDING');
    expect(detail?.approval.created_at).toBe(CREATED_AT.toISOString());
    expect(detail?.action).toEqual({
      id: ACTION_ID,
      tenant_id: TENANT,
      decision_id: null,
      skill_name: SKILL_ID,
      effect_key: EFFECT_KEY,
      action_revision: 1,
      target_channel: ADAPTER_TARGET,
      action_payload: PAYLOAD,
      status: 'pending',
      created_at: CREATED_AT.toISOString(),
    });
  });

  it('reads a decided approval too, so the console renders what it decided', async () => {
    const { repository } = harnessFor({
      read_approval: { rows: [decidedApprovalRow('APPROVED')] },
      read_actions: { rows: [actionRow({ status: 'authorized' })] },
    });

    const detail = await repository.getDetail(TENANT, APPROVAL_ID);

    expect(detail?.approval.decision).toBe('APPROVED');
    expect(detail?.approval.operator_id).toBe(OPERATOR_ID);
    expect(detail?.approval.review_comment).toBe(COMMENT);
    expect(detail?.approval.decided_at).toBe(DECIDED_AT.toISOString());
    expect(detail?.action.status).toBe('authorized');
  });

  it('answers null for a missing and for another tenant id, without reading an action', async () => {
    const missing = harnessFor({ read_approval: { rows: [] } });

    await expect(missing.repository.getDetail(TENANT, APPROVAL_ID)).resolves.toBeNull();
    expect(statementsOf(missing.client)).toEqual(['read_approval']);
    expect(bindingsOf(missing.client, 'read_approval')).toEqual([TENANT, APPROVAL_ID]);

    // Row-level security is the second half of the same predicate: an id of another tenant is read
    // in that other tenant's transaction, matches no row, and is answered as absent rather than
    // redacted (`06` §8.2.1).
    const foreign = harnessFor({ read_approval: { rows: [] } });

    await expect(foreign.repository.getDetail(OTHER_TENANT, APPROVAL_ID)).resolves.toBeNull();
    expect(foreign.boundTenants).toEqual([OTHER_TENANT]);
    expect(bindingsOf(foreign.client, 'read_approval')).toEqual([OTHER_TENANT, APPROVAL_ID]);
  });

  it('refuses an id that is not a UUID, and a blank tenant, before any transaction opens', async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['APPROVAL_ID_INVALID', TENANT, 'APV-CAMP-15'],
      ['APPROVAL_ID_INVALID', TENANT, `${APPROVAL_ID} `],
      ['APPROVAL_TENANT_ID_REQUIRED', '', APPROVAL_ID],
      ['APPROVAL_TENANT_ID_REQUIRED', '  ', APPROVAL_ID],
    ];

    for (const [code, tenant_id, approval_id] of cases) {
      const { repository, client, boundTenants } = harnessFor({});

      await expect(repository.getDetail(tenant_id, approval_id)).rejects.toThrow(code);
      expect(statementsOf(client)).toEqual([]);
      expect(boundTenants).toEqual([]);
    }
  });

  it('refuses to publish an approval whose action is not visible in the tenant', async () => {
    const { repository, client } = harnessFor({
      read_approval: { rows: [approvalRow()] },
      read_actions: { rows: [] },
    });

    await expect(repository.getDetail(TENANT, APPROVAL_ID)).rejects.toThrow(
      'APPROVAL_ACTION_MISSING',
    );
    expect(statementsOf(client)).toEqual(['read_approval', 'read_actions']);
  });
});

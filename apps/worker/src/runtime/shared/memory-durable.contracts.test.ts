import { describe, expect, it } from 'vitest';

import { EffectReservationRepository, DurableWorkflowRepository, ApprovalRepository } from '@agentos/database';
import {
  EFFECT_RESERVATION_TTL_MS,
  EffectGuard,
  GENESIS_HASH,
  MemoryEffectGuard,
  MemoryWorkflowEngine,
  OrchestratorError,
  computeEffectKey,
  computeRequestFingerprint,
  type ActionDraft,
  type DurableTaskCheckpoint,
  type IEffectGuard,
  type IStatefulWorkflowEngine,
  type PersistedErrorClass,
} from '@agentos/core-engine';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN = 'run-contract-1';
const REQUEST_ID = 'request-contract-1';
const START = '2026-09-22T00:00:00.000Z';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';

const ACTION: ActionDraft = {
  action_id: ACTION_ID,
  run_id: RUN,
  tenant_id: TENANT,
  agent_id: 'MKT-01',
  skill_id: 'skill.contract.send',
  adapter_target: 'line',
  step_index: 1,
  mutating: true,
  price_bearing: false,
  request_id: REQUEST_ID,
  action_revision: 0,
  effect_key: 'effect-contract-v0',
  required_authority: 'AUTH-4',
  payload: { message: 'review me' },
};

const CHECKPOINT: DurableTaskCheckpoint = {
  plan: { plan_id: 'contract-plan', steps: [], fallback_strategy: 'FAIL_CLOSED' },
  current_step: 1,
  pending_action: ACTION,
  context: {
    correlation_id: 'corr-contract',
    tenant_id: TENANT,
    customer: null,
    working_memory: {
      session_id: 'session-contract',
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: START,
  },
  previous_evidence_hash: GENESIS_HASH,
  request_id: REQUEST_ID,
};

function codeOf(error: unknown): string | undefined {
  return error instanceof OrchestratorError ? error.code : undefined;
}

function clock(start = START): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

interface FakeReservationRow {
  tenant_id: string;
  effect_key: string;
  request_id: string;
  request_fingerprint: string;
  run_id: string;
  step_index: number;
  skill_id: string;
  status: 'RESERVED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  response_receipt: unknown;
  reserved_at: Date;
  resolved_at: Date | null;
  expires_at: Date;
  expired: boolean;
}

/**
 * A stateful fake `pg` client: the production EffectReservationRepository still owns validation,
 * arbitration and settlement; this client only supplies durable rows and SQL write results.
 */
class FakeReservationPgClient {
  private readonly rows = new Map<string, FakeReservationRow>();
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
  }

  async query<R extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    const key = `${String(values[0])}|${String(values[1])}`;
    if (sql.startsWith('INSERT INTO agentos.effect_reservations')) {
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      const expires_at = values[7] === undefined
        ? new Date(this.now().getTime() + EFFECT_RESERVATION_TTL_MS)
        : new Date(String(values[7]));
      const row: FakeReservationRow = {
        tenant_id: String(values[0]),
        effect_key: String(values[1]),
        request_id: String(values[2]),
        request_fingerprint: String(values[3]),
        run_id: String(values[4]),
        step_index: Number(values[5]),
        skill_id: String(values[6]),
        status: 'RESERVED',
        response_receipt: null,
        reserved_at: this.now(),
        resolved_at: null,
        expires_at,
        expired: expires_at.getTime() <= this.now().getTime(),
      };
      this.rows.set(key, row);
      return { rows: [row as unknown as R], rowCount: 1 };
    }
    if (sql.startsWith('SELECT')) {
      const row = this.rows.get(key);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.expired = row.expires_at.getTime() <= this.now().getTime();
      return { rows: [row as unknown as R], rowCount: 1 };
    }
    if (sql.includes("SET status = 'RESERVED'")) {
      const row = this.rows.get(key);
      if (row === undefined || row.status !== 'FAILED') return { rows: [], rowCount: 0 };
      row.status = 'RESERVED';
      row.expires_at = new Date(String(values[2]));
      row.resolved_at = null;
      return { rows: [{ effect_key: row.effect_key } as unknown as R], rowCount: 1 };
    }
    if (sql.includes("SET status = 'EXPIRED'")) {
      const row = this.rows.get(key);
      if (row === undefined || row.status !== 'RESERVED') return { rows: [], rowCount: 0 };
      row.status = 'EXPIRED';
      row.resolved_at = this.now();
      return { rows: [{ effect_key: row.effect_key } as unknown as R], rowCount: 1 };
    }
    if (sql.includes('SET status = $3')) {
      const row = this.rows.get(key);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = String(values[2]) as FakeReservationRow['status'];
      row.response_receipt = values[3] === null ? null : JSON.parse(String(values[3]));
      row.resolved_at = this.now();
      return { rows: [{ effect_key: row.effect_key } as unknown as R], rowCount: 1 };
    }
    throw new Error(`FAKE_RESERVATION_SQL_UNSUPPORTED: ${sql}`);
  }
}

function durableEffectGuard(now: () => Date): IEffectGuard {
  const client = new FakeReservationPgClient(now);
  const runInTenantTransaction = async <T>(_tenant_id: string, work: (pgClient: unknown) => Promise<T>): Promise<T> => (
    await work(client)
  );
  return new EffectGuard({
    repository: new EffectReservationRepository(runInTenantTransaction as never),
    now,
  });
}

function reservationInput(guard: IEffectGuard, overrides: Partial<Parameters<IEffectGuard['reserve']>[0]> = {}) {
  const identity = {
    tenant_id: overrides.tenant_id ?? TENANT,
    skill_id: overrides.skill_id ?? ACTION.skill_id,
    step_index: overrides.step_index ?? ACTION.step_index,
    action_revision: overrides.action_revision ?? ACTION.action_revision,
    request_id: overrides.request_id ?? REQUEST_ID,
  };
  return {
    ...identity,
    run_id: overrides.run_id ?? RUN,
    effect_key: overrides.effect_key ?? guard.computeEffectKey(identity),
    request_fingerprint: overrides.request_fingerprint ?? guard.computeRequestFingerprint(ACTION.payload),
  };
}

const effectFactories: readonly [string, (now: () => Date) => IEffectGuard][] = [
  ['memory', (now) => new MemoryEffectGuard({ now })],
  ['durable fake-client', durableEffectGuard],
];

describe.each(effectFactories)('E11 effect guard contract: %s', (_name, createGuard) => {
  it('shares reserve, replay, conflict, expiry and reconciliation semantics', async () => {
    const time = clock();
    const guard = createGuard(time.now);
    const first = reservationInput(guard);

    expect(await guard.reserve(first)).toEqual({ kind: 'RESERVED' });
    expect(await guard.reserve({ ...first, run_id: 'run-contract-replay' })).toEqual({ kind: 'IN_FLIGHT' });
    expect(await guard.reserve({
      ...first,
      request_fingerprint: guard.computeRequestFingerprint({ message: 'changed' }),
    })).toEqual({ kind: 'CONFLICT' });

    time.advance(EFFECT_RESERVATION_TTL_MS + 1);
    expect(await guard.reserve({ ...first, run_id: 'run-contract-expired' })).toEqual({ kind: 'RECONCILE_REQUIRED' });
    expect(await guard.reconcile({ tenant_id: TENANT, effect_key: first.effect_key, skill_id: ACTION.skill_id }))
      .toEqual({ outcome: 'INDETERMINATE' });

    const receipt = { provider_reference: 'provider-contract-1' };
    await guard.resolve({ tenant_id: TENANT, effect_key: first.effect_key, status: 'SUCCEEDED', receipt });
    expect(await guard.reserve({ ...first, run_id: 'run-contract-replay-2' })).toEqual({ kind: 'REPLAY', receipt });
    expect(await guard.reconcile({ tenant_id: TENANT, effect_key: first.effect_key, skill_id: ACTION.skill_id }))
      .toEqual({ outcome: 'SUCCEEDED', receipt });
  });

  it('rejects non-canonical keys, malformed fingerprints and wrong connector skills identically', async () => {
    const time = clock();
    const guard = createGuard(time.now);
    const input = reservationInput(guard);

    await expect(guard.reserve({ ...input, effect_key: 'not-a-canonical-key' })).rejects.toSatisfy((error: unknown) =>
      ['EFFECT_KEY_MISMATCH', 'EFFECT_RESERVATION_KEY_REQUIRED'].includes(codeOf(error) ?? String(error).split(':')[0] ?? ''),
    );
    await expect(guard.reserve({ ...input, request_fingerprint: 'bad' })).rejects.toSatisfy((error: unknown) =>
      ['REQUEST_FINGERPRINT_INVALID', 'EFFECT_RESERVATION_FINGERPRINT_INVALID'].includes(codeOf(error) ?? String(error).split(':')[0] ?? ''),
    );

    await guard.reserve(input);
    await expect(guard.reconcile({
      tenant_id: TENANT,
      effect_key: input.effect_key,
      skill_id: 'skill.other.connector',
    })).rejects.toSatisfy((error: unknown) =>
      ['EFFECT_SKILL_MISMATCH'].includes(codeOf(error) ?? String(error).split(':')[0] ?? ''),
    );
  });
});

type WorkflowFactory = readonly [string, () => IStatefulWorkflowEngine];

interface FakeWorkflowTask {
  task_id: string;
  tenant_id: string;
  run_id: string;
  correlation_id: string;
  current_step: number;
  state: string;
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

interface FakeWorkflowAction {
  id: string;
  tenant_id: string;
  decision_id: string | null;
  skill_name: string;
  effect_key: string;
  action_revision: number;
  target_channel: string;
  action_payload: unknown;
  status: 'pending' | 'authorized' | 'dispatched' | 'failed';
  created_at: Date;
}

interface FakeWorkflowApproval {
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
  decision: 'PENDING' | 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'CANCELLED';
  is_paused: boolean;
  review_comment: string | null;
  decided_at: Date | null;
  created_at: Date;
  /** Mirrors the column default from migration 0020 (pending decisions expire after 72 hours). */
  expires_at: Date;
}

/**
 * Stateful fake `pg` client used behind the production durable repositories. The repositories still
 * perform all validation, CAS checks, approval binding and transition decisions; this client only
 * supplies the rows a PostgreSQL transaction would return.
 */
class FakeWorkflowPgClient {
  private readonly tasks = new Map<string, FakeWorkflowTask>();
  private readonly actions = new Map<string, FakeWorkflowAction>();
  private readonly approvals = new Map<string, FakeWorkflowApproval>();
  private readonly now = new Date(START);

  private key(tenant_id: string, run_id: string): string {
    return `${tenant_id}|${run_id}`;
  }

  private task(values: readonly unknown[]): FakeWorkflowTask | undefined {
    return this.tasks.get(this.key(String(values[0]), String(values[1])));
  }

  private projectTask(row: FakeWorkflowTask): Record<string, unknown> {
    return { ...row };
  }

  private projectAction(row: FakeWorkflowAction): Record<string, unknown> {
    return { ...row };
  }

  private projectApproval(row: FakeWorkflowApproval): Record<string, unknown> {
    return { ...row };
  }

  private parse(value: unknown): unknown {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  async query<R extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    if (sql.startsWith('INSERT INTO agentos.platform_durable_tasks')) {
      const row: FakeWorkflowTask = {
        task_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        tenant_id: String(values[0]),
        run_id: String(values[1]),
        correlation_id: String(values[2]),
        current_step: Number(values[3]),
        state: String(values[4]),
        task_version: 1,
        lease_owner: null,
        lease_expires_at: null,
        retry_count: 0,
        max_retries: Number(values[5]),
        last_error_class: null,
        paused_for_approval_id: null,
        state_payload: this.parse(values[6]),
        error_details: {},
        created_at: this.now,
        updated_at: this.now,
      };
      this.tasks.set(this.key(row.tenant_id, row.run_id), row);
      return { rows: [this.projectTask(row) as R], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO agentos.actions')) {
      const row: FakeWorkflowAction = {
        id: String(values[0]),
        tenant_id: String(values[1]),
        decision_id: null,
        skill_name: String(values[2]),
        effect_key: String(values[3]),
        action_revision: Number(values[4]),
        target_channel: String(values[5]),
        action_payload: this.parse(values[6]),
        status: 'pending',
        created_at: this.now,
      };
      this.actions.set(`${row.tenant_id}|${row.effect_key}`, row);
      return { rows: [this.projectAction(row) as R], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO agentos.approvals')) {
      const id = '44444444-4444-4444-8444-444444444444';
      const row: FakeWorkflowApproval = {
        id,
        tenant_id: String(values[0]),
        run_id: String(values[1]),
        action_id: String(values[2]),
        campaign_id: null,
        effect_key: String(values[3]),
        authority_required: 'AUTH-4',
        payload: this.parse(values[4]),
        reason: String(values[5]),
        operator_id: null,
        decision: 'PENDING',
        is_paused: false,
        review_comment: null,
        decided_at: null,
        created_at: this.now,
        expires_at: new Date(this.now.getTime() + 72 * 60 * 60 * 1000),
      };
      this.approvals.set(`${row.tenant_id}|${row.effect_key}`, row);
      return { rows: [this.projectApproval(row) as R], rowCount: 1 };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM agentos.platform_durable_tasks')) {
      const row = this.task(values);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [this.projectTask(row) as R], rowCount: 1 };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM agentos.actions')) {
      const row = this.actions.get(`${String(values[0])}|${String(values[1])}`);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [this.projectAction(row) as R], rowCount: 1 };
    }
    // The B67 lock/read statements expire overdue PENDING rows first (`WITH expired AS ...`). The
    // contract clock never passes the 72-hour deadline, so the fake answers them as the plain read.
    const approvalRead = sql.startsWith('SELECT') || sql.startsWith('WITH expired AS');
    if (approvalRead && sql.includes('FROM agentos.approvals')) {
      const row = sql.includes('id = $2')
        ? [...this.approvals.values()].find((candidate) => candidate.tenant_id === String(values[0]) && candidate.id === String(values[1]))
        : this.approvals.get(`${String(values[0])}|${String(values[1])}`);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [this.projectApproval(row) as R], rowCount: 1 };
    }
    if (sql.startsWith('WITH action_status AS') && sql.includes('UPDATE agentos.approvals')) {
      // B67 DECIDE_APPROVAL: the action status follows the decision in the same statement.
      const row = [...this.approvals.values()].find((candidate) => candidate.tenant_id === String(values[0]) && candidate.id === String(values[1]));
      if (row === undefined || row.decision !== 'PENDING') return { rows: [], rowCount: 0 };
      row.decision = String(values[2]) as FakeWorkflowApproval['decision'];
      row.operator_id = String(values[3]);
      row.review_comment = values[4] as string | null;
      row.decided_at = this.now;
      row.is_paused = false;
      const action = [...this.actions.values()].find((candidate) => candidate.tenant_id === row.tenant_id && candidate.id === row.action_id);
      if (action !== undefined) action.status = row.decision === 'APPROVED' ? 'authorized' : 'failed';
      return { rows: [this.projectApproval(row) as R], rowCount: 1 };
    }
    if (sql.includes('INSERT') || sql.includes('SELECT')) throw new Error(`FAKE_WORKFLOW_SQL_UNSUPPORTED: ${sql}`);

    if (sql.includes('UPDATE agentos.approvals')) {
      const row = [...this.approvals.values()].find((candidate) => candidate.tenant_id === String(values[0]) && candidate.id === String(values[1]));
      if (row === undefined) return { rows: [], rowCount: 0 };
      if (sql.includes('is_paused = TRUE')) row.is_paused = true;
      else {
        row.decision = String(values[2]) as FakeWorkflowApproval['decision'];
        row.operator_id = String(values[3]);
        row.review_comment = values[4] as string | null;
        row.decided_at = this.now;
        row.is_paused = false;
      }
      return { rows: [this.projectApproval(row) as R], rowCount: 1 };
    }

    const row = this.task(values);
    if (row === undefined) return { rows: [], rowCount: 0 };
    if (sql.includes('retry_count = retry_count + 1')) {
      row.retry_count += 1;
      row.state = 'queued';
      row.last_error_class = String(values[2]) as 'RETRYABLE' | 'FATAL';
    } else if (sql.includes("SET state = 'failed'")) {
      row.state = 'failed';
      row.last_error_class = String(values[2]) as 'RETRYABLE' | 'FATAL';
    } else if (sql.includes("SET state = 'awaiting_human'")) {
      row.state = 'awaiting_human';
      row.paused_for_approval_id = String(values[2]);
      row.state_payload = this.parse(values[3]);
    } else if (sql.includes("SET state = 'running'")) {
      row.state = 'running';
      row.paused_for_approval_id = null;
    } else if (sql.includes("SET state = 'stopped'")) {
      row.state = 'stopped';
      row.paused_for_approval_id = null;
    } else if (sql.includes('SET current_step = $3')) {
      row.current_step = Number(values[2]);
      row.state_payload = { ...(row.state_payload as Record<string, unknown>), ...(this.parse(values[3]) as Record<string, unknown>) };
    } else if (sql.includes('state_payload = $4::jsonb')) {
      row.state = String(values[2]);
      row.state_payload = this.parse(values[3]);
    } else if (sql.includes('state_payload = state_payload || $4::jsonb')) {
      row.state = String(values[2]);
      row.state_payload = { ...(row.state_payload as Record<string, unknown>), ...(this.parse(values[3]) as Record<string, unknown>) };
    } else if (sql.includes('SET state = $3::agentos.task_lifecycle_state')) {
      row.state = String(values[2]);
    } else {
      throw new Error(`FAKE_WORKFLOW_SQL_UNSUPPORTED: ${sql}`);
    }
    row.task_version += 1;
    row.updated_at = this.now;
    return { rows: [this.projectTask(row) as R], rowCount: 1 };
  }
}

function durableWorkflowEngine(): IStatefulWorkflowEngine {
  const client = new FakeWorkflowPgClient();
  const runner = async <T>(_tenant_id: string, work: (pgClient: unknown) => Promise<T>): Promise<T> => await work(client);
  const workflows = new DurableWorkflowRepository(runner as never);
  const approvals = new ApprovalRepository(runner as never);
  return {
    async createTask(task) {
      await workflows.createTask(task);
    },
    async updateTaskProgress(tenant_id, run_id, stepIndex, checkpointPayload, guard) {
      await workflows.updateTaskProgress(tenant_id, run_id, stepIndex, checkpointPayload, guard as never);
    },
    async transitionTask(tenant_id, run_id, state, reason, checkpointPayload, guard) {
      await workflows.transitionTask(tenant_id, run_id, state, reason, checkpointPayload, guard as never);
    },
    async getTask(tenant_id, run_id) {
      const row = await workflows.getTask(tenant_id, run_id);
      return row === null ? null : {
        task_version: row.task_version,
        state: row.state,
        correlation_id: row.correlation_id,
        state_payload: row.state_payload as DurableTaskCheckpoint | null,
      };
    },
    async pauseForApproval(params) {
      const result = await approvals.pauseForApproval(params as never);
      return { approval_id: result.approval_id };
    },
    async claimApprovalAndResume(params) {
      const result = await approvals.claimApprovalAndResume(params as never);
      return { claimed: result.claimed };
    },
    async recordFailure(params) {
      const result = await workflows.recordFailure(params as never);
      return { requeued: result.requeued };
    },
    async queueHandoffEvidence(params) {
      return workflows.queueHandoffEvidence(params);
    },
    async clearHandoffEvidence(params) {
      return workflows.clearHandoffEvidence(params);
    },
  };
}

const workflowFactories: readonly WorkflowFactory[] = [
  ['memory', () => new MemoryWorkflowEngine()],
  ['durable fake-client', durableWorkflowEngine],
];

describe.each(workflowFactories)('E11 workflow and approval contract: %s', (_name, createWorkflow) => {
  it('shares lifecycle, checkpoint merge, approval replay/claim and retry semantics', async () => {
    const workflow = createWorkflow();
    await workflow.createTask({ tenant_id: TENANT, run_id: RUN, correlation_id: 'corr-contract', current_step: 1, state: 'running' });
    expect((await workflow.getTask(TENANT, RUN))?.state).toBe('running');

    await workflow.updateTaskProgress(TENANT, RUN, 1, { ...CHECKPOINT, current_step: 1 });
    expect((await workflow.getTask(TENANT, RUN))?.state_payload).toMatchObject({ request_id: REQUEST_ID });

    await workflow.transitionTask(TENANT, RUN, 'waiting', 'EFFECT_UNKNOWN: reconcile', CHECKPOINT);
    await workflow.transitionTask(TENANT, RUN, 'running', 'reconcile.completed');

    const paused = await workflow.pauseForApproval({
      tenant_id: TENANT,
      run_id: RUN,
      expected_task_version: (await workflow.getTask(TENANT, RUN))?.task_version ?? 0,
      checkpoint: CHECKPOINT,
      approval: { action_id: ACTION.action_id, effect_key: ACTION.effect_key, payload: ACTION.payload, reason: 'AUTH-4 review' },
    });
    const replay = await workflow.pauseForApproval({
      tenant_id: TENANT,
      run_id: RUN,
      expected_task_version: (await workflow.getTask(TENANT, RUN))?.task_version ?? 0,
      checkpoint: CHECKPOINT,
      approval: { action_id: ACTION.action_id, effect_key: ACTION.effect_key, payload: ACTION.payload, reason: 'AUTH-4 review' },
    });
    expect(replay.approval_id).toBe(paused.approval_id);

    const claimed = await workflow.claimApprovalAndResume({
      tenant_id: TENANT,
      run_id: RUN,
      approval_id: paused.approval_id,
      effect_key: ACTION.effect_key,
      expected_payload_sha256: computeRequestFingerprint(ACTION.payload),
      authorized_action: ACTION,
      decision: 'APPROVED',
      operator_id: 'operator-contract',
      review_comment: null,
    });
    expect(claimed).toEqual({ claimed: true });
    expect((await workflow.getTask(TENANT, RUN))?.state).toBe('running');

    expect(await workflow.recordFailure({ tenant_id: TENANT, run_id: RUN, error_class: 'RETRYABLE' as PersistedErrorClass, error_details: { code: 'TIMEOUT' } })).toEqual({ requeued: true });
    expect((await workflow.getTask(TENANT, RUN))?.state).toBe('queued');
    expect(await workflow.getTask(OTHER_TENANT, RUN)).toBeNull();
  });
});

it('keeps the contract fixtures tenant-scoped and deterministic', () => {
  expect(computeEffectKey({ tenant_id: TENANT, skill_id: ACTION.skill_id, step_index: 1, action_revision: 0, request_id: REQUEST_ID }))
    .not.toBe(computeEffectKey({ tenant_id: OTHER_TENANT, skill_id: ACTION.skill_id, step_index: 1, action_revision: 0, request_id: REQUEST_ID }));
});

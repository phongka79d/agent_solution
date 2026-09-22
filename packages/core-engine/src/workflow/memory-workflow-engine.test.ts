/**
 * @file `MemoryWorkflowEngine` + `MemoryLeaseManager` tests: the optimistic version guard, the
 * single-use approval claim, the tenant-scoped no-op, the persisted error classes and the lease
 * ownership rules. The engine's module file carries no test of its own beside this one because the
 * whole workflow directory is one ownership unit.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OrchestratorError,
  GENESIS_HASH,
  type ActionDraft,
  type DurableTaskCheckpoint,
  type PersistedErrorClass,
} from '../contracts/types.js';
import { canonicalizeJson } from '../effects/canonical-json.js';
import { MemoryLeaseManager } from './memory-lease.js';
import { MemoryWorkflowEngine } from './memory-workflow-engine.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const RUN = 'run_0001';
const OTHER_RUN = 'run_0002';

const CHECKPOINT: DurableTaskCheckpoint = {
  plan: { plan_id: 'plan_1', steps: [], fallback_strategy: 'FAIL_CLOSED' },
  current_step: 1,
  pending_action: null,
  context: {
    correlation_id: 'corr_1',
    tenant_id: TENANT,
    customer: null,
    working_memory: {
      session_id: 'sess_1',
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-22T00:00:00.000Z',
  },
  previous_evidence_hash: GENESIS_HASH,
  request_id: 'sig_1',
};

const ACTION: ActionDraft = {
  action_id: '33333333-3333-4333-8333-333333333333',
  run_id: RUN,
  tenant_id: TENANT,
  agent_id: 'MKT-01',
  skill_id: 'SKL_CART_RECOVERY',
  adapter_target: 'line',
  step_index: 1,
  mutating: true,
  price_bearing: false,
  request_id: 'sig_1',
  action_revision: 0,
  effect_key: 'effect_key_v0',
  required_authority: 'AUTH-4',
  payload: { message: 'Your cart is waiting', discount_percent: 0 },
};

async function engineWithRunningTask(run_id: string = RUN): Promise<MemoryWorkflowEngine> {
  const engine = new MemoryWorkflowEngine();
  await engine.createTask({
    run_id,
    tenant_id: TENANT,
    correlation_id: 'corr_1',
    current_step: 1,
    state: 'running',
  });
  return engine;
}

async function enginePausedForApproval(): Promise<{
  engine: MemoryWorkflowEngine;
  approval_id: string;
}> {
  const engine = await engineWithRunningTask();
  const paused = await engine.pauseForApproval({
    tenant_id: TENANT,
    run_id: RUN,
    expected_task_version: 1,
    checkpoint: CHECKPOINT,
    approval: {
      action_id: ACTION.action_id,
      effect_key: ACTION.effect_key,
      payload: ACTION.payload,
      reason: 'AUTH-4 requires a human decision',
    },
  });
  return { engine, approval_id: paused.approval_id };
}

describe('MemoryWorkflowEngine task state', () => {
  it('creates version 1 and never exposes another tenant’s run', async () => {
    const engine = await engineWithRunningTask();

    const task = await engine.getTask(TENANT, RUN);
    expect(task).toEqual({
      task_version: 1,
      state: 'running',
      correlation_id: 'corr_1',
      state_payload: null,
    });
    expect(await engine.getTask(OTHER_TENANT, RUN)).toBeNull();
    expect(await engine.getTask(TENANT, OTHER_RUN)).toBeNull();
  });

  it('refuses to overwrite an existing task or to be created in a non-initial state', async () => {
    const engine = await engineWithRunningTask();
    await expect(
      engine.createTask({
        run_id: RUN,
        tenant_id: TENANT,
        correlation_id: 'corr_1',
        current_step: 1,
        state: 'running',
      }),
    ).rejects.toThrow(OrchestratorError);
    await expect(
      engine.createTask({
        run_id: OTHER_RUN,
        tenant_id: TENANT,
        correlation_id: 'corr_1',
        current_step: 1,
        state: 'completed',
      }),
    ).rejects.toThrow(OrchestratorError);
  });

  it('applies legal transitions and refuses illegal pairs and unknown runs', async () => {
    const engine = await engineWithRunningTask();

    await engine.transitionTask(TENANT, RUN, 'waiting', 'EFFECT_UNKNOWN: reconciliation scheduled');
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('waiting');
    await engine.transitionTask(TENANT, RUN, 'running', 'reconcile.completed');
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('running');

    await expect(
      engine.transitionTask(TENANT, RUN, 'completed', 'not yet', undefined, 'not-an-event'),
    ).rejects.toThrow(OrchestratorError);
    await engine.transitionTask(TENANT, RUN, 'completed', 'All plan steps verified');
    await expect(engine.transitionTask(TENANT, RUN, 'running', 'human.resume')).rejects.toThrow(
      OrchestratorError,
    );
    await expect(engine.transitionTask(OTHER_TENANT, RUN, 'running', 'no such task')).rejects.toThrow(
      OrchestratorError,
    );
  });

  it('merges a progress payload into the stored checkpoint instead of erasing it', async () => {
    const engine = await engineWithRunningTask();
    await engine.transitionTask(TENANT, RUN, 'waiting', 'parked', CHECKPOINT);
    await engine.transitionTask(TENANT, RUN, 'running', 'reconcile.completed');

    await engine.updateTaskProgress(TENANT, RUN, 3, {
      plan_id: 'plan_1',
      current_step: 3,
      skill_id: 'SKL_CART_RECOVERY',
    });

    const task = await engine.getTask(TENANT, RUN);
    expect(task?.state_payload?.request_id).toBe('sig_1');
    expect(task?.state_payload?.plan.plan_id).toBe('plan_1');
    expect(task?.state_payload?.current_step).toBe(3);
    expect(task?.task_version).toBe(4);

    await engine.updateTaskProgress(OTHER_TENANT, RUN, 9, { current_step: 9 });
    expect(await engine.getTask(OTHER_TENANT, RUN)).toBeNull();
  });
});

describe('MemoryWorkflowEngine approvals', () => {
  it('pauses with exactly one PENDING approval and an optimistic version guard', async () => {
    const engine = await engineWithRunningTask();

    const paused = await engine.pauseForApproval({
      tenant_id: TENANT,
      run_id: RUN,
      expected_task_version: 1,
      checkpoint: CHECKPOINT,
      approval: {
        action_id: ACTION.action_id,
        effect_key: ACTION.effect_key,
        payload: ACTION.payload,
        reason: 'AUTH-4 requires a human decision',
      },
    });

    const task = await engine.getTask(TENANT, RUN);
    expect(task?.state).toBe('awaiting_human');
    expect(task?.task_version).toBe(2);
    expect(task?.state_payload?.request_id).toBe('sig_1');

    const approvals = engine.listApprovals(TENANT, RUN);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.approval_id).toBe(paused.approval_id);
    expect(approvals[0]?.decision).toBe('PENDING');
    expect(approvals[0]?.is_paused).toBe(false);
    expect(approvals[0]?.payload_sha256).toBe(
      createHash('sha256').update(canonicalizeJson(ACTION.payload), 'utf8').digest('hex'),
    );
  });

  it('does not insert a second PENDING row for the same binding', async () => {
    const { engine, approval_id } = await enginePausedForApproval();

    const replay = await engine.pauseForApproval({
      tenant_id: TENANT,
      run_id: RUN,
      expected_task_version: 2,
      checkpoint: CHECKPOINT,
      approval: {
        action_id: ACTION.action_id,
        effect_key: ACTION.effect_key,
        payload: ACTION.payload,
        reason: 'AUTH-4 requires a human decision',
      },
    });

    expect(replay.approval_id).toBe(approval_id);
    expect(engine.listApprovals(TENANT, RUN)).toHaveLength(1);
    expect((await engine.getTask(TENANT, RUN))?.task_version).toBe(2);
  });

  it('refuses a second action on an already paused run and a stale task version', async () => {
    const { engine } = await enginePausedForApproval();
    await expect(
      engine.pauseForApproval({
        tenant_id: TENANT,
        run_id: RUN,
        expected_task_version: 2,
        checkpoint: CHECKPOINT,
        approval: {
          action_id: '44444444-4444-4444-8444-444444444444',
          effect_key: 'effect_key_other',
          payload: { message: 'other action' },
          reason: 'AUTH-4 requires a human decision',
        },
      }),
    ).rejects.toThrow(OrchestratorError);

    const fresh = await engineWithRunningTask(OTHER_RUN);
    await expect(
      fresh.pauseForApproval({
        tenant_id: TENANT,
        run_id: OTHER_RUN,
        expected_task_version: 7,
        checkpoint: CHECKPOINT,
        approval: { action_id: ACTION.action_id, effect_key: ACTION.effect_key, payload: ACTION.payload, reason: 'stale' },
      }),
    ).rejects.toThrow(OrchestratorError);
    expect(fresh.listApprovals(TENANT, OTHER_RUN)).toHaveLength(0);
    expect((await fresh.getTask(TENANT, OTHER_RUN))?.task_version).toBe(1);
    expect((await fresh.getTask(TENANT, OTHER_RUN))?.state).toBe('running');
  });

  it('accepts a terminal claim once and refuses the second claim', async () => {
    const { engine, approval_id } = await enginePausedForApproval();
    const digest = engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? 'missing-digest';
    const claim = {
      tenant_id: TENANT,
      run_id: RUN,
      approval_id,
      effect_key: ACTION.effect_key,
      expected_payload_sha256: digest,
      authorized_action: ACTION,
      decision: 'APPROVED' as const,
      operator_id: 'operator_1',
      review_comment: 'Approved as reviewed',
    };

    expect(await engine.claimApprovalAndResume(claim)).toEqual({ claimed: true });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('running');
    expect(engine.listApprovals(TENANT, RUN)[0]?.decision).toBe('APPROVED');
    expect(engine.listApprovals(TENANT, RUN)[0]?.operator_id).toBe('operator_1');
    const versionAfterClaim = (await engine.getTask(TENANT, RUN))?.task_version;

    expect(await engine.claimApprovalAndResume(claim)).toEqual({ claimed: false });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('running');
    expect((await engine.getTask(TENANT, RUN))?.task_version).toBe(versionAfterClaim);
  });

  it('writes nothing when the reviewed digest, the binding or the operator is wrong', async () => {
    const { engine, approval_id } = await enginePausedForApproval();
    const base = {
      tenant_id: TENANT,
      run_id: RUN,
      approval_id,
      effect_key: ACTION.effect_key,
      authorized_action: ACTION,
      decision: 'APPROVED' as const,
      operator_id: 'operator_1',
      review_comment: null,
    };

    expect(
      await engine.claimApprovalAndResume({ ...base, expected_payload_sha256: 'stale-digest' }),
    ).toEqual({ claimed: false });
    expect(
      await engine.claimApprovalAndResume({ ...base, effect_key: 'effect_key_other', expected_payload_sha256: engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? '' }),
    ).toEqual({ claimed: false });
    expect(
      await engine.claimApprovalAndResume({
        ...base,
        operator_id: '   ',
        expected_payload_sha256: engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? '',
      }),
    ).toEqual({ claimed: false });

    expect((await engine.getTask(TENANT, RUN))?.state).toBe('awaiting_human');
    expect((await engine.getTask(TENANT, RUN))?.task_version).toBe(2);
    expect(engine.listApprovals(TENANT, RUN)[0]?.decision).toBe('PENDING');
  });

  it('stops the task on REJECTED and keeps a PAUSE claimable for a later terminal decision', async () => {
    const { engine, approval_id } = await enginePausedForApproval();
    const digest = engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? 'missing-digest';
    const base = {
      tenant_id: TENANT,
      run_id: RUN,
      approval_id,
      effect_key: ACTION.effect_key,
      expected_payload_sha256: digest,
      authorized_action: null,
      operator_id: 'operator_1',
      review_comment: null,
    };

    expect(await engine.claimApprovalAndResume({ ...base, decision: 'PAUSE' })).toEqual({ claimed: true });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('awaiting_human');
    expect(engine.listApprovals(TENANT, RUN)[0]?.is_paused).toBe(true);
    expect(await engine.claimApprovalAndResume({ ...base, decision: 'PAUSE' })).toEqual({ claimed: false });

    expect(await engine.claimApprovalAndResume({ ...base, decision: 'APPROVED' })).toEqual({ claimed: true });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('running');
    expect(engine.listApprovals(TENANT, RUN)[0]?.is_paused).toBe(false);

    const second = await enginePausedForApproval();
    expect(
      await second.engine.claimApprovalAndResume({
        tenant_id: TENANT,
        run_id: RUN,
        approval_id: second.approval_id,
        effect_key: ACTION.effect_key,
        expected_payload_sha256: second.engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? '',
        authorized_action: null,
        decision: 'REJECTED',
        operator_id: 'operator_1',
        review_comment: 'Out of policy',
      }),
    ).toEqual({ claimed: true });
    expect((await second.engine.getTask(TENANT, RUN))?.state).toBe('stopped');
  });

  it('persists the authorized revision of a human MODIFY', async () => {
    const { engine, approval_id } = await enginePausedForApproval();
    const digest = engine.listApprovals(TENANT, RUN)[0]?.payload_sha256 ?? 'missing-digest';
    const revised: ActionDraft = {
      ...ACTION,
      action_revision: 1,
      effect_key: 'effect_key_v1',
      payload: { message: 'Your cart is waiting', discount_percent: 5 },
    };

    expect(
      await engine.claimApprovalAndResume({
        tenant_id: TENANT,
        run_id: RUN,
        approval_id,
        effect_key: ACTION.effect_key,
        expected_payload_sha256: digest,
        authorized_action: revised,
        decision: 'MODIFIED',
        operator_id: 'operator_1',
        review_comment: 'Discount capped at 5%',
      }),
    ).toEqual({ claimed: true });

    expect(engine.listApprovals(TENANT, RUN)[0]?.effect_key).toBe('effect_key_v1');
    expect(engine.listApprovals(TENANT, RUN)[0]?.decision).toBe('MODIFIED');
    expect((await engine.getTask(TENANT, RUN))?.state_payload?.pending_action?.effect_key).toBe(
      'effect_key_v1',
    );
  });
});

describe('MemoryWorkflowEngine failures', () => {
  it('re-queues three RETRYABLE retries after the first attempt, then fails terminally', async () => {
    const engine = await engineWithRunningTask();
    const failure = {
      tenant_id: TENANT,
      run_id: RUN,
      error_class: 'RETRYABLE' as PersistedErrorClass,
      error_details: { code: 'PROVIDER_UNAVAILABLE' },
    };

    // retry_count 0, 1 and 2 are below the budget of 3, so each re-queues the task (§4.4).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await engine.recordFailure(failure)).toEqual({ requeued: true });
      expect((await engine.getTask(TENANT, RUN))?.state).toBe('queued');
      await engine.transitionTask(TENANT, RUN, 'running', 'task.claim');
    }

    // retry_count is now 3 >= max_retries: the next RETRYABLE failure is terminal (§4.1 matrix).
    expect(await engine.recordFailure(failure)).toEqual({ requeued: false });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('failed');
  });

  it('fails the task immediately on FATAL and refuses the UNKNOWN class', async () => {
    const engine = await engineWithRunningTask();
    expect(
      await engine.recordFailure({
        tenant_id: TENANT,
        run_id: RUN,
        error_class: 'FATAL',
        error_details: { code: 'P_FLOOR_UNAVAILABLE' },
      }),
    ).toEqual({ requeued: false });
    expect((await engine.getTask(TENANT, RUN))?.state).toBe('failed');

    const untyped = await engineWithRunningTask(OTHER_RUN);
    await expect(
      untyped.recordFailure({
        tenant_id: TENANT,
        run_id: OTHER_RUN,
        error_class: 'UNKNOWN' as PersistedErrorClass,
        error_details: { code: 'DISPATCH_TIMEOUT', outcome: 'UNKNOWN' },
      }),
    ).rejects.toThrow(OrchestratorError);
    expect((await untyped.getTask(TENANT, OTHER_RUN))?.state).toBe('running');

    expect(
      await untyped.recordFailure({
        tenant_id: OTHER_TENANT,
        run_id: OTHER_RUN,
        error_class: 'RETRYABLE',
        error_details: {},
      }),
    ).toEqual({ requeued: false });
  });
});

describe('MemoryLeaseManager', () => {
  it('refuses a live lease held by another worker and releases only for its owner', async () => {
    const leases = new MemoryLeaseManager();

    expect(await leases.acquireLease(TENANT, RUN, 'worker_a')).toBe(true);
    expect(await leases.acquireLease(TENANT, RUN, 'worker_b')).toBe(false);
    expect(await leases.acquireLease(OTHER_TENANT, RUN, 'worker_b')).toBe(true);
    expect(await leases.acquireLease(TENANT, RUN, 'worker_a')).toBe(true);

    await leases.releaseLease(TENANT, RUN, 'worker_b');
    expect(await leases.acquireLease(TENANT, RUN, 'worker_b')).toBe(false);

    await leases.releaseLease(TENANT, RUN, 'worker_a');
    expect(await leases.acquireLease(TENANT, RUN, 'worker_b')).toBe(true);
  });

  it('lets another worker reclaim an expired lease', async () => {
    let nowMs = 1_700_000_000_000;
    const leases = new MemoryLeaseManager({ now: () => nowMs, lease_ttl_ms: 1000 });

    expect(await leases.acquireLease(TENANT, RUN, 'worker_a')).toBe(true);
    nowMs += 1001;
    expect(await leases.acquireLease(TENANT, RUN, 'worker_b')).toBe(true);
    expect(await leases.acquireLease(TENANT, RUN, 'worker_a')).toBe(false);
  });
});

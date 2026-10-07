import { describe, expect, it, vi } from 'vitest';

import {
  GENESIS_HASH,
  OrchestratorError,
  type ActionDraft,
  type DurableTaskCheckpoint,
  type DurableTaskSnapshot,
  type ExecutionPlan,
  type ExecutionReceipt,
  type FinalResponse,
  type HydratedContext,
  type HypothesisRecord,
  type IAgentRuntime,
  type IPolicyEngine,
  type IResponseFinalizer,
  type IRunResponseStore,
  type IRunStageRecorder,
  type IStatefulWorkflowEngine,
  type PlannedStep,
  type SignalEnvelope,
  type TaskLifecycleState,
} from '../contracts/index.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { MemoryEvidenceLogger } from '../evidence/evidence-logger.js';
import { MemoryLeaseManager } from '../workflow/memory-lease.js';
import { MemoryWorkflowEngine } from '../workflow/memory-workflow-engine.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = 'final-response-session';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const SIGNAL_ID = 'final-response-signal';
const CORRELATION_ID = 'final-response-correlation';

function signal(): SignalEnvelope {
  return {
    signal_id: SIGNAL_ID,
    tenant_id: TENANT,
    correlation_id: CORRELATION_ID,
    source_channel: 'web',
    event_type: 'product.inquiry',
    payload: { caller_text: 'untrusted caller text' },
    subject: { session_id: SESSION, channel_type: 'web' },
    timestamp: '2026-09-28T00:00:00.000Z',
  };
}

function context(): HydratedContext {
  return {
    correlation_id: CORRELATION_ID,
    tenant_id: TENANT,
    customer: null,
    working_memory: {
      session_id: SESSION,
      conversation_id: CONVERSATION,
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-28T00:00:00.000Z',
  };
}

function step(overrides: Partial<PlannedStep> = {}): PlannedStep {
  return {
    step_index: 1,
    agent_id: 'SAL-01',
    skill_id: 'skill.final-response.test',
    adapter_target: 'web',
    input_parameters: { message: 'caller text is not trusted by the finalizer' },
    required_authority: 'AUTH-1',
    mutating: true,
    price_bearing: false,
    idempotent: true,
    timeout_ms: 1_000,
    ...overrides,
  };
}

function plan(steps: PlannedStep[]): ExecutionPlan {
  return { plan_id: 'final-response-plan', steps, fallback_strategy: 'FAIL_CLOSED' };
}

function receipt(executionId = 'final-response-execution'): ExecutionReceipt {
  return {
    execution_id: executionId,
    adapter_status: 'SUCCESS',
    provider_reference: `provider-${executionId}`,
    response_payload: { verified_fact: `fact-${executionId}`, nested: { sku: 'SKU-VERIFIED' } },
    latency_ms: 1,
    token_usage: { prompt: 3, completion: 5, total_cost_usd: 0 },
  };
}

const finalResponse: FinalResponse = {
  answer: 'Grounded response from verified evidence.',
  sources: [{ source_record_id: 'response-source', source_version: 'v1', source_file: 'approved.md' }],
};

function responseStore() {
  const rows = new Map<string, FinalResponse>();
  const read = vi.fn(async (input: { tenant_id: string; run_id: string }) => (
    rows.get(`${input.tenant_id}:${input.run_id}`) ?? null
  ));
  const save = vi.fn(async (input: {
    tenant_id: string;
    run_id: string;
    conversation_id?: string;
    sender_id: string;
    response: FinalResponse;
  }) => {
    const key = `${input.tenant_id}:${input.run_id}`;
    const existing = rows.get(key);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(input.response)) {
      throw new Error('RESPONSE_CONFLICT');
    }
    rows.set(key, input.response);
  });
  return { store: { read, save } as unknown as IRunResponseStore, read, save, rows };
}

function hypothesis(): HypothesisRecord {
  return {
    classification: 'HYPOTHESIS',
    intent: 'product.inquiry',
    confidence: 1,
    churn_risk_score: 0,
    purchase_propensity: 0,
    reasoning: 'test hypothesis',
    derived_from_signals: [SIGNAL_ID],
  };
}

interface HarnessOptions {
  readonly steps?: PlannedStep[];
  readonly workflow?: IStatefulWorkflowEngine;
  readonly evidenceLogger?: MemoryEvidenceLogger;
  readonly effectGuard?: MemoryEffectGuard;
  readonly dispatch?: (action: ActionDraft) => Promise<ExecutionReceipt>;
  readonly responseFinalizer?: IResponseFinalizer;
  readonly responseStore?: IRunResponseStore;
  readonly runStageRecorder?: IRunStageRecorder;
  readonly policyEngine?: IPolicyEngine;
  readonly deriveHypothesis?: IAgentRuntime['deriveHypothesis'];
  readonly maxRetries?: number;
  readonly context?: HydratedContext;
}

function makeHarness(options: HarnessOptions = {}) {
  const workflow = options.workflow ?? new MemoryWorkflowEngine(
    options.maxRetries === undefined ? {} : { max_retries: options.maxRetries },
  );
  const effectGuard = options.effectGuard ?? new MemoryEffectGuard();
  const evidenceLogger = options.evidenceLogger ?? new MemoryEvidenceLogger('final-response-secret');
  const dispatch = vi.fn(options.dispatch ?? (async () => receipt()));
  const policyEngine = options.policyEngine ?? {
    validateAction: async (action: ActionDraft) => action,
    evaluateAuthority: async (action: ActionDraft) => ({
      verdict: action.required_authority === 'AUTH-4'
        ? 'AWAITING_HUMAN_APPROVAL' as const
        : action.required_authority === 'AUTH-5'
          ? 'DENIED' as const
          : 'AUTO_APPROVED' as const,
      reason: 'test authority',
    }),
  };
  const orchestrator = new RevenueOrchestrator({
    contextAggregator: { hydrateContext: async () => options.context ?? context() },
    agentRuntime: {
      deriveHypothesis: options.deriveHypothesis ?? (async () => hypothesis()),
      resolveRouting: async () => ({
        target_agent: 'SAL-01',
        requires_clarification: false,
        rationalization: 'test routing',
      }),
      formulatePlan: async () => plan(options.steps ?? [step()]),
    },
    policyEngine,
    workflowEngine: workflow,
    evidenceLogger,
    auditTrail: { append: async () => undefined },
    adapterDispatcher: { dispatch },
    effectGuard,
    sessionControl: { isTakenOver: async () => false, returnToAgent: async () => undefined },
    leaseManager: new MemoryLeaseManager(),
    workerId: 'worker-final-response-test',
    ...(options.responseFinalizer === undefined ? {} : { responseFinalizer: options.responseFinalizer }),
    ...(options.responseStore === undefined ? {} : { responseStore: options.responseStore }),
    ...(options.runStageRecorder === undefined ? {} : { runStageRecorder: options.runStageRecorder }),
  });
  return { orchestrator, workflow, evidenceLogger, effectGuard, dispatch };
}

/** A small durable checkpoint fixture with the lease fields required by processQueuedSignal. */
function checkpointWorkflow(checkpoint: DurableTaskCheckpoint, initialState: TaskLifecycleState = 'running') {
  const row = {
    task_version: 4,
    state: initialState,
    correlation_id: CORRELATION_ID,
    state_payload: checkpoint as unknown,
    lease_owner: 'worker-final-response-test' as string | null,
    lease_expires_at: new Date(Date.now() + 30_000).toISOString() as string | null,
  };
  const getTask = vi.fn(async () => ({ ...row }));
  const updateTaskProgress = vi.fn(async (
    _tenantId: string,
    _runId: string,
    _stepIndex: number,
    payload: unknown,
  ) => {
    row.state_payload = {
      ...((row.state_payload !== null && typeof row.state_payload === 'object' && !Array.isArray(row.state_payload))
        ? row.state_payload
        : {}),
      ...(payload as Record<string, unknown>),
    };
    row.task_version += 1;
  });
  const transitionTask = vi.fn(async (
    _tenantId: string,
    _runId: string,
    state: TaskLifecycleState,
    _reason: string,
    payload?: unknown,
  ) => {
    row.state = state;
    if (payload !== undefined) row.state_payload = payload;
    row.task_version += 1;
  });
  const recordFailure = vi.fn(async () => {
    row.state = 'failed';
    row.task_version += 1;
    return { requeued: false };
  });
  const workflow = {
    getTask,
    updateTaskProgress,
    transitionTask,
    recordFailure,
  } as unknown as IStatefulWorkflowEngine;
  return { workflow, row, getTask, updateTaskProgress, transitionTask, recordFailure };
}

function leasedMemoryWorkflow() {
  const memory = new MemoryWorkflowEngine();
  const getTask = vi.fn(async (tenantId: string, runId: string): Promise<DurableTaskSnapshot | null> => {
    const task = await memory.getTask(tenantId, runId);
    return task === null
      ? null
      : {
          ...task,
          lease_owner: 'worker-final-response-test',
          lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
        };
  });
  const transitionTask = vi.fn(
    async (...args: Parameters<IStatefulWorkflowEngine['transitionTask']>) => memory.transitionTask(...args),
  );
  const workflow = {
    createTask: memory.createTask.bind(memory),
    getTask,
    updateTaskProgress: memory.updateTaskProgress.bind(memory),
    transitionTask,
    pauseForApproval: memory.pauseForApproval.bind(memory),
    claimApprovalAndResume: memory.claimApprovalAndResume.bind(memory),
    recordFailure: memory.recordFailure.bind(memory),
  } as unknown as IStatefulWorkflowEngine;
  return { workflow, memory, getTask, transitionTask };
}

describe('RevenueOrchestrator final response boundary', () => {
  it('finalizes the first pass from deterministic immutable receipt provenance', async () => {
    const responses = responseStore();
    const evidenceLogger = new MemoryEvidenceLogger('final-response-test-secret');
    const providerReceipt = receipt('first-pass-receipt');
    const finalizer = vi.fn(async (input: Parameters<IResponseFinalizer['finalize']>[0]) => {
      const verified = input.successful_receipts[0];
      if (verified === undefined) throw new Error('missing verified receipt in test finalizer');
      return {
        answer: `Grounded ${verified.receipt.execution_id}`,
        sources: [{
          source_record_id: verified.evidence.evidence_id,
          source_version: verified.evidence.payload_sha256,
          source_file: 'adapter-receipt.json',
        }],
      };
    });
    const { orchestrator, workflow, dispatch } = makeHarness({
      evidenceLogger,
      dispatch: async () => providerReceipt,
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
    });
    const originalTransition = workflow.transitionTask.bind(workflow);
    const transition = vi.spyOn(workflow, 'transitionTask');
    transition.mockImplementation(async (...args) => {
      if (args[2] === 'completed') expect(responses.save).toHaveBeenCalledTimes(1);
      return originalTransition(args[0], args[1], args[2], args[3], args[4], args[5]);
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(result.response?.answer).toBe('Grounded first-pass-receipt');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(responses.save).toHaveBeenCalledTimes(1);
    const finalizedInput = finalizer.mock.calls[0]?.[0];
    const verified = finalizedInput?.successful_receipts[0];
    expect(verified?.receipt).toEqual(providerReceipt);
    expect(verified?.evidence.receipt).toEqual(providerReceipt);
    expect(verified?.evidence).toMatchObject({
      tenant_id: TENANT,
      run_id: result.run_id,
      step_index: 1,
      previous_evidence_hash: GENESIS_HASH,
    });
    expect(responses.rows.get(`${TENANT}:${result.run_id}`)?.sources[0]?.source_record_id)
      .toBe(verified?.evidence.evidence_id);
    expect(transition).toHaveBeenCalledWith(TENANT, result.run_id, 'completed', 'All plan steps verified');
  });

  it('keeps the historical completion path for a run with no conversation and stores no response', async () => {
    const responses = responseStore();
    const finalizer = vi.fn(async () => finalResponse);
    const { orchestrator, dispatch } = makeHarness({
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
      context: {
        ...context(),
        working_memory: {
          session_id: SESSION,
          last_touch_channel: 'web',
          turn_count: 1,
          takeover_active: false,
        },
      },
    });

    const result = await orchestrator.processSignal(signal());

    expect(result.lifecycle_state).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(finalizer).not.toHaveBeenCalled();
    expect(responses.save).not.toHaveBeenCalled();
    expect(result.response).toBeUndefined();
  });

  it('finalizes a claimed checkpoint whose cursor is already past the last step', async () => {
    const runId = 'run-final-response-past-end';
    const responses = responseStore();
    const evidenceLogger = new MemoryEvidenceLogger('final-response-test-secret');
    const effectGuard = new MemoryEffectGuard();
    const plannedStep = step({ mutating: false });
    const effectKey = effectGuard.computeEffectKey({
      tenant_id: TENANT,
      skill_id: plannedStep.skill_id,
      step_index: plannedStep.step_index,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });
    const evidence = await evidenceLogger.createImmutableRecord({
      run_id: runId,
      tenant_id: TENANT,
      correlation_id: CORRELATION_ID,
      step_index: plannedStep.step_index,
      effect_key: effectKey,
      previous_evidence_hash: GENESIS_HASH,
      payload: { receipt: receipt('past-end-receipt'), action: {}, replayed: false },
    });
    const checkpoint: DurableTaskCheckpoint = {
      signal: signal(),
      plan: plan([plannedStep]),
      current_step: 2,
      pending_action: null,
      context: context(),
      previous_evidence_hash: evidence.chain_hash,
      request_id: SIGNAL_ID,
    };
    const queued = checkpointWorkflow(checkpoint);
    const finalizer = vi.fn(async () => finalResponse);
    const resumedStages: string[] = [];
    const runStageRecorder: IRunStageRecorder = {
      nextAttemptOrdinal: async () => 1,
      append: async ({ stage }) => {
        resumedStages.push(stage);
      },
    };
    const { orchestrator, dispatch } = makeHarness({
      workflow: queued.workflow,
      evidenceLogger,
      effectGuard,
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
      runStageRecorder,
    });

    const result = await orchestrator.processQueuedSignal(runId, signal(), {
      worker_id: 'worker-final-response-test',
    });

    expect(result.lifecycle_state).toBe('completed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(responses.save).toHaveBeenCalledTimes(1);
    expect(resumedStages).toEqual(['OUTCOME', 'LEARNING']);
    expect(queued.transitionTask).toHaveBeenCalledWith(
      TENANT,
      runId,
      'completed',
      'Recovered evidenced plan verified',
    );
  });

  it('resumes remaining plan steps and gives the finalizer every verified step receipt', async () => {
    const runId = 'run-final-response-resumed';
    const responses = responseStore();
    const evidenceLogger = new MemoryEvidenceLogger('final-response-test-secret');
    const effectGuard = new MemoryEffectGuard();
    const firstStep = step({ step_index: 1, skill_id: 'skill.final-response.read', mutating: false });
    const secondStep = step({ step_index: 2, skill_id: 'skill.final-response.send' });
    const firstEffectKey = effectGuard.computeEffectKey({
      tenant_id: TENANT,
      skill_id: firstStep.skill_id,
      step_index: firstStep.step_index,
      action_revision: 0,
      request_id: SIGNAL_ID,
    });
    const firstEvidence = await evidenceLogger.createImmutableRecord({
      run_id: runId,
      tenant_id: TENANT,
      correlation_id: CORRELATION_ID,
      step_index: firstStep.step_index,
      effect_key: firstEffectKey,
      previous_evidence_hash: GENESIS_HASH,
      payload: { receipt: receipt('resumed-first-receipt'), action: {}, replayed: false },
    });
    const checkpoint: DurableTaskCheckpoint = {
      signal: signal(),
      plan: plan([firstStep, secondStep]),
      current_step: 2,
      pending_action: null,
      context: context(),
      previous_evidence_hash: firstEvidence.chain_hash,
      request_id: SIGNAL_ID,
    };
    const queued = checkpointWorkflow(checkpoint);
    const finalizer = vi.fn(async (input: Parameters<IResponseFinalizer['finalize']>[0]) => ({
      answer: input.successful_receipts.map((item) => item.receipt.execution_id).join(','),
      sources: input.successful_receipts.map((item) => ({
        source_record_id: item.evidence.evidence_id,
        source_version: item.evidence.payload_sha256,
        source_file: 'immutable-evidence.json',
      })),
    }));
    const { orchestrator, dispatch } = makeHarness({
      workflow: queued.workflow,
      evidenceLogger,
      effectGuard,
      dispatch: async () => receipt('resumed-second-receipt'),
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
    });

    const result = await orchestrator.processQueuedSignal(runId, signal(), {
      worker_id: 'worker-final-response-test',
    });

    expect(result.lifecycle_state).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(finalizer.mock.calls[0]?.[0].successful_receipts.map((item) => item.receipt.execution_id))
      .toEqual(['resumed-first-receipt', 'resumed-second-receipt']);
    expect(responses.save).toHaveBeenCalledTimes(1);
  });

  it('persists only after an approval resume has completed the released step', async () => {
    const responses = responseStore();
    const finalizer = vi.fn(async () => finalResponse);
    const stageEvents: Parameters<IRunStageRecorder['append']>[0][] = [];
    const runStageRecorder: IRunStageRecorder = {
      nextAttemptOrdinal: async () => Math.max(0, ...stageEvents.map((entry) => entry.attempt_ordinal)) + 1,
      append: async (entry) => {
        if (stageEvents.some((prior) =>
          prior.attempt_ordinal === entry.attempt_ordinal
          && prior.step_index === entry.step_index
          && prior.stage === entry.stage
        )) throw new Error('DUPLICATE_STAGE_ATTEMPT');
        stageEvents.push(entry);
      },
    };
    let authorityChecks = 0;
    const policyEngine: IPolicyEngine = {
      validateAction: async (action) => action,
      evaluateAuthority: vi.fn(async () => {
        authorityChecks += 1;
        return authorityChecks === 1
          ? { verdict: 'AWAITING_HUMAN_APPROVAL' as const, reason: 'human review required' }
          : { verdict: 'AUTO_APPROVED' as const, reason: 'approved after review' };
      }),
    };
    const { orchestrator, workflow, dispatch } = makeHarness({
      steps: [step({ required_authority: 'AUTH-4' })],
      policyEngine,
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
      runStageRecorder,
    });

    const waiting = await orchestrator.processSignal(signal());
    expect(waiting.lifecycle_state).toBe('awaiting_human');
    expect(finalizer).not.toHaveBeenCalled();
    expect(responses.save).not.toHaveBeenCalled();
    const approval = (workflow as MemoryWorkflowEngine).listApprovals(TENANT, waiting.run_id)[0];
    if (approval === undefined) throw new Error('approval was not persisted');

    const completed = await orchestrator.resumeTask(waiting.run_id, {
      tenant_id: TENANT,
      event_type: 'human.approval',
      approval_id: approval.approval_id,
      expected_payload_sha256: approval.payload_sha256,
      operator_id: 'operator-final-response-test',
    });

    expect(completed.lifecycle_state).toBe('completed');
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(responses.save).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(stageEvents.filter((entry) => entry.attempt_ordinal === 1).at(-1)?.stage).toBe('APPROVAL');
    expect(stageEvents.filter((entry) => entry.attempt_ordinal === 2).map((entry) => entry.stage)).toEqual([
      'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING',
    ]);
  });

  it('does not finalize or save an awaiting_human, waiting, stopped, or failed run', async () => {
    const waitingResponses = responseStore();
    const waitingFinalizer = vi.fn(async () => finalResponse);
    const waiting = makeHarness({
      dispatch: async () => {
        throw new OrchestratorError('DISPATCH_TIMEOUT', 'provider deadline elapsed');
      },
      responseFinalizer: { finalize: waitingFinalizer },
      responseStore: waitingResponses.store,
    });
    const waitingResult = await waiting.orchestrator.processSignal(signal());
    expect(waitingResult.lifecycle_state).toBe('waiting');
    expect(waitingFinalizer).not.toHaveBeenCalled();
    expect(waitingResponses.save).not.toHaveBeenCalled();

    const stoppedResponses = responseStore();
    const stoppedFinalizer = vi.fn(async () => finalResponse);
    const stopped = makeHarness({
      steps: [step({ required_authority: 'AUTH-5' })],
      responseFinalizer: { finalize: stoppedFinalizer },
      responseStore: stoppedResponses.store,
    });
    const stoppedResult = await stopped.orchestrator.processSignal(signal());
    expect(stoppedResult.lifecycle_state).toBe('stopped');
    expect(stoppedFinalizer).not.toHaveBeenCalled();
    expect(stoppedResponses.save).not.toHaveBeenCalled();

    const failedResponses = responseStore();
    const failedFinalizer = vi.fn(async () => finalResponse);
    const failedWorkflow = new MemoryWorkflowEngine({ max_retries: 0 });
    const failure = vi.spyOn(failedWorkflow, 'recordFailure');
    const failed = makeHarness({
      workflow: failedWorkflow,
      deriveHypothesis: async () => {
        throw new OrchestratorError('PROVIDER_UNAVAILABLE', 'provider unavailable');
      },
      responseFinalizer: { finalize: failedFinalizer },
      responseStore: failedResponses.store,
    });
    await expect(failed.orchestrator.processSignal(signal())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(failure).toHaveBeenCalledTimes(1);
    const failedRunId = failure.mock.calls[0]?.[0].run_id;
    if (failedRunId === undefined) throw new Error('failed run id was not recorded');
    expect((await failedWorkflow.getTask(TENANT, failedRunId))?.state).toBe('failed');
    expect(failedFinalizer).not.toHaveBeenCalled();
    expect(failedResponses.save).not.toHaveBeenCalled();
  });

  it('replays a response saved before a crash once without redispatching the effect', async () => {
    const responses = responseStore();
    const finalizer = vi.fn(async () => finalResponse);
    const leased = leasedMemoryWorkflow();
    const { orchestrator, dispatch } = makeHarness({
      workflow: leased.workflow,
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
    });
    let crashAfterSave = true;
    leased.transitionTask.mockImplementation(async (...args) => {
      if (args[2] === 'completed' && crashAfterSave) {
        crashAfterSave = false;
        throw new OrchestratorError('PROVIDER_UNAVAILABLE', 'crash after response save');
      }
      return leased.memory.transitionTask(...args);
    });

    await expect(orchestrator.processSignal(signal())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(responses.save).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const runId = leased.transitionTask.mock.calls.find((call) => call[2] === 'completed')?.[1];
    if (runId === undefined) throw new Error('crashed run id was not observed');
    const queued = await leased.getTask(TENANT, runId);
    expect(queued?.state).toBe('queued');

    const replay = await orchestrator.processQueuedSignal(runId, signal(), {
      worker_id: 'worker-final-response-test',
    });

    expect(replay.lifecycle_state).toBe('completed');
    expect(replay.response).toEqual(finalResponse);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(responses.rows.size).toBe(1);
    expect(responses.rows.get(`${TENANT}:${runId}`)).toEqual(finalResponse);

  });

  it('fails closed when a completed checkpoint has no immutable receipt evidence', async () => {
    const runId = 'run-final-response-missing-evidence';
    const responses = responseStore();
    const finalizer = vi.fn(async () => finalResponse);
    const plannedStep = step({ mutating: false });
    const queued = checkpointWorkflow({
      signal: signal(),
      plan: plan([plannedStep]),
      current_step: 2,
      pending_action: null,
      context: context(),
      previous_evidence_hash: GENESIS_HASH,
      request_id: SIGNAL_ID,
    });
    const { orchestrator, dispatch } = makeHarness({
      workflow: queued.workflow,
      responseFinalizer: { finalize: finalizer },
      responseStore: responses.store,
    });

    await expect(orchestrator.processQueuedSignal(runId, signal(), {
      worker_id: 'worker-final-response-test',
    })).rejects.toMatchObject({ code: 'RESPONSE_EVIDENCE_INVALID' });

    expect(dispatch).not.toHaveBeenCalled();
    expect(finalizer).not.toHaveBeenCalled();
    expect(responses.save).not.toHaveBeenCalled();
    expect(queued.recordFailure).toHaveBeenCalledTimes(1);
    expect(queued.transitionTask.mock.calls.some((call) => call[2] === 'completed')).toBe(false);
  });
});

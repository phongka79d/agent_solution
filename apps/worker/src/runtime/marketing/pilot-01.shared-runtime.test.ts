import { describe, expect, it, vi } from 'vitest';
import type { DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';
import type {
  DurableLeaseManager,
  IAuditTrail,
  IEffectGuard,
  IEvidenceLogger,
  ISessionControl,
  IStatefulWorkflowEngine,
  ReservationOutcome,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';

import { processClaimedTask, startWorker } from '../../worker.js';
import {
  PILOT_01_CAMPAIGN_ID,
  PILOT_01_CORRELATION_ID,
  PILOT_01_STAGED_EFFECT_KEY,
} from './pilot-01.fixture.js';
import {
  createMarketingSkillServices,
  type MarketingCommunicationPort,
  type MarketingConsentPort,
} from './skills/index.js';

describe('PILOT-01 through the shared P2 runtime', () => {
  const SHARED_TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const NOW = new Date('2026-03-01T09:00:00.000Z');

  /** Builds the marketing plan payload, applying the omission/override switches the guards need. */
  const buildMarketingPayload = (
    overrides: Record<string, unknown>,
    options: { readonly omit_skill_id?: boolean; readonly omit_segment?: boolean; readonly skill_id?: string },
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = {
      tenant_id: SHARED_TENANT_ID,
      campaign_id: PILOT_01_CAMPAIGN_ID,
      segment_id: 'seg-champions-pilot01',
      channel: 'LINE',
      approved_content_id: 'draft-pilot01-tw-01',
      ...overrides,
    };
    if (options.omit_segment === true) {
      delete input['segment_id'];
    }
    const payload: Record<string, unknown> = {
      module: 'marketing',
      skill_id: options.skill_id ?? 'skill.mkt.dispatch_campaign',
      input,
    };
    if (options.omit_skill_id === true) {
      delete payload['skill_id'];
    }
    return payload;
  };

  const createScenario = (
    inputOverrides: Record<string, unknown> = {},
    scenarioOptions: {
      readonly omit_skill_id?: boolean;
      readonly omit_segment?: boolean;
      readonly skill_id?: string;
    } = {},
  ) => {
    let state_payload: unknown = {};
    let task_version = 1;

    const createTask = vi.fn(async (task: Parameters<IStatefulWorkflowEngine['createTask']>[0]) => {
      if (task.state_payload !== undefined) state_payload = task.state_payload;
    });
    const updateTaskProgress = vi.fn(async (
      _tenant_id: string,
      _run_id: string,
      _step_index: number,
      checkpoint: unknown,
    ) => {
      state_payload = checkpoint;
      task_version += 1;
    });
    const transitionTask = vi.fn(async (
      _tenant_id: string,
      _run_id: string,
      _state: Parameters<IStatefulWorkflowEngine['transitionTask']>[2],
      _reason: string,
      checkpoint?: unknown,
    ) => {
      if (checkpoint !== undefined) state_payload = checkpoint;
      task_version += 1;
    });
    const getTask = vi.fn(async () => ({
      task_version,
      state: 'running' as const,
      correlation_id: PILOT_01_CORRELATION_ID,
      state_payload,
      lease_owner: 'worker-1',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));
    const pauseForApproval = vi.fn(async (
      params: Parameters<IStatefulWorkflowEngine['pauseForApproval']>[0],
    ) => {
      const approval_id = 'appr-pilot01-shared-1';
      state_payload = {
        ...(params.checkpoint as Record<string, unknown>),
        resume_event: undefined,
      };
      task_version += 1;
      return { approval_id };
    });
    const recordFailure = vi.fn(async (
      _params: Parameters<IStatefulWorkflowEngine['recordFailure']>[0],
    ) => ({ requeued: false }));

    const workflowEngine: IStatefulWorkflowEngine = {
      createTask,
      updateTaskProgress,
      transitionTask,
      getTask,
      pauseForApproval,
      claimApprovalAndResume: vi.fn(async () => ({ claimed: false })),
      recordFailure,
      queueHandoffEvidence: vi.fn(async () => ({ queued: false })),
      clearHandoffEvidence: vi.fn(async () => ({ cleared: false })),
    };

    const evidenceLogger: IEvidenceLogger = {
      createImmutableRecord: vi.fn(async (
        params: Parameters<IEvidenceLogger['createImmutableRecord']>[0],
      ) => ({
        evidence_id: 'evidence-pilot01-shared-1',
        run_id: params.run_id,
        tenant_id: params.tenant_id,
        correlation_id: params.correlation_id,
        step_index: params.step_index,
        effect_key: params.effect_key,
        previous_evidence_hash: params.previous_evidence_hash,
        payload_sha256: '0'.repeat(64),
        chain_hash: '1'.repeat(64),
        signature: '2'.repeat(64),
        created_at: NOW.toISOString(),
      })),
      initializeOutcomeWatch: vi.fn(async () => undefined),
      logAgentRun: vi.fn(async () => undefined),
    };
    const auditAppend = vi.fn(async () => undefined);
    const auditTrail: IAuditTrail = {
      append: auditAppend,
    };
    const sessionControl: ISessionControl = {
      isTakenOver: vi.fn(async () => false),
      returnToAgent: vi.fn(async () => undefined),
    };
    const leaseManager: DurableLeaseManager = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
    };

    const effectGuard: IEffectGuard = {
      computeEffectKey: vi.fn(() => PILOT_01_STAGED_EFFECT_KEY),
      computeRequestFingerprint: vi.fn((payload: Record<string, unknown>) => JSON.stringify(payload)),
      reserve: vi.fn(async (): Promise<ReservationOutcome> => ({ kind: 'RESERVED' })),
      resolve: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => ({ outcome: 'SUCCEEDED' as const })),
      reopenForRetry: vi.fn(async () => true),
    };

    // `OutputMktCheckConsent` carries exactly these three fields; the port resolves the tenant
    // and customer from its own input and never echoes extra members back.
    const consent: MarketingConsentPort = {
      checkConsent: async () => ({
        allowed: true,
        consent_timestamp: '2026-03-01T08:00:00.000Z',
        suppression_reason: null,
      }),
    };
    const dispatchCampaign = vi.fn(async () => ({
      dispatch_id: 'disp-pilot01-1',
      recipient_count: 1,
      status: 'ENQUEUED' as const,
      dispatched_at: '2026-03-01T09:00:00.000Z',
    }));
    const communication: MarketingCommunicationPort = {
      resolveAudience: async () => ({
        recipients: ['cust-pilot01-1'],
        consent_verified: true,
      }),
      dispatchCampaign,
    };
    const skillServices = createMarketingSkillServices({
      resolve_correlation_id: async () => PILOT_01_CORRELATION_ID,
      resolve_grant: async () => 'AUTH-3',
      consent,
      communication,
    });

    const signal: SignalEnvelope = {
      signal_id: 'sig-pilot01-shared-runtime-1',
      tenant_id: SHARED_TENANT_ID,
      correlation_id: PILOT_01_CORRELATION_ID,
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      timestamp: '2026-03-01T09:00:00.000Z',
      subject: {
        session_id: 'sess-pilot01-shared-1',
        channel_type: 'LINE',
      },
      payload: buildMarketingPayload(inputOverrides, scenarioOptions),
    };
    const taskRecord = {
      tenant_id: SHARED_TENANT_ID,
      run_id: 'run-pilot01-shared-runtime-1',
      correlation_id: PILOT_01_CORRELATION_ID,
      task_version: 1,
      state: 'queued',
      lease_owner: 'worker-1',
      state_payload: { signal },
    } as DurableTaskRecord;
    state_payload = taskRecord.state_payload;
    const workflowRepository = {
      getTask: vi.fn(async () => ({
        ...taskRecord,
        task_version,
        state_payload,
      })),
      recordFailure: vi.fn(async () => ({ requeued: false })),
      transitionTask: vi.fn(async () => undefined),
      releaseTaskLease: vi.fn(async () => true),
    } as unknown as DurableWorkflowRepository; // The worker repository double only needs its four claimed-task methods.

    const worker = startWorker(
      { ENABLED_AGENT_MODULES: 'marketing' },
      {
        hmac: () => '',
        tenantIds: [SHARED_TENANT_ID],
        autoStartPolling: false,
        marketingFactoryOptions: {
          auditSecret: 'pilot01-audit-secret-000000000000',
          now: () => new Date('2026-03-01T09:00:00.000Z'),
          resolve_grant: async () => 'AUTH-3',
          resolve_correlation_id: async () => PILOT_01_CORRELATION_ID,
          workflowEngine,
          evidenceLogger,
          auditTrail,
          sessionControl,
          leaseManager,
          effectGuard,
          skillServices,
        },
      },
    );

    return {
      worker,
      signal,
      taskRecord,
      workflowRepository,
      workflowEngine,
      pauseForApproval,
      recordFailure,
      dispatchCampaign,
      getStatePayload: () => state_payload,
    };
  };

  it('pauses a PILOT-01 campaign dispatch at the shared AUTH-4 gate without any provider call', async () => {
    const scenario = createScenario();

    await processClaimedTask({
      taskRecord: scenario.taskRecord,
      tenant_id: SHARED_TENANT_ID,
      worker_id: 'worker-1',
      workflowRepository: scenario.workflowRepository,
      registry: scenario.worker.registry,
    });

    expect(scenario.pauseForApproval).toHaveBeenCalledTimes(1);
    const approval = scenario.pauseForApproval.mock.calls[0]![0].approval;
    expect(approval.action_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const checkpoint = scenario.getStatePayload() as Record<string, unknown>;
    const pendingAction = checkpoint.pending_action as Record<string, unknown>;
    expect(pendingAction.mutating).toBe(true);
    expect(pendingAction.skill_id).toBe('skill.mkt.dispatch_campaign');
    expect(scenario.dispatchCampaign).not.toHaveBeenCalled();
    expect(scenario.recordFailure).not.toHaveBeenCalled();

    await scenario.worker.close();
  });

  it('refuses the same PILOT-01 dispatch when the plan carries a promotion claim without authoritative provenance', async () => {
    const scenario = createScenario({ discount_percent: 15 });

    await expect(processClaimedTask({
      taskRecord: scenario.taskRecord,
      tenant_id: SHARED_TENANT_ID,
      worker_id: 'worker-1',
      workflowRepository: scenario.workflowRepository,
      registry: scenario.worker.registry,
    })).rejects.toThrow('PROMOTION_PROVENANCE_REQUIRED');

    expect(scenario.recordFailure).toHaveBeenCalledTimes(1);
    expect(scenario.recordFailure.mock.calls[0]![0].error_details.code).toBe('PROMOTION_PROVENANCE_REQUIRED');
    expect(scenario.dispatchCampaign).not.toHaveBeenCalled();

    await scenario.worker.close();
  });

  it('refuses a segment-less campaign before the AUTH-4 gate', async () => {
    const scenario = createScenario({}, { omit_segment: true });

    await expect(processClaimedTask({
      taskRecord: scenario.taskRecord,
      tenant_id: SHARED_TENANT_ID,
      worker_id: 'worker-1',
      workflowRepository: scenario.workflowRepository,
      registry: scenario.worker.registry,
    })).rejects.toThrow('SEGMENT_REQUIRED');

    expect(scenario.pauseForApproval).not.toHaveBeenCalled();
    expect(scenario.recordFailure).toHaveBeenCalledTimes(1);
    expect(scenario.recordFailure.mock.calls[0]![0].error_details.code).toBe('SEGMENT_REQUIRED');
    expect(scenario.dispatchCampaign).not.toHaveBeenCalled();

    await scenario.worker.close();
  });

  it('fails closed when the marketing signal names no canonical skill', async () => {
    const scenario = createScenario({}, { omit_skill_id: true });

    await expect(processClaimedTask({
      taskRecord: scenario.taskRecord,
      tenant_id: SHARED_TENANT_ID,
      worker_id: 'worker-1',
      workflowRepository: scenario.workflowRepository,
      registry: scenario.worker.registry,
    })).rejects.toThrow('MARKETING_SIGNAL_INVALID');

    expect(scenario.recordFailure).toHaveBeenCalledTimes(1);
    expect(scenario.recordFailure.mock.calls[0]![0].error_details.code).toBe('MARKETING_SIGNAL_INVALID');
    expect(scenario.pauseForApproval).not.toHaveBeenCalled();
    expect(scenario.dispatchCampaign).not.toHaveBeenCalled();

    await scenario.worker.close();
  });

  it('refuses the shared MKT-06 route without an evidence-bound analytics contract', async () => {
    const scenario = createScenario({}, { skill_id: 'skill.mkt.evaluate_attribution' });

    await expect(processClaimedTask({
      taskRecord: scenario.taskRecord,
      tenant_id: SHARED_TENANT_ID,
      worker_id: 'worker-1',
      workflowRepository: scenario.workflowRepository,
      registry: scenario.worker.registry,
    })).rejects.toThrow('MKT06_EVIDENCE_BINDING_REQUIRED');

    expect(scenario.recordFailure).toHaveBeenCalledTimes(1);
    expect(scenario.recordFailure.mock.calls[0]![0].error_details.code).toBe('MKT06_EVIDENCE_BINDING_REQUIRED');
    expect(scenario.pauseForApproval).not.toHaveBeenCalled();
    expect(scenario.dispatchCampaign).not.toHaveBeenCalled();

    await scenario.worker.close();
  });
});

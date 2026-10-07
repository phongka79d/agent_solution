/**
 * TC-E2E-001 worker seam.
 *
 * Drives the shared worker entry (`processClaimedTask` → `DomainRuntimeRegistry` →
 * the domain factory's real `RevenueOrchestrator.processQueuedSignal`). Planning is the
 * domain runtime. Local provider doubles stand in for connectors; they do not replace
 * the orchestrator.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  Customer360Fact,
  DurableLeaseManager,
  ExecutionReceipt,
  HydratedContext,
  IAdapterDispatcher,
  IAuditTrail,
  IContextAggregator,
  IEvidenceLogger,
  ISessionControl,
  IStatefulWorkflowEngine,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import { MemoryEffectGuard, OrchestratorError } from '@agentos/core-engine';
import type { DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';

import { createCrossDomainHandoffBroker } from '../runtime/shared/cross-domain-handoff.js';
import {
  CARE_SIGNAL_CONTRACT,
  CROSS_DOMAIN_HANDOFF_CHANNEL,
  CROSS_DOMAIN_HANDOFF_EVENT_TYPES,
  processClaimedTask,
  startWorker,
} from '../worker.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORRELATION_ID = 'corr-tc-e2e-001';
const WORKER_ID = 'worker-tc-e2e-001';
const AUDIT_SECRET = 'tc-e2e-001-audit-secret-00000000';
const NOW = new Date('2026-09-27T00:00:00.000Z');

const receipt: ExecutionReceipt = {
  execution_id: 'exec-tc-e2e-001',
  adapter_status: 'SUCCESS',
  provider_reference: 'provider-tc-e2e-001',
  response_payload: { source_uri: 'provider://tc-e2e-001', source_version: 'v1' },
  latency_ms: 0,
  token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
};

function customerFact(): Customer360Fact {
  return {
    customer_id: CUSTOMER_ID,
    tenant_id: TENANT_ID,
    verified_phone: null,
    verified_email: null,
    total_spent: 0,
    order_count: 0,
    rfm_segment_hypothesis: 'NEW',
    consent_marketing: true,
    consent_updated_at: null,
    suppression_active: false,
    created_at: NOW.toISOString(),
  };
}

function contextAggregator(): IContextAggregator {
  return {
    async hydrateContext(tenant_id, subject, correlation_id): Promise<HydratedContext> {
      const bound = tenant_id === TENANT_ID
        && subject.verified_customer_id === CUSTOMER_ID;
      return {
        tenant_id,
        correlation_id,
        customer: bound ? customerFact() : null,
        working_memory: {
          session_id: subject.session_id,
          last_touch_channel: subject.channel_type,
          turn_count: 0,
          takeover_active: false,
        },
        knowledge_citations: [],
        hydrated_at: NOW.toISOString(),
      };
    },
  };
}

describe('TC-E2E-001 worker claim seam', () => {
  it('TC-E2E-001 claims marketing→sales→care through processClaimedTask, the shared registry, and RevenueOrchestrator', async () => {
    const tasks = new Map<string, DurableTaskRecord>();
    const evidence: Array<{ run_id: string; correlation_id: string; skill_id?: string }> = [];
    const dispatched: string[] = [];

    const workflowEngine: IStatefulWorkflowEngine = {
      createTask: vi.fn(async (input) => {
        tasks.set(input.run_id, {
          task_id: `task-${input.run_id}`,
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          correlation_id: input.correlation_id,
          task_version: 1,
          state: 'queued',
          lease_owner: WORKER_ID,
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          state_payload: input.state_payload ?? {},
          current_step: input.current_step ?? 0,
          retry_count: 0,
          max_retries: 3,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        } as DurableTaskRecord);
      }),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async (tenant_id, run_id, state, _reason, checkpoint) => {
        const current = tasks.get(run_id);
        if (!current) return;
        tasks.set(run_id, {
          ...current,
          tenant_id,
          state,
          task_version: current.task_version + 1,
          state_payload: (checkpoint ?? current.state_payload) as DurableTaskRecord['state_payload'],
        });
      }),
      getTask: vi.fn(async (_tenant_id, run_id) => tasks.get(run_id) ?? null),
      pauseForApproval: vi.fn(async () => ({ approval_id: 'approval-tc-e2e-001' })),
      claimApprovalAndResume: vi.fn(async () => ({ claimed: false })),
      recordFailure: vi.fn(async () => ({ requeued: false })),
      queueHandoffEvidence: vi.fn(async () => ({ queued: false })),
      clearHandoffEvidence: vi.fn(async () => ({ cleared: false })),
    };

    const evidenceLogger: IEvidenceLogger = {
      createImmutableRecord: vi.fn(async (params) => {
        evidence.push({
          run_id: params.run_id,
          correlation_id: params.correlation_id,
          ...(typeof params.payload?.['skill_id'] === 'string' ? { skill_id: params.payload['skill_id'] } : {}),
        });
        return {
          evidence_id: `evidence-${params.run_id}-${params.step_index}`,
          run_id: params.run_id,
          tenant_id: params.tenant_id,
          correlation_id: params.correlation_id,
          step_index: params.step_index,
          effect_key: params.effect_key,
          previous_evidence_hash: params.previous_evidence_hash,
          payload_sha256: 'a'.repeat(64),
          chain_hash: 'b'.repeat(64),
          signature: 'c'.repeat(64),
          created_at: NOW.toISOString(),
        };
      }),
      initializeOutcomeWatch: vi.fn(async () => undefined),
      logAgentRun: vi.fn(async () => undefined),
    };
    const auditTrail: IAuditTrail = { append: vi.fn(async () => undefined) };
    const sessionControl: ISessionControl = {
      isTakenOver: vi.fn(async () => false),
      returnToAgent: vi.fn(async () => undefined),
    };
    const leaseManager: DurableLeaseManager = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
    };
    const adapterDispatcher: IAdapterDispatcher = {
      dispatch: vi.fn(async (action) => {
        dispatched.push(action.skill_id);
        return receipt;
      }),
      reconcile: vi.fn(async () => ({ outcome: 'INDETERMINATE' as const })),
    };

    const admitted = new Map<string, { handoff_id: string; run_id: string; signal: SignalEnvelope }>();
    const broker = createCrossDomainHandoffBroker({
      handoffRepository: { readCrossDomainLifecycle: vi.fn(async () => null) },
      admit: (async (input: { idempotency_key: string; handoff_id: string; run_id: string; tenant_id: string; correlation_id: string; signal: Record<string, unknown> }) => {
        const prior = admitted.get(input.idempotency_key);
        if (prior) {
          return { kind: 'REPLAY' as const, handoff_id: prior.handoff_id, run_id: prior.run_id, receipt: null };
        }
        const signal = input.signal as unknown as SignalEnvelope;
        admitted.set(input.idempotency_key, {
          handoff_id: input.handoff_id,
          run_id: input.run_id,
          signal,
        });
        tasks.set(input.run_id, {
          task_id: `task-${input.run_id}`,
          tenant_id: input.tenant_id,
          run_id: input.run_id,
          correlation_id: input.correlation_id,
          task_version: 1,
          state: 'queued',
          lease_owner: null,
          lease_expires_at: null,
          state_payload: { signal },
          current_step: 0,
          retry_count: 0,
          max_retries: 3,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        } as DurableTaskRecord);
        return { kind: 'ADMITTED' as const, handoff_id: input.handoff_id, run_id: input.run_id, receipt: null };
      }) as never,
      now: () => NOW,
    });

    const shared = {
      workerId: WORKER_ID,
      auditSecret: AUDIT_SECRET,
      now: () => NOW,
      workflowEngine,
      evidenceLogger,
      auditTrail,
      sessionControl,
      leaseManager,
      effectGuard: new MemoryEffectGuard({ now: () => NOW }),
      contextAggregator: contextAggregator(),
      resolve_grant: async () => 'AUTH-3' as const,
      resolve_correlation_id: async () => CORRELATION_ID,
      crossDomainHandoff: broker,
    };
    const workflowRepository = {
      claimNextQueuedTask: vi.fn(async () => null),
      getTask: vi.fn(async (_tenant: string, runId: string) => tasks.get(runId) ?? null),
      releaseTaskLease: vi.fn(async () => true),
      renewTaskLease: vi.fn(async () => {
        throw new Error('renewTaskLease is not used by this direct processClaimedTask seam');
      }),
      recordFailure: vi.fn(async () => ({ requeued: false })),
      transitionTask: workflowEngine.transitionTask,
    };


    const worker = startWorker(
      {
        ENABLED_AGENT_MODULES: 'support,sales,marketing',
        CROSS_DOMAIN_JOURNEY_ENABLED: 'true',
        SALES_SIGNAL_SOURCE_CHANNELS: `WEB_CHAT,${CROSS_DOMAIN_HANDOFF_CHANNEL}`,
        SALES_SIGNAL_EVENT_TYPES: `message.received,${CROSS_DOMAIN_HANDOFF_EVENT_TYPES.marketing_to_sales}`,
        AUDIT_HMAC_SECRET: AUDIT_SECRET,
        WORKER_TENANT_IDS: TENANT_ID,
      },
      {
        hmac: () => '',
        tenantIds: [TENANT_ID],
        autoStartPolling: false,
        workerId: WORKER_ID,
        workflowRepository: workflowRepository as unknown as DurableWorkflowRepository,
        crossDomainHandoff: broker,
        marketingFactoryOptions: { ...shared, adapterDispatcher },
        salesFactoryOptions: {
          ...shared,
          adapterDispatcher,
          consent: {
            getConsent: async () => ({ consent_marketing: true, suppression_active: false }),
            read: async () => ({ consented: true, suppressed: false }),
          },
        },
        careFactoryOptions: {
          ...shared,
          adapterDispatcher,
          env: { KNOWLEDGE_TENANT_IDS: TENANT_ID },
        },
      },
    );
    const registry = worker.registry;
    expect(registry, worker.blockers?.join('; ')).toBeDefined();

    function claim(runId: string): DurableTaskRecord {
      const task = tasks.get(runId);
      if (!task) throw new Error(`missing durable task ${runId}`);
      const claimed: DurableTaskRecord = {
        ...task,
        state: 'running',
        lease_owner: WORKER_ID,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      tasks.set(runId, claimed);
      return claimed;
    }



    const marketingRun = 'run-tc-e2e-001-marketing';
    const marketingSignal: SignalEnvelope = {
      signal_id: 'sig-tc-e2e-001-marketing',
      tenant_id: TENANT_ID,
      correlation_id: CORRELATION_ID,
      source_channel: 'MARKETING_CAMPAIGN',
      event_type: 'campaign.requested',
      timestamp: NOW.toISOString(),
      subject: {
        session_id: 'sess-tc-e2e-001',
        channel_type: 'MARKETING_CAMPAIGN',
        verified_customer_id: CUSTOMER_ID,
      },
      payload: { module: 'marketing', skill_id: 'skill.mkt.analyze_market_signal' },
    };
    tasks.set(marketingRun, {
      task_id: `task-${marketingRun}`,
      tenant_id: TENANT_ID,
      run_id: marketingRun,
      correlation_id: CORRELATION_ID,
      task_version: 1,
      state: 'queued',
      lease_owner: WORKER_ID,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      state_payload: { signal: marketingSignal },
      current_step: 0,
      retry_count: 0,
      max_retries: 3,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    } as DurableTaskRecord);

    await processClaimedTask({
      taskRecord: tasks.get(marketingRun)!,
      tenant_id: TENANT_ID,
      worker_id: WORKER_ID,
      workflowRepository: workflowRepository as never,
      registry,
    });

    const salesAdmission = [...admitted.values()].find((row) => row.signal.event_type === CROSS_DOMAIN_HANDOFF_EVENT_TYPES.marketing_to_sales);
    expect(salesAdmission, 'marketing leg must admit the sales target through the broker').toBeDefined();
    expect(salesAdmission?.signal.tenant_id).toBe(TENANT_ID);
    expect(salesAdmission?.signal.correlation_id).toBe(CORRELATION_ID);
    expect(salesAdmission?.signal.subject.verified_customer_id).toBe(CUSTOMER_ID);
    expect(salesAdmission?.signal.source_channel).toBe(CROSS_DOMAIN_HANDOFF_CHANNEL);
    expect(salesAdmission?.signal.payload['module']).toBe('sales');

    const admittedBeforeReplay = admitted.size;
    const replay = await broker.admit({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      correlation_id: CORRELATION_ID,
      source_domain: 'marketing',
      source_agent: 'MKT-01',
      source_run_id: marketingRun,
      source_authority: 'AUTH-1',
      target_domain: 'sales',
      target_agent: 'SAL-02',
      reason: 'Marketing leg completed for a verified customer; Sales consultation is the next leg',
      evidence: [{
        classification: 'SIGNAL',
        claim: 'same hop replay',
        source_uri: 'e2e://tc-e2e-001',
        source_version: 'v1',
        verified_by: 'server',
      }],
      occurred_at: NOW.toISOString(),
    });
    expect(replay.admitted).toBe(false);
    expect(replay.handoff_id).toBe(salesAdmission?.handoff_id);
    expect(replay.target_run_id).toBe(salesAdmission?.run_id);
    expect(admitted.size).toBe(admittedBeforeReplay);

    await processClaimedTask({
      taskRecord: claim(salesAdmission!.run_id),
      tenant_id: TENANT_ID,
      worker_id: WORKER_ID,
      workflowRepository: workflowRepository as never,
      registry,
    });
    expect(tasks.get(salesAdmission!.run_id)?.state, JSON.stringify((workflowEngine.transitionTask as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === salesAdmission!.run_id).map((call) => call[3]))).toBe('completed');
    expect(dispatched).toContain('skill.sales.recommend_product');

    expect(
      [...admitted.values()].some((row) => row.signal.event_type === CROSS_DOMAIN_HANDOFF_EVENT_TYPES.sales_to_care),
    ).toBe(false);

    // A caller cannot make Sales emit a leg while the owner itinerary is unbound. Injecting a
    // brokered Care leg is still covered separately: Care must retain its fail-closed refusal.
    const injectedCare = await broker.admit({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      correlation_id: CORRELATION_ID,
      source_domain: 'sales',
      source_agent: 'SAL-02',
      source_run_id: salesAdmission!.run_id,
      source_authority: 'AUTH-1',
      target_domain: 'care',
      target_agent: 'CS-01',
      reason: 'Injected stray Sales→Care leg for refusal coverage',
      evidence: [{
        classification: 'SIGNAL',
        claim: 'injected stray care leg',
        source_uri: 'e2e://tc-e2e-001',
        source_version: 'v1',
        verified_by: 'server',
      }],
      occurred_at: NOW.toISOString(),
    });
    expect(injectedCare.admitted).toBe(true);
    const careRun = injectedCare.target_run_id;
    const careAdmission = [...admitted.values()].find((row) => row.signal.event_type === CROSS_DOMAIN_HANDOFF_EVENT_TYPES.sales_to_care);

    expect(careAdmission, 'an injected Care leg must reach the Care refusal seam').toBeDefined();
    expect(careAdmission?.run_id).toBe(careRun);
    expect(careAdmission?.signal.payload['module']).toBe('support');
    expect(careAdmission?.signal.correlation_id).toBe(CORRELATION_ID);
    expect(careAdmission?.handoff_id).not.toBe(salesAdmission?.handoff_id);
    let careError: unknown;
    try {
      await processClaimedTask({
        taskRecord: claim(careRun),
        tenant_id: TENANT_ID,
        worker_id: WORKER_ID,
        workflowRepository: workflowRepository as never,
        registry,
      });
    } catch (error) {
      careError = error;
    }
    const careReasons = (workflowEngine.transitionTask as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[1] === careRun)
      .map((call) => String(call[3]));
    const careFailures = (workflowEngine.recordFailure as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0]?.run_id === careRun)
      .map((call) => call[0]);
    expect(
      careError instanceof OrchestratorError
        ? careError.code
        : JSON.stringify({
            state: tasks.get(careRun)?.state,
            careReasons,
            careFailures,
            repoFailures: (workflowRepository.recordFailure as ReturnType<typeof vi.fn>).mock.calls,
            signal: tasks.get(careRun)?.state_payload,
          }),
    ).toBe('CARE_ONBOARDING_ITINERARY_UNBOUND');

    const retentionDraft = await broker.admit({
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      correlation_id: CORRELATION_ID,
      source_domain: 'care',
      source_agent: 'CS-01',
      source_run_id: careAdmission!.run_id,
      source_authority: 'AUTH-1',
      target_domain: 'retention',
      target_agent: 'CS-02',
      reason: 'Retention leg claimed through the shared worker registry',
      evidence: [{
        classification: 'SIGNAL',
        claim: 'care leg reached the worker',
        source_uri: 'e2e://tc-e2e-001',
        source_version: 'v1',
        verified_by: 'server',
      }],
      occurred_at: NOW.toISOString(),
    });
    const retention = admitted.get([...admitted.keys()].find((key) => admitted.get(key)?.run_id === retentionDraft.target_run_id)!);
    expect(retention?.signal.event_type).toBe(CROSS_DOMAIN_HANDOFF_EVENT_TYPES.care_to_retention);
    expect(retention?.signal.payload['module']).toBe('support');
    await processClaimedTask({
      taskRecord: claim(retentionDraft.target_run_id),
      tenant_id: TENANT_ID,
      worker_id: WORKER_ID,
      workflowRepository: workflowRepository as never,
      registry,
    });
    expect(dispatched, JSON.stringify({
      dispatched,
      state: tasks.get(retentionDraft.target_run_id)?.state,
      reasons: (workflowEngine.transitionTask as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === retentionDraft.target_run_id).map((call) => call[3]),
      repo: (workflowRepository.recordFailure as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]?.error_details),
    })).toContain('skill.care.analyze_churn_risk');
    expect(dispatched).not.toContain('skill.care.issue_retention_offer');
    expect(tasks.get(retentionDraft.target_run_id)?.state).toBe('completed');

    expect(registry?.accepts({
      ...marketingSignal,
      source_channel: CROSS_DOMAIN_HANDOFF_CHANNEL,
      event_type: 'message.received',
      payload: { module: 'support' },
    }, { tenant_id: TENANT_ID, correlation_id: CORRELATION_ID })).toBeNull();
    expect(CARE_SIGNAL_CONTRACT.module).toBe('support');
    expect(evidence.every((row) => row.correlation_id === CORRELATION_ID)).toBe(true);
    expect(new Set([...admitted.values()].map((row) => row.handoff_id)).size).toBe(admitted.size);

    await worker.close();
  });
});

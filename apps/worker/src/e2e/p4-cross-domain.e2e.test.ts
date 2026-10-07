
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryEffectGuard,
  type RevenueOrchestrator,
} from '@agentos/core-engine';
import type { DurableTaskRecord } from '@agentos/database';
import type { SignalEnvelope } from '@agentos/core-engine/contracts';

import { processClaimedTask } from '../worker.js';
import { createDomainRuntimeRegistry } from '../runtime/domain-registry.js';
import { createMarketingOrchestratorFactory } from '../runtime/marketing/factory.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORRELATION_ID = 'corr-p4-cross-domain-001';
const WORKER_ID = 'worker-p4-e2e';
const NOW = new Date('2026-09-27T00:00:00.000Z');
const AUDIT_SECRET = 'p4-e2e-audit-secret-000000000000';

const receipt = {
  execution_id: 'exec-p4-001',
  adapter_status: 'SUCCESS' as const,
  provider_reference: 'provider-p4-001',
  response_payload: { source_uri: 'provider://p4', source_version: 'v1' },
  latency_ms: 0,
  token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
};


function signalFor(
  module: string,
  eventType: string,
  sourceChannel: string,
  runId: string,
  payload: Record<string, unknown> = {},
  subjectCustomer = CUSTOMER_ID,
): SignalEnvelope {
  return {
    signal_id: `signal-${runId}`,
    tenant_id: TENANT_ID,
    correlation_id: CORRELATION_ID,
    source_channel: sourceChannel,
    event_type: eventType,
    timestamp: NOW.toISOString(),
    subject: {
      session_id: `session-${CUSTOMER_ID}`,
      channel_type: 'orchestrator',
      verified_customer_id: subjectCustomer,
    },
    payload: { module, ...payload },
  } as SignalEnvelope;
}

function taskFor(runId: string, signal: SignalEnvelope): DurableTaskRecord {
  return {
    tenant_id: TENANT_ID,
    run_id: runId,
    correlation_id: CORRELATION_ID,
    task_version: 1,
    state: 'running',
    lease_owner: WORKER_ID,
    state_payload: { signal },
  } as DurableTaskRecord;
}



describe('P4 cross-domain worker e2e', () => {


  it('TC-E2E-009 traces a completed run from Outcome back to the triggering signal', async () => {
    const evidence: Array<{ run_id: string; correlation_id: string }> = [];
    const tasks = new Map<string, DurableTaskRecord>();
    const runId = 'run-trace';
    const signal = signalFor('marketing', 'campaign.requested', 'MARKETING_CAMPAIGN', runId, { skill_id: 'skill.mkt.analyze_market_signal' });
    tasks.set(runId, { ...taskFor(runId, signal), lease_owner: WORKER_ID, lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
    const workflowEngine = {
      createTask: vi.fn(async () => undefined),
      updateTaskProgress: vi.fn(async () => undefined),
      transitionTask: vi.fn(async (_tenant: string, id: string, state: string, _reason: string, checkpoint?: unknown) => {
        const current = tasks.get(id);
        if (!current) return;
        tasks.set(id, { ...current, state: state as DurableTaskRecord['state'], state_payload: (checkpoint ?? current.state_payload) as DurableTaskRecord['state_payload'], task_version: current.task_version + 1 });
      }),
      getTask: vi.fn(async (_tenant: string, id: string) => tasks.get(id) ?? null),
      pauseForApproval: vi.fn(async () => {
        const current = tasks.get(runId);
        if (current) tasks.set(runId, { ...current, state: 'awaiting_human' });
        return { approval_id: 'approval-trace' };
      }),
      claimApprovalAndResume: vi.fn(async () => ({ claimed: false })),
      recordFailure: vi.fn(async () => ({ requeued: false })),
      queueHandoffEvidence: vi.fn(async () => ({ queued: false })),
      clearHandoffEvidence: vi.fn(async () => ({ cleared: false })),
    };
    const evidenceLogger = {
      createImmutableRecord: vi.fn(async (params: { run_id: string; correlation_id: string; step_index: number; effect_key: string; previous_evidence_hash: string; tenant_id: string }) => {
        evidence.push({ run_id: params.run_id, correlation_id: params.correlation_id });
        return { evidence_id: 'evidence-trace', run_id: params.run_id, tenant_id: params.tenant_id, correlation_id: params.correlation_id, step_index: params.step_index, effect_key: params.effect_key, previous_evidence_hash: params.previous_evidence_hash, payload_sha256: 'a'.repeat(64), chain_hash: 'b'.repeat(64), signature: 'c'.repeat(64), created_at: NOW.toISOString() };
      }),
      initializeOutcomeWatch: vi.fn(async () => undefined),
      logAgentRun: vi.fn(async () => undefined),
    };
    let orchestrator: RevenueOrchestrator | undefined;
    const factory = createMarketingOrchestratorFactory({
      auditSecret: AUDIT_SECRET,
      now: () => NOW,
      workflowEngine: workflowEngine as never,
      evidenceLogger: evidenceLogger as never,
      auditTrail: { append: vi.fn(async () => undefined) },
      sessionControl: { isTakenOver: vi.fn(async () => false), returnToAgent: vi.fn(async () => undefined) },
      leaseManager: { acquireLease: vi.fn(async () => true), releaseLease: vi.fn(async () => undefined) },
      effectGuard: new MemoryEffectGuard({ now: () => NOW }),
      adapterDispatcher: { dispatch: vi.fn(async () => receipt), reconcile: vi.fn(async () => ({ outcome: 'INDETERMINATE' as const })) },
      resolve_grant: async () => 'AUTH-3',
      resolve_correlation_id: async () => CORRELATION_ID,
      contextAggregator: { hydrateContext: async (tenant_id: string, subject: { session_id: string }, correlation_id: string) => ({ tenant_id, correlation_id, customer: { customer_id: CUSTOMER_ID, tenant_id, verified_phone: null, verified_email: null, total_spent: 0, order_count: 0, rfm_segment_hypothesis: null, consent_marketing: true, consent_updated_at: null, suppression_active: false, created_at: NOW.toISOString() }, working_memory: { session_id: subject.session_id, turn_count: 0, takeover_active: false }, knowledge_citations: [], hydrated_at: NOW.toISOString() }) } as never,
    });
    const registry = createDomainRuntimeRegistry([{
      contract: { module: 'marketing', source_channels: ['MARKETING_CAMPAIGN'], event_types: ['campaign.requested'], signal_invalid_code: 'MARKETING_SIGNAL_INVALID' },
      createOrchestrator: async (tenant_id: string) => {
        orchestrator = await factory(tenant_id);
        return orchestrator;
      },
    }]);
    await processClaimedTask({
      taskRecord: tasks.get(runId)!,
      tenant_id: TENANT_ID,
      worker_id: WORKER_ID,
      workflowRepository: { getTask: workflowEngine.getTask, releaseTaskLease: vi.fn(async () => true), recordFailure: vi.fn(async () => ({ requeued: false })), transitionTask: workflowEngine.transitionTask } as never,
      registry,
    });
    const stages = orchestrator?.visitedStages ?? [];
    const expected = ['SIGNAL', 'CONTEXT', 'HYPOTHESIS', 'DECISION', 'PLAN', 'ACTION', 'APPROVAL', 'EXECUTION', 'EVIDENCE', 'OUTCOME', 'LEARNING'];
    expect(stages).toEqual(expected);
    expect(tasks.get(runId)?.state).toBe('completed');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((row) => row.run_id === runId && row.correlation_id === signal.correlation_id)).toBe(true);
  });
});

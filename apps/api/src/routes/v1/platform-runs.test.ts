import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime, PlatformDirectoryPort } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerPlatformRunsRoutes } from './platform-runs.js';

const TOKEN = 'platform-runs-token';
const COMPANY_B = '11111111-2222-3333-4444-555555555555';

function buildHarness() {
  const auditRecord = vi.fn(async () => undefined);
  const classifyRetry = vi.fn(async () => ({
    retryable: true as const,
    failure_class: 'RETRYABLE' as const,
    effect_key: 'effect-1',
  }));
  const retry = vi.fn(async () => ({
    run_id: 'run-b',
    lifecycle_state: 'queued',
    task_version: 2,
    correlation_id: 'corr',
  }));
  const reconcile = vi.fn(async () => ({ accepted: true as const, run_id: 'run-b' }));
  const traceDetails = vi.fn(async () => ({
    stages: [{
      stage: 'SIGNAL',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:00.010Z',
      duration_ms: 10,
      agent_code: null,
      skill_id: null,
      summary_key: 'run.stage.signal',
      error_class: null,
      detail: { event_type: 'order.placed' },
      evidence_refs: ['ev-1'],
    }],
    provider_calls: [],
    steps: [{
      step_index: 1,
      agent: 'SA-01',
      skill: 'skill.sales.offer',
      tool_binding: 'shopify.create_order',
      authority: 'AUTH-2',
      autonomy_decision: { planned_authority: 'AUTH-2' },
      execution_status: 'failed',
      effect_key: 'effect-1',
      reservation_status: 'RESERVED',
      receipt_ref: null,
      error_code: 'TIMEOUT',
    }],
    audit_entries: [],
    approvals: [],
    handoffs: [],
    effect_keys: ['effect-1'],
    approval_id: null,
    evidence_refs: ['ev-1'],
  }));
  const runtime = {
    ids: () => 'corr-platform-test',
    audit: { record: auditRecord },
    clock: () => new Date(),
    runs: { classifyRetry, retry, reconcile },
  } as unknown as GatewayRuntime;
  const platform = {
    listTenants: vi.fn(async () => []),
    getTenant: vi.fn(async () => null),
    readiness: vi.fn(async () => null),
    usage: vi.fn(async () => []),
    listRuns: vi.fn(async () => [{
      tenant_id: COMPANY_B,
      display_name: 'Company B',
      run_id: 'run-b',
      domain: 'support',
      current_step: 3,
      state: 'failed',
      failure_class: 'RETRYABLE',
      retry_eligible: true,
      attempts: 1,
      max_retries: 3,
      duration_ms: 1200,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      correlation_id: 'corr',
    }]),
    runDetail: vi.fn(async () => ({
      tenant_id: COMPANY_B,
      display_name: 'Company B',
      run_id: 'run-b',
      domain: 'support',
      correlation_id: 'corr',
      current_step: 3,
      state: 'failed',
      task_version: 2,
      failure_class: 'RETRYABLE',
      retry_eligible: true,
      attempts: 1,
      max_retries: 3,
      lease_expires_at: null,
      duration_ms: 1200,
      stage_event_count: 4,
      evidence_count: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
    })),
    runsSummary: vi.fn(async () => []),
    reconciliationQueue: vi.fn(async () => []),
    companyOverview: vi.fn(async () => null),
    runTraceDetails: traceDetails,
  } as unknown as PlatformDirectoryPort;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformRunsRoutes(app, {
    platform,
    credentials: createCredentialStore({
      operators: [{
        token: TOKEN,
        tenant_id: '99999999-9999-9999-9999-999999999999',
        operator_id: 'platform-operator',
        scope: 'platform',
        permissions: ['platform:admin'],
      }],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, auditRecord, classifyRetry, retry, reconcile, platform, traceDetails };
}

describe('platform run projections and commands', () => {
  it('lists cross-company runs without a tenant binding', async () => {
    const { app, platform } = buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: '/platform/runs?company_id=' + COMPANY_B + '&search=conv-1',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(platform.listRuns).toHaveBeenCalledWith({ tenant_id: COMPANY_B, search: 'conv-1' });
  });

  it('serves an allowlisted platform trace and error hint by company-scoped run id', async () => {
    const { app, platform, traceDetails } = buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: `/platform/companies/${COMPANY_B}/runs/run-b/trace`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(platform.runDetail).toHaveBeenCalledWith(COMPANY_B, 'run-b');
    expect(traceDetails).toHaveBeenCalledWith(COMPANY_B, 'run-b');
    expect(response.json()).toMatchObject({
      run_id: 'run-b',
      correlation_id: 'corr',
      steps: [{
        effect_key: 'effect-1',
        reservation_status: 'RESERVED',
        error_code: 'TIMEOUT',
        error_hint: 'Inspect provider or database health; a bounded retry may succeed.',
      }],
      stages: [{ evidence_refs: ['ev-1'] }],
    });
  });

  it('serves a trace whose successful step carries no error code', async () => {
    const { app, traceDetails } = buildHarness();
    const succeeded = await traceDetails();
    const { error_code: _omitted, ...step } = succeeded.steps[0]!;
    traceDetails.mockResolvedValueOnce({ ...succeeded, steps: [{ ...step, execution_status: 'success' }] } as never);

    const response = await app.inject({
      method: 'GET',
      url: `/platform/companies/${COMPANY_B}/runs/run-b/trace`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().steps[0]).toMatchObject({ execution_status: 'success', error_hint: null });
  });


  it('retries a company B run in the target tenant context and audits actor + target', async () => {
    const { app, retry, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/runs/run-b/retry`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: 'transient provider fault' },
    });
    expect(response.statusCode).toBe(202);
    expect(retry).toHaveBeenCalledWith({
      tenant_id: COMPANY_B,
      run_id: 'run-b',
      operator_id: 'platform-operator',
      reason: 'transient provider fault',
    });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: COMPANY_B,
      operation: 'platform.runs.retry',
      operator_id: 'platform-operator',
      detail: expect.objectContaining({ target_tenant: COMPANY_B, run_id: 'run-b' }),
    }));
  });

  it('refuses a blind retry of an indeterminate run', async () => {
    const harness = buildHarness();
    harness.classifyRetry.mockResolvedValue({ retryable: false, reason: 'UNKNOWN' } as never);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/runs/run-b/retry`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(harness.retry).not.toHaveBeenCalled();
  });

  it('reconciles an indeterminate run under the target tenant', async () => {
    const { app, reconcile, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/runs/run-b/reconcile`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { resolution: 'PROVIDER_CONFIRMED_SUCCEEDED', reason: 'provider receipt checked' },
    });
    expect(response.statusCode).toBe(202);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: COMPANY_B,
      run_id: 'run-b',
      resolution: 'PROVIDER_CONFIRMED_SUCCEEDED',
      operator_id: 'platform-operator',
    }));
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'platform.runs.reconciliation',
      detail: expect.objectContaining({ target_tenant: COMPANY_B }),
    }));
  });
});

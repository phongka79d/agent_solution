import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import {
  registerDemoReadinessRoutes,
  type DemoReadinessSnapshot,
  type DemoReadinessRouteDependencies,
} from './demo-readiness.js';

const TENANT = '99999999-9999-4999-8999-999999999999';
const OTHER_TENANT = '88888888-8888-4888-8888-888888888888';
const ADMIN_TOKEN = 'platform-admin-token';
const RUN_READER_TOKEN = 'run-reader-token';
const OTHER_TENANT_RUN_READER_TOKEN = 'other-tenant-run-reader-token';
const COMPANY_OPERATOR_TOKEN = 'company-operator-token';
const TENANT_OPERATOR_TOKEN = 'tenant-operator-token';
const SESSION_TOKEN = 'widget-session-token';
const RUN_ID = 'run-demo-001';

function snapshot(): DemoReadinessSnapshot {
  return {
    observed_at: '2026-09-28T00:00:00.000Z',
    provider: {
      provider: 'openai-compatible',
      configured: true,
      probe: 'PASS',
      models: [
        { model: 'reasoning-demo', configured: true, probe: 'PASS' },
        { model: 'fast-demo', configured: true, probe: 'PASS' },
      ],
    },
    connectors: {
      erp: { class: 'DEMO_MOCK', probe: 'PASS' },
      events: { class: 'LIVE', probe: 'PASS' },
    },
    ledger: {
      status: 'OBSERVED',
      stage_event_count: 11,
      provider_call_count: 2,
    },
  };
}

function buildHarness(options?: {
  demoMode?: boolean;
  readinessSnapshot?: DemoReadinessSnapshot;
  runRead?: (input: { tenant_id: string; run_id: string }) => Promise<unknown>;
}) {
  const readiness = vi.fn(async () => options?.readinessSnapshot ?? snapshot());
  const listStageEvents = vi.fn(async () => [
    {
      tenant_id: TENANT,
      run_id: RUN_ID,
      attempt_ordinal: 1,
      step_index: 0,
      stage: 'HYPOTHESIS' as const,
      detail: { prompt: 'do not expose this', secret: 'provider-key' },
      evidence_refs: [{ email: 'customer@example.test' }],
      entered_at: '2026-09-28T00:00:01.000Z',
    },
  ]);
  const listProviderCalls = vi.fn(async () => [
    {
      tenant_id: TENANT,
      run_id: RUN_ID,
      step_index: 0,
      stage: 'HYPOTHESIS' as const,
      call_index: 0,
      provider: 'openai-compatible',
      model: 'reasoning-demo',
      observed_status: 'SUCCESS',
      latency_ms: 42,
      prompt_tokens: 12,
      completion_tokens: 8,
      cached_tokens: null,
      estimated_cost_amount: '0.01',
      currency: 'USD',
      cost_status: 'KNOWN',
      recorded_at: '2026-09-28T00:00:02.000Z',
      prompt: 'must not be returned',
      response: 'must not be returned',
      secret: 'must not be returned',
    } as never,
  ]);
  const auditRecord = vi.fn(async () => undefined);
  const runRead = vi.fn(
    options?.runRead ??
      (async () => ({
        run_id: RUN_ID,
        task_version: 1,
        lifecycle_state: 'completed',
        correlation_id: 'correlation-demo-001',
      })),
  );
  const runtime = {
    runs: { read: runRead },
    audit: { record: auditRecord },
    ids: () => 'correlation-test',
  } as unknown as GatewayRuntime;

  const deps: DemoReadinessRouteDependencies = {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: ADMIN_TOKEN,
          tenant_id: TENANT,
          operator_id: 'platform-admin',
          scope: 'platform',
          permissions: ['platform:admin', 'run:read'],
        },
        {
          token: RUN_READER_TOKEN,
          tenant_id: TENANT,
          operator_id: 'run-reader',
          scope: 'platform',
          permissions: ['run:read'],
        },
        {
          token: OTHER_TENANT_RUN_READER_TOKEN,
          tenant_id: OTHER_TENANT,
          operator_id: 'other-tenant-run-reader',
          scope: 'platform',
          permissions: ['run:read'],
        },
        {
          token: COMPANY_OPERATOR_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['platform:admin', 'run:read'],
        },
        {
          token: TENANT_OPERATOR_TOKEN,
          tenant_id: TENANT,
          operator_id: 'tenant-operator',
          scope: 'company',
          permissions: ['campaign:draft'],
        },
      ],
      sessions: [
        {
          token: SESSION_TOKEN,
          tenant_id: TENANT,
          conversation_id: 'conversation-demo',
          session_id: 'session-demo',
          channel: 'WEB_CHAT',
        },
      ],
      widgets: [],
    }),
    demoMode: options?.demoMode ?? true,
    readiness: { snapshot: readiness },
    trace: { listStageEvents, listProviderCalls },
  };

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerDemoReadinessRoutes(app, deps);

  return { app, auditRecord, listProviderCalls, listStageEvents, readiness, runRead };
}

describe('GET /demo/readiness', () => {
  it('returns observed provider, connector and ledger state without source secrets', async () => {
    const { app, readiness } = buildHarness({
      readinessSnapshot: {
        ...snapshot(),
        provider: {
          ...snapshot().provider,
          api_key: 'must-not-leak',
          base_url: 'https://provider.invalid/v1',
        } as never,
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/demo/readiness',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        demo_mode: true,
        observed_at: '2026-09-28T00:00:00.000Z',
        provider: {
          provider: 'openai-compatible',
          configured: true,
          probe: 'PASS',
          models: [
            { model: 'reasoning-demo', configured: true, probe: 'PASS' },
            { model: 'fast-demo', configured: true, probe: 'PASS' },
          ],
        },
        connectors: {
          erp: { class: 'DEMO_MOCK', probe: 'PASS' },
          events: { class: 'LIVE', probe: 'PASS' },
        },
        ledger: {
          status: 'OBSERVED',
          stage_event_count: 11,
          provider_call_count: 2,
        },
      });
      expect(JSON.stringify(response.json())).not.toContain('must-not-leak');
      expect(readiness).toHaveBeenCalledWith({ tenant_id: TENANT });
    } finally {
      await app.close();
    }
  });

  it('fails closed when DEMO_MODE is disabled and does not query readiness', async () => {
    const { app, readiness } = buildHarness({ demoMode: false });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/demo/readiness',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('CAPABILITY_NOT_ENABLED');
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns explicit unavailable ledger counts instead of inventing zeros', async () => {
    const { app } = buildHarness({
      readinessSnapshot: {
        ...snapshot(),
        ledger: { status: 'UNAVAILABLE', stage_event_count: 999, provider_call_count: 999 },
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/demo/readiness',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ledger).toEqual({
        status: 'UNAVAILABLE',
        stage_event_count: null,
        provider_call_count: null,
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a tenant operator without platform:admin', async () => {
    const { app, readiness } = buildHarness();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/demo/readiness',
        headers: { authorization: `Bearer ${TENANT_OPERATOR_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rejects a company-scoped operator with platform:admin', async () => {
    const { app, readiness } = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/demo/readiness',
        headers: { authorization: `Bearer ${COMPANY_OPERATOR_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(readiness).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

});

describe('GET /demo/readiness/runs/:run_id/trace', () => {
  it('allows run:read and redacts stage details, evidence values and provider payloads', async () => {
    const { app, listProviderCalls, listStageEvents, runRead } = buildHarness();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/demo/readiness/runs/${RUN_ID}/trace`,
        headers: { authorization: `Bearer ${RUN_READER_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        run_id: RUN_ID,
        lifecycle_state: 'completed',
        stages: [
          {
            attempt_ordinal: 1,
            step_index: 0,
            stage: 'HYPOTHESIS',
            entered_at: '2026-09-28T00:00:01.000Z',
            evidence_ref_count: 1,
          },
        ],
        provider_calls: [
          {
            step_index: 0,
            stage: 'HYPOTHESIS',
            call_index: 0,
            provider: 'openai-compatible',
            model: 'reasoning-demo',
            status: 'SUCCESS',
            latency_ms: 42,
            prompt_tokens: 12,
            completion_tokens: 8,
            cached_tokens: null,
            recorded_at: '2026-09-28T00:00:02.000Z',
          },
        ],
        observed_counts: { stage_events: 1, provider_calls: 1 },
      });
      const body = JSON.stringify(response.json());
      expect(body).not.toContain('do not expose this');
      expect(body).not.toContain('customer@example.test');
      expect(body).not.toContain('provider-key');
      expect(body).not.toContain('must not be returned');
      expect(body).not.toContain('0.01');
      expect(runRead).toHaveBeenCalledWith({ tenant_id: TENANT, run_id: RUN_ID });
      expect(listStageEvents).toHaveBeenCalledWith(TENANT, RUN_ID);
      expect(listProviderCalls).toHaveBeenCalledWith(TENANT, RUN_ID);
    } finally {
      await app.close();
    }
  });

  it('returns not-found for a run owned by another tenant and never reads trace rows', async () => {
    const { app, listProviderCalls, listStageEvents, runRead } = buildHarness({
      runRead: async (input) => {
        expect(input.tenant_id).toBe(OTHER_TENANT);
        expect(input.run_id).toBe(RUN_ID);
        return null;
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/demo/readiness/runs/${RUN_ID}/trace`,
        headers: { authorization: `Bearer ${OTHER_TENANT_RUN_READER_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error_code).toBe('TASK_NOT_FOUND');
      expect(runRead).toHaveBeenCalledWith({ tenant_id: OTHER_TENANT, run_id: RUN_ID });
      expect(listStageEvents).not.toHaveBeenCalled();
      expect(listProviderCalls).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not allow a widget or session principal to read a run trace', async () => {
    const { app, runRead } = buildHarness();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/demo/readiness/runs/${RUN_ID}/trace`,
        headers: {
          authorization: `Bearer ${SESSION_TOKEN}`,
          origin: 'https://demo.invalid',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(runRead).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a company-scoped operator with run:read', async () => {
    const { app, runRead } = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/demo/readiness/runs/${RUN_ID}/trace`,
        headers: { authorization: `Bearer ${COMPANY_OPERATOR_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(runRead).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

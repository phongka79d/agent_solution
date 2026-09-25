import { describe, expect, it } from 'vitest';
import { RevenueOrchestrator } from '@agentos/core-engine';
import type {
  DurableLeaseManager,
  IAdapterDispatcher,
  IAgentRuntime,
  IAuditTrail,
  IContextAggregator,
  IEffectGuard,
  IEvidenceLogger,
  IPolicyEngine,
  ISessionControl,
  IStatefulWorkflowEngine,
} from '@agentos/core-engine/contracts';
import type { TenantTransactionRunner } from '@agentos/database';

import {
  createCareOrchestratorFactory,
  defaultResolveCorrelationId,
  defaultResolveGrant,
  getUnboundCapabilities,
  type CareOrchestratorFactoryOptions,
} from './factory.js';

describe('createCareOrchestratorFactory', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';
  const testAuditSecret = 'test_audit_hmac_secret_key_32_characters_long!';

  const mockAdapters = {
    workflowEngine: {} as IStatefulWorkflowEngine,
    evidenceLogger: {} as IEvidenceLogger,
    auditTrail: {} as IAuditTrail,
    sessionControl: {} as ISessionControl,
    leaseManager: {} as DurableLeaseManager,
  };

  const mockDispatcher: IAdapterDispatcher = {
    dispatch: async () => ({
      execution_id: 'exec-1',
      adapter_status: 'SUCCESS',
      provider_reference: null,
      response_payload: {},
      latency_ms: 10,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    }),
  };

  it('assembles and returns a RevenueOrchestrator when all ports are bound', async () => {
    const factory = createCareOrchestratorFactory({
      workerId: 'test-worker-1',
      contextAggregator: {} as IContextAggregator,
      agentRuntime: {} as IAgentRuntime,
      policyEngine: {} as IPolicyEngine,
      effectGuard: {} as IEffectGuard,
      adapterDispatcher: mockDispatcher,
      adapters: mockAdapters,
      auditSecret: testAuditSecret,
    });

    const orchestrator = await factory(tenant_id);
    expect(orchestrator).toBeInstanceOf(RevenueOrchestrator);
  });

  it('refuses construction with CARE_AUDIT_SECRET_REQUIRED when audit secret is missing', () => {
    const origSecret = process.env.AUDIT_HMAC_SECRET;
    try {
      delete process.env.AUDIT_HMAC_SECRET;
      expect(() =>
        createCareOrchestratorFactory({
          auditSecret: undefined,
          contextAggregator: {} as IContextAggregator,
          agentRuntime: {} as IAgentRuntime,
          policyEngine: {} as IPolicyEngine,
          adapterDispatcher: mockDispatcher,
          adapters: mockAdapters,
        }),
      ).toThrow('CARE_AUDIT_SECRET_REQUIRED');
    } finally {
      if (origSecret !== undefined) {
        process.env.AUDIT_HMAC_SECRET = origSecret;
      }
    }
  });

  it('defaultResolveGrant returns null when agent row is absent (never synthesizes authority)', async () => {
    const mockRunner: TenantTransactionRunner = async (_tenantId, fn) => {
      const mockClient = {
        query: async () => ({ rows: [] }),
      } as unknown as Parameters<Parameters<TenantTransactionRunner>[1]>[0];
      return fn(mockClient);
    };

    const grant = await defaultResolveGrant(tenant_id, 'CS-01', mockRunner);
    expect(grant).toBeNull();
  });

  it('defaultResolveGrant returns assigned_authority when row exists in agentos.agents', async () => {
    const mockRunner: TenantTransactionRunner = async (_tenantId, fn) => {
      const mockClient = {
        query: async () => ({ rows: [{ assigned_authority: 'AUTH-2' }] }),
      } as unknown as Parameters<Parameters<TenantTransactionRunner>[1]>[0];
      return fn(mockClient);
    };

    const grant = await defaultResolveGrant(tenant_id, 'CS-01', mockRunner);
    expect(grant).toBe('AUTH-2');
  });

  it('defaultResolveCorrelationId throws CARE_CORRELATION_REQUIRED when durable task is absent', async () => {
    const mockRepo = {
      getTask: async () => null,
    };

    await expect(defaultResolveCorrelationId(tenant_id, 'run-missing', mockRepo)).rejects.toThrow(
      'CARE_CORRELATION_REQUIRED',
    );
  });

  it('defaultResolveCorrelationId returns correlation_id when durable task exists', async () => {
    const mockRepo = {
      getTask: async () => ({ correlation_id: 'corr-real-999' }),
    };

    const corrId = await defaultResolveCorrelationId(tenant_id, 'run-123', mockRepo);
    expect(corrId).toBe('corr-real-999');
  });

  it('reports unbound capabilities when erp_read or adapters are unbound', () => {
    const options: CareOrchestratorFactoryOptions = {
      erp_read: null,
      adapters: {
        unbound: ['leaseManager'],
      },
    };

    const unbound = getUnboundCapabilities(options);
    expect(unbound).toContain('API-001 (ERP read port is not bound)');
    expect(unbound).toContain('leaseManager');
    expect(unbound.some((capability) => capability.startsWith('PostgreSQL.CaseManagementStore:'))).toBe(false);
  });

  it('reports missing case SLA only when manage_case is explicitly enabled', () => {
    const unbound = getUnboundCapabilities({
      skill_enablement: { enabled_skill_ids: ['skill.care.manage_case'] },
    });

    expect(unbound.some((capability) => capability.startsWith('PostgreSQL.CaseManagementStore:'))).toBe(true);
  });

  it('fails closed when required workflow adapters are missing', async () => {
    const factory = createCareOrchestratorFactory({
      workerId: 'test-worker-2',
      contextAggregator: {} as IContextAggregator,
      agentRuntime: {} as IAgentRuntime,
      policyEngine: {} as IPolicyEngine,
      adapterDispatcher: mockDispatcher,
      // Deliberately empty adapters
      adapters: {},
      auditSecret: testAuditSecret,
    });

    // The factory returns an async function; calling it fails closed
    await expect(factory(tenant_id)).rejects.toThrow('CARE_ORCHESTRATOR_UNBOUND');
  });
});

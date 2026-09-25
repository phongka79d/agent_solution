import { describe, expect, it, vi } from 'vitest';
import { RevenueOrchestrator, type PolicyAuditRecord } from '@agentos/core-engine';
import type {
  ActionDraft,
  DurableLeaseManager,
  HydratedContext,
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
  createCarePolicyEngine,
  defaultResolveCorrelationId,
  defaultResolveGrant,
  getUnboundCapabilities,
  mapPolicyAuditRecordToAuditInput,
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

  describe('policy audit binding regression (BR-010)', () => {
    const createEscalateAction = (): ActionDraft => ({
      action_id: '00000000-0000-4000-8000-000000000099',
      run_id: 'run-escalate-1',
      tenant_id,
      agent_id: 'CS-01',
      skill_id: 'skill.care.escalate_to_human',
      adapter_target: 'ADPT-CARE-001',
      step_index: 0,
      mutating: true,
      price_bearing: false,
      request_id: 'req-escalate-1',
      action_revision: 0,
      effect_key: 'eff-escalate-1',
      required_authority: 'AUTH-3',
      payload: {
        tenant_id,
        session_id: 'sess-1',
        conversation_id: 'conv-1',
        customer_id: 'cust-42',
        escalation_reason: 'customer_complaint',
        summary_context: 'Deterministic Customer Care classification: complaint.',
        effect_key: 'eff-escalate-1',
      },
    });

    const createHydratedContext = (): HydratedContext => ({
      correlation_id: 'corr-escalate-1',
      tenant_id,
      customer: {
        customer_id: 'cust-42',
        tenant_id,
        verified_phone: '+15551234567',
        verified_email: 'customer@example.com',
        total_spent: 200,
        order_count: 2,
        rfm_segment_hypothesis: 'REGULAR',
        consent_marketing: true,
        consent_updated_at: '2026-09-01T00:00:00Z',
        suppression_active: false,
        created_at: '2026-09-01T00:00:00Z',
      },
      working_memory: {
        session_id: 'sess-1',
        last_touch_channel: 'web',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: '2026-09-01T00:00:00Z',
    });
    interface OrchestratorInternals {
      readonly dependencies: {
        readonly policyEngine: IPolicyEngine;
      };
    }

    const getOrchestratorPolicyEngine = (orchestrator: RevenueOrchestrator): IPolicyEngine => {
      const internals = orchestrator as unknown as OrchestratorInternals;
      return internals.dependencies.policyEngine;
    };


    it('mapPolicyAuditRecordToAuditInput maps decision intent preserving required bindings', () => {
      const auditRecord: PolicyAuditRecord = {
        tenant_id,
        run_id: 'run-100',
        correlation_id: 'corr-100',
        agent_id: 'CS-01',
        skill_id: 'skill.care.escalate_to_human',
        tool_name: 'ADPT-CARE-001',
        authority: 'AUTH-3',
        verdict: 'AUTO_APPROVED',
        decision_code: 'PERMIT',
        rule_id: 'BR-010',
        error_code: null,
        approval_id: null,
        effect_key: 'eff-100',
        payload_sha256: 'a'.repeat(64),
        occurred_at: '2026-09-25T12:00:00.000Z',
      };

      const mapped = mapPolicyAuditRecordToAuditInput(auditRecord);
      expect(mapped.tenant_id).toBe(tenant_id);
      expect(mapped.run_id).toBe('run-100');
      expect(mapped.customer_or_entity_id).toBe('corr-100');
      expect(mapped.agent_id).toBe('CS-01');
      expect(mapped.skill).toBe('skill.care.escalate_to_human');
      expect(mapped.tool).toBe('ADPT-CARE-001');
      expect(mapped.authority).toBe('AUTH-3');
      expect(mapped.execution_status).toBe('pending');
      expect(mapped.action).toEqual({
        tool_name: 'ADPT-CARE-001',
        skill_id: 'skill.care.escalate_to_human',
        payload_sha256: 'a'.repeat(64),
        effect_key: 'eff-100',
      });
      expect(mapped.context).toMatchObject({
        correlation_id: 'corr-100',
        payload_sha256: 'a'.repeat(64),
      });
      expect(mapped.evidence).toMatchObject({
        payload_sha256: 'a'.repeat(64),
      });
      expect(mapped.timestamp).toBe('2026-09-25T12:00:00.000Z');
      expect(mapped.latency_ms).toBe(0);
      expect(mapped.step_index).toBe(0);

      const deniedRecord: PolicyAuditRecord = {
        ...auditRecord,
        verdict: 'DENIED',
        decision_code: 'DENY_PROHIBITED',
      };
      const deniedMapped = mapPolicyAuditRecordToAuditInput(deniedRecord);
      expect(deniedMapped.execution_status).toBe('denied');
      expect(deniedMapped.action).toMatchObject({
        effect_key: 'eff-100',
      });

      const nonMutatingRecord: PolicyAuditRecord = {
        ...auditRecord,
        effect_key: null,
      };
      const nonMutatingMapped = mapPolicyAuditRecordToAuditInput(nonMutatingRecord);
      expect(nonMutatingMapped.action).toEqual({
        tool_name: 'ADPT-CARE-001',
        skill_id: 'skill.care.escalate_to_human',
        payload_sha256: 'a'.repeat(64),
        effect_key: null,
      });
      expect(nonMutatingMapped.evidence).toEqual({
        payload_sha256: 'a'.repeat(64),
        rule_id: 'BR-010',
        error_code: null,
      });
    });
    it('proves a mutating escalation with the configured audit sink is not denied solely for EVIDENCE_REQUIRED', async () => {
      const auditRecords: unknown[] = [];
      const mockAuditTrail: IAuditTrail = {
        append: vi.fn(async (record) => {
          auditRecords.push(record);
        }),
      };

      // Notice: options.policyEngine is deliberately omitted so createCareOrchestratorFactory
      // constructs the production CarePolicyEngine bound to mockAuditTrail
      const factory = createCareOrchestratorFactory({
        workerId: 'test-worker-mutating',
        contextAggregator: {} as IContextAggregator,
        agentRuntime: {} as IAgentRuntime,
        effectGuard: {} as IEffectGuard,
        adapterDispatcher: mockDispatcher,
        auditSecret: testAuditSecret,
        resolve_grant: async () => 'AUTH-3',
        adapters: {
          ...mockAdapters,
          auditTrail: mockAuditTrail,
        },
      });

      const orchestrator = await factory(tenant_id);
      const policyEngine = getOrchestratorPolicyEngine(orchestrator);

      const action = createEscalateAction();
      const context = createHydratedContext();

      const result = await policyEngine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('AUTO_APPROVED');
      expect(result.reason).not.toContain('EVIDENCE_REQUIRED');
      expect(mockAuditTrail.append).toHaveBeenCalledTimes(1);
      expect(auditRecords[0]).toMatchObject({
        tenant_id,
        run_id: 'run-escalate-1',
        customer_or_entity_id: 'corr-escalate-1',
        skill: 'skill.care.escalate_to_human',
        authority: 'AUTH-3',
        action: expect.objectContaining({
          effect_key: 'eff-escalate-1',
        }),
        execution_status: 'pending',
      });
    });

    it('proves a mutating escalation with missing audit sink still fails closed with EVIDENCE_REQUIRED', async () => {
      const mockAuditTrail: IAuditTrail = {
        append: vi.fn().mockResolvedValue(undefined),
      };

      // audit: null explicitly requests no audit sink
      const factory = createCareOrchestratorFactory({
        workerId: 'test-worker-no-audit',
        contextAggregator: {} as IContextAggregator,
        agentRuntime: {} as IAgentRuntime,
        effectGuard: {} as IEffectGuard,
        adapterDispatcher: mockDispatcher,
        auditSecret: testAuditSecret,
        resolve_grant: async () => 'AUTH-3',
        audit: null,
        adapters: {
          ...mockAdapters,
          auditTrail: mockAuditTrail,
        },
      });

      const orchestrator = await factory(tenant_id);
      const policyEngine = getOrchestratorPolicyEngine(orchestrator);

      const action = createEscalateAction();
      const context = createHydratedContext();

      const result = await policyEngine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('EVIDENCE_REQUIRED');
      expect(result.reason).toContain('BR-010');
      expect(mockAuditTrail.append).not.toHaveBeenCalled();
    });

    it('createCarePolicyEngine binds to auditTrail and permits mutating action, or fails closed without sink', async () => {
      const auditRecords: unknown[] = [];
      const mockAuditTrail: IAuditTrail = {
        append: vi.fn(async (record) => {
          auditRecords.push(record);
        }),
      };

      // Engine with bound audit sink
      const engineWithAudit = createCarePolicyEngine({
        auditSecret: testAuditSecret,
        resolveGrant: async () => 'AUTH-3',
        auditTrail: mockAuditTrail,
      });
      const action = createEscalateAction();
      const context = createHydratedContext();

      const approvedResult = await engineWithAudit.evaluateAuthority(action, context);
      expect(approvedResult.verdict).toBe('AUTO_APPROVED');
      expect(approvedResult.reason).not.toContain('EVIDENCE_REQUIRED');
      expect(mockAuditTrail.append).toHaveBeenCalledTimes(1);
      expect(auditRecords[0]).toMatchObject({
        tenant_id,
        run_id: 'run-escalate-1',
        customer_or_entity_id: 'corr-escalate-1',
        skill: 'skill.care.escalate_to_human',
        authority: 'AUTH-3',
        action: expect.objectContaining({
          effect_key: 'eff-escalate-1',
        }),
        execution_status: 'pending',
      });
      const engineWithoutAudit = createCarePolicyEngine({
        auditSecret: testAuditSecret,
        resolveGrant: async () => 'AUTH-3',
      });
      const deniedResult = await engineWithoutAudit.evaluateAuthority(action, context);
      expect(deniedResult.verdict).toBe('DENIED');
      expect(deniedResult.reason).toContain('EVIDENCE_REQUIRED');
      expect(deniedResult.reason).toContain('BR-010');
    });

    it('audit sink failure blocks permit and fails closed with AUDIT_UNAVAILABLE', async () => {
      const failingAuditTrail: IAuditTrail = {
        append: vi.fn().mockRejectedValue(new Error('audit ledger storage error')),
      };

      const engine = createCarePolicyEngine({
        auditSecret: testAuditSecret,
        resolveGrant: async () => 'AUTH-3',
        auditTrail: failingAuditTrail,
      });

      const action = createEscalateAction();
      const context = createHydratedContext();

      const result = await engine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('AUDIT_UNAVAILABLE');
      expect(result.reason).toContain('BR-010');
    });
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ActionDraft } from '@agentos/core-engine/contracts';
import { computeEffectKey, computeRequestFingerprint } from '@agentos/core-engine';
import { SkillError, type ExecutionContext } from '@agentos/skills';
import type {
  CareHandoffExecutionReceipt,
  CareHandoffOutput,
  EnqueueCareHandoffInput,
  ManageServiceCaseInput,
  ManagedServiceCase,
} from '@agentos/database';

import { createCareSkillServices, CareSkillToolError } from './index.js';
import type { ErpReadPort } from '../../connectors.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FOREIGN_CUSTOMER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const VERIFICATION_REF = 'ver-ref-1';
const HANDOFF_CONVERSATION_ID = 'cccccccc-0000-4000-8000-00000000000c';
const HANDOFF_ID = 'dddddddd-0000-4000-8000-00000000000d';
const HANDOFF_EFFECT_KEY = 'f'.repeat(64);
const HANDOFF_OUTPUT: CareHandoffOutput = {
  handoff_id: HANDOFF_ID,
  queue_position: 1,
  status: 'ENQUEUED',
  escalated_at: '2026-04-15T12:00:00.000Z',
};
const HANDOFF_RECEIPT: CareHandoffExecutionReceipt = {
  execution_id: HANDOFF_ID,
  adapter_status: 'SUCCESS',
  provider_reference: HANDOFF_ID,
  response_payload: HANDOFF_OUTPUT,
  latency_ms: 0,
  token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
};
const HANDOFF_INPUT = {
  tenant_id: TENANT_ID,
  session_id: 'thread-a',
  conversation_id: HANDOFF_CONVERSATION_ID,
  customer_id: CUSTOMER_ID,
  escalation_reason: 'billing dispute',
  summary_context: 'Customer requests a human operator.',
};

function handoffContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    ...DUMMY_CONTEXT,
    run_id: 'run-handoff-1',
    effect_key: HANDOFF_EFFECT_KEY,
    granted_authority: 'AUTH-3',
    ...overrides,
  };
}

function createMockOptions(overrides: Partial<Parameters<typeof createCareSkillServices>[0]> = {}) {
  const erp_read: ErpReadPort = {
    read: vi.fn().mockResolvedValue({
      resource: 'orders',
      observed_at: '2026-01-04T10:00:00Z',
      tenant_id: TENANT_ID,
      value: {
        order_id: 'ORD-A-1',
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        status: 'SHIPPED',
        total_price: 1000,
        currency: 'TWD',
        tracking_number: 'TRK-123456',
        order_date: '2026-01-04T09:12:00Z',
        line_items: [
          {
            sku_id: 'SKU-OK',
            product_name: 'Standard Widget',
            quantity: 1,
            unit_price: 1000,
            currency: 'TWD',
          },
        ],
      },
    }),
  };

  return {
    erp_read,
    env: {
      CARE_TENANT_IDS: TENANT_ID,
    },
    resolve_correlation_id: vi.fn().mockResolvedValue('corr-123'),
    resolve_grant: vi.fn().mockResolvedValue('AUTH-0'),
    find_verified_identity: vi.fn().mockImplementation(async (_tenant: string, id: string) => {
      if (id === VERIFICATION_REF) {
        return {
          id: VERIFICATION_REF,
          customer_id: CUSTOMER_ID,
          verified_at: new Date('2026-01-01T00:00:00Z'),
        };
      }
      return null;
    }),
    ...overrides,
  };
}

const DUMMY_CONTEXT: ExecutionContext = {
  run_id: 'run-1',
  tenant_id: TENANT_ID,
  correlation_id: 'corr-123',
  caller_agent: 'CS-01',
  granted_authority: 'AUTH-0',
  effect_key: '0'.repeat(64),
};

describe('CareSkillServices', () => {
  describe('Orchestrator.HandoffBus', () => {
    it('binds one enqueue to trusted tenant, run and effect identity', async () => {
      const enqueue = vi.fn(async (_input: EnqueueCareHandoffInput) => ({
        disposition: 'CREATED' as const,
        output: HANDOFF_OUTPUT,
        receipt: HANDOFF_RECEIPT,
      }));
      const reconcile = vi.fn(async () => ({ state: 'NOT_COMMITTED' as const }));
      const services = createCareSkillServices(createMockOptions({
        handoff_repository: { enqueue, reconcile },
      }));

      const output = await services.tool_port.invoke({
        skill_id: 'skill.care.escalate_to_human',
        tool_binding: 'Orchestrator.HandoffBus',
        input: HANDOFF_INPUT,
        context: handoffContext(),
      });

      expect(output).toEqual(HANDOFF_OUTPUT);
      expect(enqueue).toHaveBeenCalledWith({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
        request_fingerprint: computeRequestFingerprint(HANDOFF_INPUT),
        run_id: 'run-handoff-1',
        session_id: 'thread-a',
        conversation_id: HANDOFF_CONVERSATION_ID,
        customer_id: CUSTOMER_ID,
        escalation_reason: 'billing dispute',
        summary_context: 'Customer requests a human operator.',
      });
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('reconciles a timed-out INTERNAL effect by key and never enqueues it twice', async () => {
      const enqueue = vi.fn(async (_input: EnqueueCareHandoffInput) => {
        throw new Error('HANDOFF_QUEUE_TIMEOUT: transaction exceeded its 1000ms deadline.');
      });
      const reconcile = vi.fn(async () => ({
        state: 'COMMITTED' as const,
        output: HANDOFF_OUTPUT,
        receipt: HANDOFF_RECEIPT,
      }));
      const services = createCareSkillServices(createMockOptions({
        handoff_repository: { enqueue, reconcile },
      }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.escalate_to_human',
        tool_binding: 'Orchestrator.HandoffBus',
        input: HANDOFF_INPUT,
        context: handoffContext(),
      })).resolves.toEqual(HANDOFF_OUTPUT);

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
        request_fingerprint: computeRequestFingerprint(HANDOFF_INPUT),
      });
    });

    it('fails closed when a timed-out handoff has no committed receipt', async () => {
      const enqueue = vi.fn(async (_input: EnqueueCareHandoffInput) => {
        throw new Error('connection reset');
      });
      const reconcile = vi.fn(async () => ({ state: 'NOT_COMMITTED' as const }));
      const services = createCareSkillServices(createMockOptions({
        handoff_repository: { enqueue, reconcile },
      }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.escalate_to_human',
        tool_binding: 'Orchestrator.HandoffBus',
        input: HANDOFF_INPUT,
        context: handoffContext(),
      })).rejects.toMatchObject({ code: 'QUEUE_DOWN' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('rejects a payload tenant mismatch before queue access', async () => {
      const enqueue = vi.fn(async (_input: EnqueueCareHandoffInput) => ({
        disposition: 'CREATED' as const, output: HANDOFF_OUTPUT, receipt: HANDOFF_RECEIPT,
      }));
      const reconcile = vi.fn(async () => ({ state: 'NOT_COMMITTED' as const }));
      const services = createCareSkillServices(createMockOptions({
        handoff_repository: { enqueue, reconcile },
      }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.escalate_to_human',
        tool_binding: 'Orchestrator.HandoffBus',
        input: { ...HANDOFF_INPUT, tenant_id: '22222222-2222-4222-8222-222222222222' },
        context: handoffContext(),
      })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });
      expect(enqueue).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('reads the receipt after a pre-aborted invocation without starting a new enqueue', async () => {
      const controller = new AbortController();
      controller.abort();
      const enqueue = vi.fn(async (_input: EnqueueCareHandoffInput) => ({
        disposition: 'CREATED' as const, output: HANDOFF_OUTPUT, receipt: HANDOFF_RECEIPT,
      }));
      const reconcile = vi.fn(async () => ({
        state: 'COMMITTED' as const, output: HANDOFF_OUTPUT, receipt: HANDOFF_RECEIPT,
      }));
      const services = createCareSkillServices(createMockOptions({
        handoff_repository: { enqueue, reconcile },
      }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.escalate_to_human',
        tool_binding: 'Orchestrator.HandoffBus',
        input: HANDOFF_INPUT,
        context: handoffContext({ signal: controller.signal }),
      })).resolves.toEqual(HANDOFF_OUTPUT);
      expect(enqueue).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledTimes(1);
    });
  });

  describe('SecondBrain.FAQEngine', () => {
    it('draft/unapproved corpus ⇒ CORPUS_UNAVAILABLE on repo default corpus', async () => {
      // Default knowledge root has all documents as status: draft
      const options = createMockOptions();
      const services = createCareSkillServices(options);

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.search_faq',
          tool_binding: 'SecondBrain.FAQEngine',
          input: { tenant_id: TENANT_ID, query_text: 'what is return policy?' },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/CORPUS_UNAVAILABLE/);
    });

    it('draft/unapproved corpus in custom root ⇒ CORPUS_UNAVAILABLE', async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'kb-draft-'));
      try {
        await mkdir(join(tempRoot, 'customer-care'), { recursive: true });
        await writeFile(
          join(tempRoot, 'customer-care', 'faq.md'),
          '---\nstatus: draft\n---\n## FAQ-1: Return\nA: 30 days',
        );

        const options = createMockOptions({
          env: { CARE_KNOWLEDGE_ROOT: tempRoot },
        });
        const services = createCareSkillServices(options);

        await expect(
          services.tool_port.invoke({
            skill_id: 'skill.care.search_faq',
            tool_binding: 'SecondBrain.FAQEngine',
            input: { tenant_id: TENANT_ID, query_text: 'Return' },
            context: DUMMY_CONTEXT,
          }),
        ).rejects.toThrowError(/CORPUS_UNAVAILABLE/);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });

    it('approved corpus with no match ⇒ empty answers and match_confidence 0', async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'kb-approved-'));
      try {
        // Create canonical 21 documents with approved status for customer-care/faq.md
        const folders = [
          'company', 'customer', 'product', 'brand', 'marketing', 'sales', 'customer-care', 'policy',
        ];
        for (const f of folders) {
          await mkdir(join(tempRoot, f), { recursive: true });
        }
        // Write all 21 files so loader succeeds
        const canonicalPaths = [
          'company/company.md', 'company/positioning.md', 'customer/customer.md', 'customer/segmentation.md',
          'product/products.md', 'product/pricing.md', 'product/promotion-policy.md', 'brand/voice.md',
          'brand/terminology.md', 'brand/prohibited-claims.md', 'marketing/playbook.md', 'marketing/content-guidelines.md',
          'marketing/campaign-rules.md', 'sales/sales-playbook.md', 'sales/qualification.md', 'sales/objection-handling.md',
          'customer-care/faq.md', 'customer-care/support-policy.md', 'customer-care/escalation.md', 'policy/authority.md',
          'policy/approval.md',
        ];
        for (const p of canonicalPaths) {
          await writeFile(
            join(tempRoot, p),
            p === 'customer-care/faq.md'
              ? '---\nstatus: approved\n---\n## FAQ-1: What is the warranty?\nWe offer 1 year standard warranty.'
              : '---\nstatus: approved\n---\n# Approved document\nContent',
          );
        }

        const options = createMockOptions({
          env: { CARE_KNOWLEDGE_ROOT: tempRoot },
        });
        const services = createCareSkillServices(options);

        // Query with completely unrelated terms
        const noMatch = await services.tool_port.invoke<{ tenant_id: string; query_text: string }, { answers: unknown[]; match_confidence: number }>({
          skill_id: 'skill.care.search_faq',
          tool_binding: 'SecondBrain.FAQEngine',
          input: { tenant_id: TENANT_ID, query_text: 'completely unrelated query about spaceships' },
          context: DUMMY_CONTEXT,
        });

        expect(noMatch.answers).toEqual([]);
        expect(noMatch.match_confidence).toBe(0);

        // Query with matching terms
        const match = await services.tool_port.invoke<{ tenant_id: string; query_text: string }, { answers: Array<{ faq_id: string; question: string; approved_answer: string }>; match_confidence: number }>({
          skill_id: 'skill.care.search_faq',
          tool_binding: 'SecondBrain.FAQEngine',
          input: { tenant_id: TENANT_ID, query_text: 'warranty duration' },
          context: DUMMY_CONTEXT,
        });

        expect(match.answers.length).toBeGreaterThan(0);
        expect(match.match_confidence).toBeGreaterThan(0);
        expect(match.answers[0]?.question).toContain('warranty');
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('API-001.OrderConnector', () => {
    it('missing/unresolvable/wrong-customer verification ⇒ IDENTITY_UNVERIFIED with zero connector calls', async () => {
      const options = createMockOptions();
      const services = createCareSkillServices(options);
      const readSpy = options.erp_read!.read;

      // Case 1: unresolvable verification_reference
      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: 'unknown-ref',
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/IDENTITY_UNVERIFIED/);
      expect(readSpy).toHaveBeenCalledTimes(0);

      // Case 2: verification_status is not 'VERIFIED'
      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'UNVERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/IDENTITY_UNVERIFIED/);
      expect(readSpy).toHaveBeenCalledTimes(0);

      // Case 3: verified_at is null
      const unverifiedOptions = createMockOptions({
        find_verified_identity: vi.fn().mockResolvedValue({
          id: VERIFICATION_REF,
          customer_id: CUSTOMER_ID,
          verified_at: null,
        }),
      });
      const unverifiedServices = createCareSkillServices(unverifiedOptions);
      await expect(
        unverifiedServices.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/IDENTITY_UNVERIFIED/);
      expect(unverifiedOptions.erp_read!.read).toHaveBeenCalledTimes(0);

      // Case 4: identity customer_id does not match caller's customer_id
      const wrongCustomerOptions = createMockOptions({
        find_verified_identity: vi.fn().mockResolvedValue({
          id: VERIFICATION_REF,
          customer_id: FOREIGN_CUSTOMER_ID,
          verified_at: new Date(),
        }),
      });
      const wrongCustomerServices = createCareSkillServices(wrongCustomerOptions);
      await expect(
        wrongCustomerServices.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/IDENTITY_UNVERIFIED/);
      expect(wrongCustomerOptions.erp_read!.read).toHaveBeenCalledTimes(0);
    });

    it('foreign order ⇒ ORDER_OWNER_MISMATCH / ORDER_NOT_FOUND with no existence disclosure', async () => {
      // Identity is verified for CUSTOMER_ID, but ERP returns an order owned by FOREIGN_CUSTOMER_ID
      const foreignOrderOptions = createMockOptions({
        erp_read: {
          read: vi.fn().mockResolvedValue({
            resource: 'orders',
            observed_at: '2026-01-04T10:00:00Z',
            tenant_id: TENANT_ID,
            value: {
              order_id: 'ORD-B-1',
              tenant_id: TENANT_ID,
              customer_id: FOREIGN_CUSTOMER_ID,
              status: 'DELIVERED',
              total_price: 800,
              currency: 'TWD',
              tracking_number: 'TRK-987654',
              order_date: '2026-01-05T14:30:00Z',
              line_items: [
                {
                  sku_id: 'SKU-OK',
                  product_name: 'Standard Widget',
                  quantity: 1,
                  unit_price: 800,
                  currency: 'TWD',
                },
              ],
            },
          }),
        },
      });

      const services = createCareSkillServices(foreignOrderOptions);

      let raisedError: unknown;
      try {
        await services.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-B-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        });
      } catch (err) {
        raisedError = err;
      }

      expect(raisedError).toBeInstanceOf(CareSkillToolError);
      const toolErr = raisedError as CareSkillToolError;
      expect(toolErr.code).toBe('ORDER_NOT_FOUND');
      expect(toolErr.message).toMatch(/ORDER_OWNER_MISMATCH|ORDER_NOT_FOUND/);
      expect(toolErr.message).toMatch(/no existence disclosure/);
    });

    it('absent or unmappable provider field ⇒ AUTHORITATIVE_SOURCE_UNAVAILABLE, never synthesized', async () => {
      const missingFieldOptions = createMockOptions({
        erp_read: {
          read: vi.fn().mockResolvedValue({
            resource: 'orders',
            observed_at: '2026-01-04T10:00:00Z',
            tenant_id: TENANT_ID,
            value: {
              // Missing order_id and order_date
              tenant_id: TENANT_ID,
              customer_id: CUSTOMER_ID,
              status: 'SHIPPED',
              total_price: 1000,
              currency: 'TWD',
            },
          }),
        },
      });

      const services = createCareSkillServices(missingFieldOptions);

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/AUTHORITATIVE_SOURCE_UNAVAILABLE/);
    });

    it('no API-001 binding ⇒ declared refusal and reported in unbound', async () => {
      const unboundOptions = createMockOptions({ erp_read: null });
      const services = createCareSkillServices(unboundOptions);

      expect(services.unbound.some((capability) => capability.startsWith('API-001.'))).toBe(true);
      expect(services.unbound.some((capability) => capability.startsWith('PostgreSQL.CaseManagementStore:'))).toBe(false);

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.lookup_order',
          tool_binding: 'API-001.OrderConnector',
          input: {
            tenant_id: TENANT_ID,
            order_identifier: 'ORD-A-1',
            customer_id: CUSTOMER_ID,
            verification_reference: VERIFICATION_REF,
            verification_status: 'VERIFIED',
          },
          context: DUMMY_CONTEXT,
        }),
      ).rejects.toThrowError(/AUTHORITATIVE_SOURCE_UNAVAILABLE/);
    });
  });

  describe('PostgreSQL.CaseManagementStore', () => {
    const timedOutCaseInput = {
      tenant_id: TENANT_ID,
      customer_id: CUSTOMER_ID,
      intent: 'billing',
      priority: 'P2' as const,
      conversation_id: 'cccccccc-0000-4000-8000-00000000000c',
      action_type: 'TRANSITION_STATE' as const,
      case_id: 'ffffffff-0000-4000-8000-00000000000f',
      expected_case_version: 5,
      target_status: 'WAITING_CUSTOMER' as const,
    };

    it('rejects a payload tenant mismatch before resolving policy or touching the repository', async () => {
      const manage = vi.fn(async () => { throw new Error('unexpected case repository call'); });
      const reconcile = vi.fn(async () => ({
        state: 'NOT_COMMITTED' as const,
        case_id: null,
        current_case_version: null,
        current_status: null,
      }));
      const resolveSla = vi.fn(async () => 4);
      const services = createCareSkillServices(createMockOptions({
        case_repository: { manage, reconcile },
        case_sla_target_hours: resolveSla,
      }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: '22222222-2222-4222-8222-222222222222',
          customer_id: CUSTOMER_ID,
          intent: 'billing',
          priority: 'P2',
          conversation_id: 'cccccccc-0000-4000-8000-00000000000c',
          action_type: 'CREATE',
        },
        context: { ...DUMMY_CONTEXT, granted_authority: 'AUTH-3' },
      })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISMATCH' });

      expect(resolveSla).not.toHaveBeenCalled();
      expect(manage).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('refuses case creation when no tenant SLA target is configured', async () => {
      const manage = vi.fn(async () => { throw new Error('unexpected case repository call'); });
      const reconcile = vi.fn(async () => ({
        state: 'NOT_COMMITTED' as const,
        case_id: null,
        current_case_version: null,
        current_status: null,
      }));
      const services = createCareSkillServices(createMockOptions({ case_repository: { manage, reconcile } }));

      await expect(services.tool_port.invoke({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: {
          tenant_id: TENANT_ID,
          customer_id: CUSTOMER_ID,
          intent: 'billing',
          priority: 'P2',
          conversation_id: 'cccccccc-0000-4000-8000-00000000000c',
          action_type: 'CREATE',
        },
        context: { ...DUMMY_CONTEXT, granted_authority: 'AUTH-3' },
      })).rejects.toMatchObject({ code: 'CASE_SLA_POLICY_UNAVAILABLE' });

      expect(manage).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });

    it('reports the missing SLA dependency only when manage_case is explicitly enabled', () => {
      const services = createCareSkillServices(createMockOptions({
        skill_enablement: { enabled_skill_ids: ['skill.care.manage_case'] },
      }));

      expect(services.unbound.some((capability) => capability.startsWith('PostgreSQL.CaseManagementStore:'))).toBe(true);
    });

    it('returns the immutable receipt after a timed-out management call', async () => {
      const receipt: ManagedServiceCase = {
        case_id: timedOutCaseInput.case_id,
        customer_id: CUSTOMER_ID,
        intent: 'billing',
        priority: 'P2',
        status: 'WAITING_CUSTOMER',
        conversation_id: timedOutCaseInput.conversation_id,
        related_order_id: null,
        evidence_refs: [],
        assigned_owner: 'CS-01',
        sla_target_hours: 4,
        updated_at: '2026-04-15T12:00:00.000Z',
        case_version: 6,
      };
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let finishManage!: (output: ManagedServiceCase) => void;
      const pendingManage = new Promise<ManagedServiceCase>((resolve) => { finishManage = resolve; });
      const manage = vi.fn((_mutation: ManageServiceCaseInput) => {
        markStarted();
        return pendingManage;
      });
      const reconcile = vi.fn(async () => ({ state: 'COMMITTED' as const, output: receipt }));
      const services = createCareSkillServices(createMockOptions({
        case_repository: { manage, reconcile },
        case_sla_target_hours: vi.fn(async () => 4),
        skill_enablement: { enabled_skill_ids: ['skill.care.manage_case'] },
      }));
      const controller = new AbortController();
      const invocation = services.tool_port.invoke({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: timedOutCaseInput,
        context: { ...DUMMY_CONTEXT, granted_authority: 'AUTH-3', signal: controller.signal },
      });

      await started;
      controller.abort();
      await expect(invocation).resolves.toEqual(receipt);

      expect(manage).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TENANT_ID,
        case_id: timedOutCaseInput.case_id,
        expected_case_version: 5,
        effect_key: DUMMY_CONTEXT.effect_key,
        actor_id: 'CS-01',
      }));
      finishManage(receipt);
    });

    it('re-reads the current case and never retries when a timed-out effect has no receipt', async () => {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let finishManage!: (output: ManagedServiceCase) => void;
      const pendingManage = new Promise<ManagedServiceCase>((resolve) => { finishManage = resolve; });
      const manage = vi.fn((_mutation: ManageServiceCaseInput) => {
        markStarted();
        return pendingManage;
      });
      const reconcile = vi.fn(async () => ({
        state: 'NOT_COMMITTED' as const,
        case_id: timedOutCaseInput.case_id,
        current_case_version: 5,
        current_status: 'IN_PROGRESS' as const,
      }));
      const services = createCareSkillServices(createMockOptions({
        case_repository: { manage, reconcile },
        case_sla_target_hours: vi.fn(async () => 4),
        skill_enablement: { enabled_skill_ids: ['skill.care.manage_case'] },
      }));
      const controller = new AbortController();
      const invocation = services.tool_port.invoke({
        skill_id: 'skill.care.manage_case',
        tool_binding: 'PostgreSQL.CaseManagementStore',
        input: timedOutCaseInput,
        context: { ...DUMMY_CONTEXT, granted_authority: 'AUTH-3', signal: controller.signal },
      });

      await started;
      controller.abort();
      await expect(invocation).rejects.toMatchObject({ code: 'CASE_EFFECT_NOT_COMMITTED' });

      expect(manage).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TENANT_ID,
        case_id: timedOutCaseInput.case_id,
        expected_case_version: 5,
      }));
      finishManage({
        case_id: timedOutCaseInput.case_id,
        customer_id: CUSTOMER_ID,
        intent: 'billing',
        priority: 'P2',
        status: 'WAITING_CUSTOMER',
        conversation_id: timedOutCaseInput.conversation_id,
        related_order_id: null,
        evidence_refs: [],
        assigned_owner: 'CS-01',
        sla_target_hours: 4,
        updated_at: '2026-04-15T12:00:00.000Z',
        case_version: 6,
      });
    });
  });
  describe('Dispatcher and ExecutionReceipt', () => {
    it('the receipt carries no invented provider_reference and maps validated output', async () => {
      const options = createMockOptions();
      const services = createCareSkillServices(options);

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.care.lookup_order',
        step_index: 1,
        action_revision: 0,
        request_id: 'req-001',
      });

      const draft: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000001',
        run_id: '11111111-2222-3333-4444-555555555555',
        tenant_id: TENANT_ID,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 1,
        mutating: false,
        price_bearing: false,
        request_id: 'req-001',
        action_revision: 0,
        effect_key,
        required_authority: 'AUTH-0',
        payload: {
          tenant_id: TENANT_ID,
          order_identifier: 'ORD-A-1',
          customer_id: CUSTOMER_ID,
          verification_reference: VERIFICATION_REF,
          verification_status: 'VERIFIED',
        },
      };

      const receipt = await services.dispatcher.dispatch(draft);

      expect(receipt.adapter_status).toBe('SUCCESS');
      // Must be null: never an invented provider reference for read-only lookup
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload).toMatchObject({
        order_id: 'ORD-A-1',
        status: 'SHIPPED',
        total_price: 1000,
        currency: 'TWD',
        tracking_number: 'TRK-123456',
        order_date: '2026-01-04T09:12:00Z',
      });
      expect(receipt.token_usage).toEqual({ prompt: 0, completion: 0, total_cost_usd: 0 });
    });

    it('SkillError refusal surfaces as canonical failure, never as synthetic success', async () => {
      const options = createMockOptions({
        find_verified_identity: vi.fn().mockResolvedValue(null),
      });
      const services = createCareSkillServices(options);

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.care.lookup_order',
        step_index: 1,
        action_revision: 0,
        request_id: 'req-002',
      });

      const draft: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000002',
        run_id: '11111111-2222-3333-4444-555555555555',
        tenant_id: TENANT_ID,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 1,
        mutating: false,
        price_bearing: false,
        request_id: 'req-002',
        action_revision: 0,
        effect_key,
        required_authority: 'AUTH-0',
        payload: {
          tenant_id: TENANT_ID,
          order_identifier: 'ORD-A-1',
          customer_id: CUSTOMER_ID,
          verification_reference: 'non-existent-ref',
          verification_status: 'VERIFIED',
        },
      };

      // Must throw/reject, never return an ExecutionReceipt with adapter_status: 'SUCCESS'
      await expect(services.dispatcher.dispatch(draft)).rejects.toThrow();
    });

    it('verdict-only granted_authority (AUTH-4) is refused by dispatcher as INVALID_CLEARANCE', async () => {
      const options = createMockOptions({
        resolve_grant: vi.fn().mockResolvedValue('AUTH-4' as unknown),
      });
      const services = createCareSkillServices(options);

      const effect_key = computeEffectKey({
        tenant_id: TENANT_ID,
        skill_id: 'skill.care.lookup_order',
        step_index: 1,
        action_revision: 0,
        request_id: 'req-003',
      });

      const draft: ActionDraft = {
        action_id: '00000000-0000-0000-0000-000000000003',
        run_id: '11111111-2222-3333-4444-555555555555',
        tenant_id: TENANT_ID,
        agent_id: 'CS-01',
        skill_id: 'skill.care.lookup_order',
        adapter_target: 'API-001',
        step_index: 1,
        mutating: false,
        price_bearing: false,
        request_id: 'req-003',
        action_revision: 0,
        effect_key,
        required_authority: 'AUTH-0',
        payload: {
          tenant_id: TENANT_ID,
          order_identifier: 'ORD-A-1',
          customer_id: CUSTOMER_ID,
          verification_reference: VERIFICATION_REF,
          verification_status: 'VERIFIED',
        },
      };

      await expect(services.dispatcher.dispatch(draft)).rejects.toThrowError(SkillError);
      await expect(services.dispatcher.dispatch(draft)).rejects.toMatchObject({
        code: 'INVALID_CLEARANCE',
      });
    });

    it('verdict-only granted_authority (AUTH-4) is refused by tool_port as INVALID_CLEARANCE', async () => {
      const options = createMockOptions();
      const services = createCareSkillServices(options);

      const verdictOnlyContext = {
        ...DUMMY_CONTEXT,
        granted_authority: 'AUTH-4' as unknown as ExecutionContext['granted_authority'],
      };

      await expect(
        services.tool_port.invoke({
          skill_id: 'skill.care.search_faq',
          tool_binding: 'SecondBrain.FAQEngine',
          input: { tenant_id: TENANT_ID, query_text: 'what is return policy?' },
          context: verdictOnlyContext,
        }),
      ).rejects.toThrowError(/INVALID_CLEARANCE/);
    });

    it('CareSkillDispatcher.reconcile fails closed to INDETERMINATE for non-ERP targets without calling erp_reconcile', async () => {
      const erp_reconcile = vi.fn().mockResolvedValue({ outcome: 'FAILED' as const });
      const erp_read = {
        read: vi.fn(),
        reconcile: erp_reconcile,
      };
      const options = createMockOptions({ erp_read: erp_read as unknown as ErpReadPort });
      const services = createCareSkillServices(options);

      expect(services.dispatcher.reconcile).toBeDefined();

      // Non-ERP adapter_target (e.g. Orchestrator.HandoffBus) must return INDETERMINATE without calling erp_reconcile
      const handoffResult = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
        action_id: '00000000-0000-0000-0000-000000000001',
        adapter_target: 'Orchestrator.HandoffBus',
        skill_id: 'skill.care.escalate_to_human',
      });

      expect(handoffResult).toEqual({ outcome: 'INDETERMINATE' });
      expect(erp_reconcile).not.toHaveBeenCalled();

      // Non-API-001 skill with undefined adapter_target also returns INDETERMINATE fail-closed
      const nonErpSkillResult = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
        skill_id: 'skill.care.escalate_to_human',
      });

      expect(nonErpSkillResult).toEqual({ outcome: 'INDETERMINATE' });
      expect(erp_reconcile).not.toHaveBeenCalled();

      // API-001 target preserves existing behavior and invokes erp_reconcile
      erp_reconcile.mockResolvedValueOnce({ outcome: 'SUCCEEDED' as const });
      const api001Result = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
        adapter_target: 'API-001',
      });

      expect(api001Result).toEqual({ outcome: 'SUCCEEDED' });
      expect(erp_reconcile).toHaveBeenCalledTimes(1);

      // Undefined adapter_target preserves existing behavior and invokes erp_reconcile
      erp_reconcile.mockResolvedValueOnce({ outcome: 'SUCCEEDED' as const });
      const undefinedTargetResult = await services.dispatcher.reconcile!({
        tenant_id: TENANT_ID,
        effect_key: HANDOFF_EFFECT_KEY,
      });

      expect(undefinedTargetResult).toEqual({ outcome: 'SUCCEEDED' });
      expect(erp_reconcile).toHaveBeenCalledTimes(2);
    });
  });
});

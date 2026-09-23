import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ActionDraft } from '@agentos/core-engine/contracts';
import { computeEffectKey } from '@agentos/core-engine';
import { SkillError, type ExecutionContext } from '@agentos/skills';

import { createCareSkillServices, CareSkillToolError } from './index.js';
import type { ErpReadPort } from '../../connectors.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FOREIGN_CUSTOMER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const VERIFICATION_REF = 'ver-ref-1';

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

      expect(services.unbound).toHaveLength(1);
      expect(services.unbound[0]).toMatch(/API-001/);

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
  });
});

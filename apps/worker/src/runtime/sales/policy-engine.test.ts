import { describe, expect, it, vi } from 'vitest';
import type { ActionDraft, Customer360Fact, HydratedContext } from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import {
  SALES_ALLOWED_PAYLOAD_FIELDS,
  SALES_SKILLS,
  createSalesPolicyEngine,
} from './policy-engine.js';
import {
  createSalesOrchestratorFactory,
  getSalesUnboundCapabilities,
} from './factory.js';
import type {
  SalesConsentPort,
  SalesPriceFloorDecision,
  SalesPriceFloorPort,
} from './skills/types.js';

describe('SalesPolicyEngine', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';

  const verifiedCustomer: Customer360Fact = {
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
  };

  const context: HydratedContext = {
    correlation_id: 'corr-test',
    tenant_id,
    customer: verifiedCustomer,
    working_memory: {
      session_id: 'sess-test',
      last_touch_channel: 'web',
      turn_count: 1,
      takeover_active: false,
    },
    knowledge_citations: [],
    hydrated_at: '2026-09-01T00:00:00Z',
  };

  const defaultEngine = createSalesPolicyEngine();

  describe('registry and payload allowlist', () => {
    it('declares price_bearing: false on every Sales skill row', () => {
      for (const [skillId, skill] of Object.entries(SALES_SKILLS)) {
        expect(skill.price_bearing).toBe(false);
        expect(skill.skill_id).toBe(skillId);
      }
    });

    it('contains all 8 canonical Sales skills', () => {
      const skillIds = Object.keys(SALES_SKILLS).sort();
      expect(skillIds).toEqual([
        'skill.sales.check_price',
        'skill.sales.check_stock',
        'skill.sales.create_cart',
        'skill.sales.create_order',
        'skill.sales.recommend_product',
        'skill.sales.retrieve_customer',
        'skill.sales.search_product',
        'skill.sales.send_message',
      ]);
    });

    it('contains payload allowlist entries for all 8 Sales skills', () => {
      const allowlistKeys = Object.keys(SALES_ALLOWED_PAYLOAD_FIELDS).sort();
      expect(allowlistKeys).toEqual(Object.keys(SALES_SKILLS).sort());
      for (const fields of Object.values(SALES_ALLOWED_PAYLOAD_FIELDS)) {
        expect(fields).toHaveProperty('tenant_id');
        expect(fields).toHaveProperty('effect_key');
      }
    });
  });

  describe('validateAction', () => {
    it('normalizes valid search_product action without floor evaluation', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000010',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.search_product',
        adapter_target: 'API-001.CatalogConnector',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-0',
        payload: {
          tenant_id,
          query: 'running shoes',
          limit: 10,
        },
      };

      const validated = await defaultEngine.validateAction(action, context);
      expect(validated.skill_id).toBe('skill.sales.search_product');
      expect(validated.computed_price_floor).toBeUndefined();
      expect(validated.floor_source).toBeUndefined();
    });

    it('rejects action with unknown fields in payload', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000011',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.search_product',
        adapter_target: 'API-001.CatalogConnector',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-0',
        payload: {
          tenant_id,
          query: 'running shoes',
          unauthorized_override: true,
        },
      };

      await expect(defaultEngine.validateAction(action, context)).rejects.toMatchObject({
        code: 'POLICY_INPUT_INVALID',
      });
    });

    it('rejects cross-tenant assertion', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000012',
        run_id: 'run-1',
        tenant_id: '00000000-0000-4000-8000-999999999999',
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.search_product',
        adapter_target: 'API-001.CatalogConnector',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-0',
        payload: {
          tenant_id,
          query: 'shoes',
        },
      };

      await expect(defaultEngine.validateAction(action, context)).rejects.toMatchObject({
        code: 'CROSS_TENANT_ASSERTION',
      });
    });

    it('rejects retrieve_customer on unverified customer', async () => {
      const unverifiedContext: HydratedContext = {
        ...context,
        customer: null,
      };

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000013',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-01',
        skill_id: 'skill.sales.retrieve_customer',
        adapter_target: 'PostgreSQL.Customer360Store',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-1',
        required_authority: 'AUTH-0',
        payload: {
          tenant_id,
          customer_identifier: 'cust-42',
        },
      };

      await expect(defaultEngine.validateAction(action, unverifiedContext)).rejects.toMatchObject({
        code: 'IDENTITY_UNVERIFIED',
      });
    });
  });

  describe('floor resolution at action boundary', () => {
    it('mutation draft carrying no discount and no proposed_price gets no floor metadata and stays dispatcheable', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000020',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-1',
        },
      };

      const validated = await defaultEngine.validateAction(action, context);
      expect(validated.computed_price_floor).toBeUndefined();
      expect(validated.floor_source).toBeUndefined();
    });

    it('discount-sensitive draft carrying discount_percent without bound price floor port throws P_FLOOR_UNAVAILABLE', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000021',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-2',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-2',
          discount_percent: 15,
        },
      };

      await expect(defaultEngine.validateAction(action, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });
    });

    it('discount-sensitive draft throws P_FLOOR_UNAVAILABLE when floor decision is unapproved or refused', async () => {
      const mockRefusedPort: SalesPriceFloorPort = {
        read: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: false,
          owner_approved: false,
          reason: 'Owner has not approved floor price for SKU',
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockRefusedPort });

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000022',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-3',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-3',
          offer_id: 'OFFER-10',
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });
    });

    it('discount-sensitive draft throws P_FLOOR_UNAVAILABLE when floor decision lacks provenance', async () => {
      const mockNoProvenancePort: SalesPriceFloorPort = {
        read: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: true,
          owner_approved: true,
          list_price: 100,
          quote_ttl_seconds: 300,
          p_floor: 50,
          floor_source: '',
          currency: 'USD',
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockNoProvenancePort });

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000023',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-4',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-4',
          discount_amount: 10,
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });
    });

    it('discount-sensitive draft resolves owner-approved floor and attaches computed_price_floor and floor_source', async () => {
      const mockApprovedPort: SalesPriceFloorPort = {
        read: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: true,
          owner_approved: true,
          list_price: 100,
          p_floor: 75.5,
          floor_source: 'pricing_engine:owner:approved_2026_09',
          currency: 'USD',
          quote_ttl_seconds: 300,
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockApprovedPort });

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000024',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-5',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-5',
          discount_percent: 20,
        },
      };

      const validated = await engine.validateAction(action, context);
      expect(validated.computed_price_floor).toBe(75.5);
      expect(validated.floor_source).toBe('pricing_engine:owner:approved_2026_09');
      expect(mockApprovedPort.read).toHaveBeenCalledWith({
        tenant_id,
        sku_id: 'SKU-001',
      });
    });

    it('refuses multi-SKU discount action when price floor port offers no aggregate decision and never attaches a member floor_source', async () => {
      const mockPortWithoutAggregate: SalesPriceFloorPort = {
        read: vi.fn(async (q): Promise<SalesPriceFloorDecision> => {
          if (q.sku_id === 'SKU-001') {
            return {
              ok: true,
              owner_approved: true,
              list_price: 100,
              p_floor: 40,
              floor_source: 'pricing_engine:sku:SKU-001',
              currency: 'USD',
              quote_ttl_seconds: 300,
            };
          }
          return {
            ok: true,
            owner_approved: true,
            list_price: 150,
            p_floor: 60,
            floor_source: 'pricing_engine:sku:SKU-002',
            currency: 'USD',
            quote_ttl_seconds: 300,
          };
        }),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockPortWithoutAggregate });

      const multiSkuAction: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000041',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-multi-1',
        action_revision: 0,
        effect_key: 'eff-multi-cart-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [
            { sku_id: 'SKU-001', quantity: 1 },
            { sku_id: 'SKU-002', quantity: 1 },
          ],
          idempotency_key: 'idem-multi-1',
          discount_percent: 15,
        },
      };

      await expect(engine.validateAction(multiSkuAction, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });
    });

    it('refuses multi-SKU action when a member SKU breaches its own owner-approved floor, naming the offending sku_id', async () => {
      const mockPortWithAggregate: SalesPriceFloorPort = {
        read: vi.fn(async (q): Promise<SalesPriceFloorDecision> => {
          if (q.sku_id === 'SKU-001') {
            return {
              ok: true,
              owner_approved: true,
              list_price: 100,
              p_floor: 40,
              floor_source: 'pricing_engine:sku:SKU-001',
              currency: 'USD',
              quote_ttl_seconds: 300,
            };
          }
          return {
            ok: true,
            owner_approved: true,
            list_price: 150,
            p_floor: 70,
            floor_source: 'pricing_engine:sku:SKU-002',
            currency: 'USD',
            quote_ttl_seconds: 300,
          };
        }),
        readAggregate: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: true,
          owner_approved: true,
          list_price: 250,
          p_floor: 100,
          floor_source: 'pricing_engine:cart:aggregate_2026_09',
          currency: 'USD',
          quote_ttl_seconds: 300,
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockPortWithAggregate });

      const actionWithBreachedMember: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000042',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-multi-2',
        action_revision: 0,
        effect_key: 'eff-multi-cart-2',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [
            { sku_id: 'SKU-001', quantity: 1, proposed_price: 50 },
            { sku_id: 'SKU-002', quantity: 1, proposed_price: 50 },
          ],
          idempotency_key: 'idem-multi-2',
          discount_percent: 20,
        },
      };

      await expect(engine.validateAction(actionWithBreachedMember, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
        message: expect.stringContaining('SKU-002'),
      });
    });

    it('refuses multi-SKU action when a member SKU floor cannot be resolved, naming the offending sku_id', async () => {
      const mockPortUnresolvableMember: SalesPriceFloorPort = {
        read: vi.fn(async (q): Promise<SalesPriceFloorDecision> => {
          if (q.sku_id === 'SKU-001') {
            return {
              ok: true,
              owner_approved: true,
              list_price: 100,
              p_floor: 40,
              floor_source: 'pricing_engine:sku:SKU-001',
              currency: 'USD',
              quote_ttl_seconds: 300,
            };
          }
          return {
            ok: false,
            owner_approved: false,
            reason: 'Pricing model unavailable for SKU-002',
          };
        }),
        readAggregate: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: true,
          owner_approved: true,
          list_price: 250,
          p_floor: 100,
          floor_source: 'pricing_engine:cart:aggregate_2026_09',
          currency: 'USD',
          quote_ttl_seconds: 300,
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockPortUnresolvableMember });

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000043',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-multi-3',
        action_revision: 0,
        effect_key: 'eff-multi-cart-3',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [
            { sku_id: 'SKU-001', quantity: 1 },
            { sku_id: 'SKU-002', quantity: 1 },
          ],
          idempotency_key: 'idem-multi-3',
          discount_percent: 10,
        },
      };

      await expect(engine.validateAction(action, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
        message: expect.stringContaining('SKU-002'),
      });
    });

    it('permits multi-SKU action fully within every member floor and attaches aggregate floor mirrors', async () => {
      const mockPortFullyPermitted: SalesPriceFloorPort = {
        read: vi.fn(async (q): Promise<SalesPriceFloorDecision> => {
          if (q.sku_id === 'SKU-001') {
            return {
              ok: true,
              owner_approved: true,
              list_price: 100,
              p_floor: 40,
              floor_source: 'pricing_engine:sku:SKU-001',
              currency: 'USD',
              quote_ttl_seconds: 300,
            };
          }
          return {
            ok: true,
            owner_approved: true,
            list_price: 150,
            p_floor: 60,
            floor_source: 'pricing_engine:sku:SKU-002',
            currency: 'USD',
            quote_ttl_seconds: 300,
          };
        }),
        readAggregate: vi.fn(async (): Promise<SalesPriceFloorDecision> => ({
          ok: true,
          owner_approved: true,
          list_price: 250,
          p_floor: 100,
          floor_source: 'pricing_engine:cart:aggregate_2026_09',
          currency: 'USD',
          quote_ttl_seconds: 300,
        })),
      };

      const engine = createSalesPolicyEngine({ price_floor: mockPortFullyPermitted });

      const multiSkuAction: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000044',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-multi-4',
        action_revision: 0,
        effect_key: 'eff-multi-cart-4',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          items: [
            { sku_id: 'SKU-001', quantity: 1, proposed_price: 50 },
            { sku_id: 'SKU-002', quantity: 1, proposed_price: 80 },
          ],
          idempotency_key: 'idem-multi-4',
          discount_percent: 10,
        },
      };

      const validated = await engine.validateAction(multiSkuAction, context);
      expect(validated.computed_price_floor).toBe(100);
      expect(validated.floor_source).toBe('pricing_engine:cart:aggregate_2026_09');
      expect(mockPortFullyPermitted.readAggregate).toHaveBeenCalledTimes(1);
      expect(mockPortFullyPermitted.read).toHaveBeenCalledWith({ tenant_id, sku_id: 'SKU-001' });
      expect(mockPortFullyPermitted.read).toHaveBeenCalledWith({ tenant_id, sku_id: 'SKU-002' });
    });

    it('refuses discount-sensitive payload when no resolvable sku_id can be determined', async () => {
      const mockPort: SalesPriceFloorPort = {
        read: vi.fn(),
      };
      const engine = createSalesPolicyEngine({ price_floor: mockPort });

      // 1. Missing items and missing sku_id
      const actionNoSku: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000045',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-no-sku-1',
        action_revision: 0,
        effect_key: 'eff-no-sku-1',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          customer_id: 'cust-42',
          idempotency_key: 'idem-no-sku-1',
          discount_percent: 15,
        },
      };

      await expect(engine.validateAction(actionNoSku, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });

      // 2. Empty items array and missing sku_id
      const actionEmptyItems: ActionDraft = {
        ...actionNoSku,
        action_id: '00000000-0000-4000-8000-000000000046',
        payload: {
          ...actionNoSku.payload,
          items: [],
        },
      };

      await expect(engine.validateAction(actionEmptyItems, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });

      // 3. Items without sku_id
      const actionMalformedItems: ActionDraft = {
        ...actionNoSku,
        action_id: '00000000-0000-4000-8000-000000000047',
        payload: {
          ...actionNoSku.payload,
          items: [{ quantity: 1 }],
        },
      };

      await expect(engine.validateAction(actionMalformedItems, context)).rejects.toMatchObject({
        code: 'P_FLOOR_UNAVAILABLE',
      });
    });
  });

  describe('evaluateAuthority', () => {
    it('returns AUTO_APPROVED when assigned authority meets required authority', async () => {
      const mockAuditTrail = { append: vi.fn(async () => {}) };
      const engine = createSalesPolicyEngine({
        resolveGrant: async () => 'AUTH-3',
        auditTrail: mockAuditTrail,
        auditSecret: 'test-secret',
      });

      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000030',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-cart-auth',
        required_authority: 'AUTH-3',
        payload: {
          tenant_id,
          session_id: 'sess-test',
          items: [{ sku_id: 'SKU-001', quantity: 1 }],
          idempotency_key: 'idem-6',
          effect_key: 'eff-cart-auth',
        },
      };

      const result = await engine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('AUTO_APPROVED');
    });

    it('returns DENIED for AUTH-5 required authority', async () => {
      const action: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000031',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-prohibited',
        required_authority: 'AUTH-5',
        payload: {},
      };

      const result = await defaultEngine.evaluateAuthority(action, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('AUTH-5');
    });

    it('returns DENIED when human takeover is active for mutating action', async () => {
      const takeoverContext: HydratedContext = {
        ...context,
        working_memory: {
          ...context.working_memory,
          takeover_active: true,
        },
      };

      const mutatingAction: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000032',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-02',
        skill_id: 'skill.sales.create_cart',
        adapter_target: 'API-002.CommerceCartAPI',
        step_index: 0,
        mutating: true,
        price_bearing: false,
        request_id: 'req-1',
        action_revision: 0,
        effect_key: 'eff-mutating',
        required_authority: 'AUTH-3',
        payload: {},
      };

      const result = await defaultEngine.evaluateAuthority(mutatingAction, takeoverContext);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('HUMAN_TAKEOVER');
    });

    const sendMessageAction: ActionDraft = {
      action_id: '00000000-0000-4000-8000-000000000040',
      run_id: 'run-1',
      tenant_id,
      agent_id: 'SAL-02',
      skill_id: 'skill.sales.send_message',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: 0,
      mutating: true,
      price_bearing: false,
      request_id: 'req-1',
      action_revision: 0,
      effect_key: 'eff-send-msg',
      required_authority: 'AUTH-3',
      payload: {
        tenant_id,
        recipient_id: 'cust-42',
        channel: 'LINE',
        message_content: { text: 'Hello' },
        effect_key: 'eff-send-msg',
      },
    };

    it('returns AUTO_APPROVED for send_message when consent port is bound and customer is consented and unsuppressed', async () => {
      const mockAuditTrail = { append: vi.fn(async () => {}) };
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: true, suppressed: false })),
        getConsent: vi.fn(async ({ tenant_id: tid, customer_id: cid }) => {
          expect(tid).toBe(tenant_id);
          expect(cid).toBe(verifiedCustomer.customer_id);
          return {
            consent_marketing: true,
            suppression_active: false,
          };
        }),
      };

      const engine = createSalesPolicyEngine({
        consent: consentPort,
        auditTrail: mockAuditTrail,
        auditSecret: 'test-secret',
      });
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('AUTO_APPROVED');
      expect(consentPort.getConsent).toHaveBeenCalledWith({
        tenant_id,
        customer_id: verifiedCustomer.customer_id,
      });
    });

    it('returns DENIED with CONSENT_REQUIRED for send_message when consent port is unbound', async () => {
      const engine = createSalesPolicyEngine();
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('CONSENT_REQUIRED');
    });

    it('returns DENIED with CONSENT_REQUIRED when bound consent port returns opted-out customer', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: false, suppressed: false })),
        getConsent: vi.fn(async () => ({
          consent_marketing: false,
          suppression_active: false,
        })),
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('CONSENT_REQUIRED');
    });

    it('returns DENIED with CONSENT_REQUIRED when bound consent port returns suppressed customer', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: true, suppressed: true })),
        getConsent: vi.fn(async () => ({
          consent_marketing: true,
          suppression_active: true,
        })),
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('CONSENT_REQUIRED');
    });

    it('returns DENIED with CONSENT_REQUIRED when bound consent port read throws an error', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => { throw new Error('Consent service unavailable'); }),
        getConsent: vi.fn(async () => { throw new Error('Consent service unavailable'); }),
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('CONSENT_REQUIRED');
    });

    it('returns DENIED with CONSENT_REQUIRED when bound consent port returns missing record (undefined)', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: false, suppressed: false })),
        getConsent: vi.fn(async () => undefined),
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(sendMessageAction, context);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('CONSENT_REQUIRED');
    });

    it('returns DENIED with IDENTITY_UNVERIFIED when session has no server-verified customer', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: true, suppressed: false })),
        getConsent: vi.fn(async () => ({ consent_marketing: true, suppression_active: false })),
      };

      const anonContext: HydratedContext = {
        ...context,
        customer: null,
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(sendMessageAction, anonContext);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toContain('IDENTITY_UNVERIFIED');
    });

    it('returns AUTO_APPROVED for recommend_product when consent port is bound and customer is consented', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: true, suppressed: false })),
        getConsent: vi.fn(async () => ({
          consent_marketing: true,
          suppression_active: false,
        })),
      };

      const recommendAction: ActionDraft = {
        action_id: '00000000-0000-4000-8000-000000000041',
        run_id: 'run-1',
        tenant_id,
        agent_id: 'SAL-03',
        skill_id: 'skill.sales.recommend_product',
        adapter_target: 'API-001.RecommendationEngine',
        step_index: 0,
        mutating: false,
        price_bearing: false,
        request_id: 'req-2',
        action_revision: 0,
        effect_key: 'eff-rec-prod',
        required_authority: 'AUTH-1',
        payload: {
          tenant_id,
          customer_id: 'cust-42',
          current_cart_skus: ['SKU-001'],
          recommendation_type: 'CROSS_SELL',
          effect_key: 'eff-rec-prod',
        },
      };

      const engine = createSalesPolicyEngine({ consent: consentPort });
      const result = await engine.evaluateAuthority(recommendAction, context);
      expect(result.verdict).toBe('AUTO_APPROVED');
    });

    it('rejects action payload that attempts to assert its own consent fields', async () => {
      const payloadWithConsent = {
        tenant_id,
        recipient_id: 'cust-42',
        channel: 'LINE',
        message_content: { text: 'Hello' },
        effect_key: 'eff-send-msg',
        consent_marketing: true,
      };

      const action: ActionDraft = {
        ...sendMessageAction,
        payload: payloadWithConsent,
      };

      await expect(defaultEngine.validateAction(action, context)).rejects.toThrow(OrchestratorError);
      await expect(defaultEngine.validateAction(action, context)).rejects.toMatchObject({
        code: 'POLICY_INPUT_INVALID',
      });
    });
  });

  describe('createSalesOrchestratorFactory', () => {
    it('fails closed when audit HMAC secret is missing', () => {
      expect(() =>
        createSalesOrchestratorFactory({
          auditSecret: '',
        }),
      ).toThrow('SALES_AUDIT_SECRET_REQUIRED');
    });

    it('reports all unbound capabilities when ports are unconfigured', () => {
      const unbound = getSalesUnboundCapabilities({});
      expect(unbound).toContain('API-001 (unbound ERP read: no ERP read connector is bound)');
      expect(unbound).toContain('API-001.PricingEngine (unbound price/floor: no pricing engine port is bound; skill.sales.check_price refuses)');
      expect(unbound).toContain('API-002.CommerceCartAPI (unbound cart: no cart port is bound; skill.sales.create_cart refuses)');
      expect(unbound).toContain('API-001.OrderConnector (unbound order: no order connector port is bound; skill.sales.create_order refuses)');
      expect(unbound).toContain('API-003.CommunicationConnector (unbound communication: no communication port is bound; skill.sales.send_message refuses)');
      expect(unbound).toContain('SalesConsent (unbound consent: no consent port is bound; skill.sales.send_message refuses)');
      expect(unbound).toContain('SalesFrequencyCap (unbound frequency cap: no frequency cap port is bound; skill.sales.send_message refuses)');
      expect(unbound).toContain('SalesReplenishmentPolicy (unbound replenishment policy: no replenishment policy port is bound; SAL-05 replenishment refuses)');
    });

    it('threads consent port into sales policy engine', async () => {
      const consentPort: SalesConsentPort = {
        read: vi.fn(async () => ({ consented: true, suppressed: false })),
        getConsent: vi.fn(async () => ({ consent_marketing: true, suppression_active: false })),
      };

      const orchestratorFactory = createSalesOrchestratorFactory({
        auditSecret: 'test-secret',
        consent: consentPort,
      });
      expect(orchestratorFactory).toBeDefined();
    });
  });
});

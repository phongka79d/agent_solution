import { describe, expect, it, vi } from 'vitest';
import type {
  ActionDraft,
  AgentRunLogRecord,
  IAuditTrail,
  ExecutionReceipt,
  HydratedContext,
  IEvidenceLogger,
  ImmutableEvidenceRecord,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';
import { createEvidenceChainLink, MemoryEffectGuard, MemoryWorkflowEngine, RevenueOrchestrator } from '@agentos/core-engine';
import type { ConnectorBindingRecord } from '@agentos/database';
import { createConnectorRegistry } from '../connector-registry.js';
import { DEFAULT_PLAN_INPUT_RESOLVER } from '../shared/adapters.js';
import { SalesAgentRuntime } from './agent-runtime.js';
import type { SkillRegistryPort, SkillRegistryRowMetadata } from './agent-runtime.js';
import { createErpSalesCartPort } from './erp-cart-port.js';
import { createErpSalesOrderPort } from './erp-order-port.js';
import { createSalesPolicyEngine } from './policy-engine.js';
import { createSalesSkillServices } from './skills/index.js';
import type { SalesPriceFloorPort } from './skills/types.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = 'cust-verified-77';

const registryRows: Record<string, SkillRegistryRowMetadata> = {
  'skill.sales.search_product': {
    skill_id: 'skill.sales.search_product',
    effect_class: 'READ',
    guarded_dependency: 'API-001.CatalogConnector',
    required_authority: 'AUTH-0',
    timeout_ms: 1500,
    allowed_agents: ['SAL-02'],
    enabled: true,
  },
  'skill.sales.check_stock': {
    skill_id: 'skill.sales.check_stock',
    effect_class: 'READ',
    guarded_dependency: 'API-001.InventoryConnector',
    required_authority: 'AUTH-0',
    timeout_ms: 3000,
    allowed_agents: ['SAL-02'],
    enabled: true,
  },
  'skill.sales.check_price': {
    skill_id: 'skill.sales.check_price',
    effect_class: 'READ',
    guarded_dependency: 'API-001.PricingEngine',
    required_authority: 'AUTH-3',
    timeout_ms: 2000,
    allowed_agents: ['SAL-02'],
    enabled: true,
  },
  'skill.sales.create_cart': {
    skill_id: 'skill.sales.create_cart',
    effect_class: 'EFFECT',
    guarded_dependency: 'API-002.CommerceCartAPI',
    required_authority: 'AUTH-3',
    timeout_ms: 2000,
    allowed_agents: ['SAL-02'],
    enabled: true,
  },
  'skill.sales.create_order': {
    skill_id: 'skill.sales.create_order',
    effect_class: 'APPROVAL',
    guarded_dependency: 'API-001.OrderConnector',
    required_authority: 'AUTH-4',
    timeout_ms: 4000,
    allowed_agents: ['SAL-02'],
    enabled: true,
  },
};

function createRegistryPort(): SkillRegistryPort {
  return {
    get(skill_id) {
      return registryRows[skill_id] ?? null;
    },
  };
}

const verifiedContext: HydratedContext = {
  correlation_id: 'corr-sales-order',
  tenant_id: TENANT_ID,
  customer: {
    customer_id: CUSTOMER_ID,
    tenant_id: TENANT_ID,
    verified_phone: '+15551234567',
    verified_email: 'buyer@example.com',
    total_spent: 0,
    order_count: 0,
    rfm_segment_hypothesis: 'NEW',
    consent_marketing: false,
    consent_updated_at: null,
    suppression_active: false,
    created_at: '2026-09-01T00:00:00Z',
  },
  working_memory: {
    session_id: 'session-verified-order',
    last_touch_channel: 'web',
    turn_count: 1,
    takeover_active: false,
  },
  knowledge_citations: [],
  hydrated_at: '2026-09-01T00:00:00Z',
  run_state: {
    sales: {
      default_shipping_address: {
        recipient_name: 'Test Buyer',
        phone: '+15551234567',
        postal_code: '10001',
        city: 'Metro',
        district: 'Central',
        address_line1: '10 Main Street',
      },
    },
  },
};

interface OrderRequestFixture {
  readonly sku_id?: string;
  readonly quantity: number;
  readonly payment_method?: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
}

const orderRequest: OrderRequestFixture = {
  sku_id: 'SKU-ORDER-12',
  quantity: 2,
  payment_method: 'CVS_COD',
};

function orderSignal(request: OrderRequestFixture = orderRequest): SignalEnvelope {
  return {
    signal_id: 'sig-sales-order',
    tenant_id: TENANT_ID,
    correlation_id: 'corr-sales-order',
    source_channel: 'WEB_CHAT',
    event_type: 'message.received',
    timestamp: '2026-09-01T00:00:00Z',
    subject: { session_id: 'session-verified-order', channel_type: 'web' },
    payload: {
      module: 'sales',
      message: 'Please order SKU-ORDER-12 qty 2 for $0.01',
      sales_proposal_source: 'API_GATEWAY',
      sales_intent: 'purchase',
      sales_order_request: request,
      sales_intent_metadata: { proposed_price: 0.01 },
    },
  };
}

describe('Sales explicit order planning', () => {
  it('binds authoritative price and cart receipts while requiring AUTH-4 for the order', async () => {
    const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
    const signal = orderSignal();

    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    expect(hypothesis.intent).toBe('purchase');
    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    expect(routing.requires_clarification).toBe(false);

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps.map((step) => step.skill_id)).toEqual([
      'skill.sales.search_product',
      'skill.sales.check_stock',
      'skill.sales.check_price',
      'skill.sales.create_cart',
      'skill.sales.create_order',
    ]);
    const cart = plan.steps[3]!;
    expect(cart.input_parameters).toMatchObject({
      tenant_id: TENANT_ID,
      session_id: 'session-verified-order',
      customer_id: CUSTOMER_ID,
      items: [{ sku_id: 'SKU-ORDER-12', quantity: 2 }],
    });
    expect(cart.input_parameters).not.toHaveProperty('proposed_price');
    expect(cart.input_bindings).toEqual({
      proposed_price: { source_step_index: 3, response_path: 'final_price' },
    });
    const order = plan.steps[4]!;
    expect(order).toMatchObject({
      skill_id: 'skill.sales.create_order',
      required_authority: 'AUTH-4',
      mutating: true,
      input_parameters: {
        tenant_id: TENANT_ID,
        cart_id: '',
        customer_id: CUSTOMER_ID,
        shipping_address: verifiedContext.run_state?.sales?.default_shipping_address,
        payment_method: 'CVS_COD',
      },
      input_bindings: {
        cart_id: { source_step_index: 4, response_path: 'cart_id' },
      },
    });
    expect(order.input_parameters).not.toHaveProperty('proposed_price');
  });

  it('plans an explicitly connected ERP order and pauses at AUTH-4 without dispatching the order', async () => {
    const binding: ConnectorBindingRecord = {
      tenant_id: TENANT_ID,
      connector_id: 'API-001',
      status: 'BOUND',
      mode: 'MOCK',
      config: { base_url: 'http://connected-erp.invalid/api/v1', auth_scheme: 'HMAC_MOCK' },
      secret_id: 'connected-erp-secret',
      bound_at: '2026-10-01T00:00:00.000Z',
      probe_outcome: 'PASS',
      probe_latency_ms: 1,
      probe_http_status: 200,
      probe_error_class: null,
      probed_at: '2026-10-01T00:00:00.000Z',
      version: 5,
    };
    const fetch = vi.fn(async () => ({ status: 200, text: async () => '{}' }));
    const connectors = createConnectorRegistry({
      bindings: { get: async () => binding },
      secrets: { resolve: async () => 'unit-test-erp-secret' },
      env: {},
      dataClassOf: async () => 'TEST',
      hmac: () => 'test-signature',
      fetch,
    });
    const erp = await connectors.erpFor(TENANT_ID);
    const price_floor: SalesPriceFloorPort = {
      read: async () => ({
        list_price: 120,
        currency: 'USD',
        p_floor: 100,
        floor_source: 'unit-test-owner-policy',
        owner_approved: true,
        quote_ttl_seconds: 300,
      }),
    };
    const services = createSalesSkillServices({
      erp_read: erp,
      context: { verifiedCustomerFor: (context) => context.customer, verifiedTimelineFor: () => null },
      price_floor,
      cart: createErpSalesCartPort(erp, { price_floor, quote_signing_secret: 'unit-test-quote-secret' }),
      order: createErpSalesOrderPort(erp),
      quote_signing_secret: 'unit-test-quote-secret',
      resolve_correlation_id: async () => 'corr-sales-order',
      resolve_grant: async () => 'AUTH-3',
    });
    const runtime = new SalesAgentRuntime({ registry: services.registry });
    const signal = orderSignal({ sku_id: 'NM-L01-BLK', quantity: 1, payment_method: 'STRIPE' });
    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);
    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps.map((step) => step.skill_id)).toEqual(Object.keys(registryRows));

    const records: ImmutableEvidenceRecord[] = [];
    const receipts = new Map<number, ExecutionReceipt>();
    const evidenceLogger: IEvidenceLogger = {
      createImmutableRecord: async (input) => {
        const receipt = receipts.get(input.step_index);
        const record = {
          ...createEvidenceChainLink({ ...input, secret: 'unit-test-audit-secret' }),
          ...(receipt === undefined ? {} : { receipt }),
        };
        records.push(record);
        return record;
      },
      findImmutableRecord: async (input) => records.find((record) =>
        record.tenant_id === input.tenant_id && record.run_id === input.run_id
        && record.step_index === input.step_index && record.effect_key === input.effect_key) ?? null,
      initializeOutcomeWatch: async () => undefined,
      logAgentRun: async () => undefined,
    };
    const dispatch = vi.fn(async (action: ActionDraft): Promise<ExecutionReceipt> => {
      const receipt: ExecutionReceipt = {
        execution_id: `receipt-${action.step_index}`,
        adapter_status: 'SUCCESS',
        provider_reference: `provider-${action.step_index}`,
        response_payload: action.skill_id === 'skill.sales.search_product'
          ? { products: [{ sku: 'NM-L01-BLK' }] }
          : action.skill_id === 'skill.sales.check_stock'
            ? { sku_id: 'NM-L01-BLK', available: true }
            : action.skill_id === 'skill.sales.check_price'
              ? { final_price: 120 }
              : { cart_id: 'bound-erp-cart' },
        latency_ms: 1,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      receipts.set(action.step_index, receipt);
      return receipt;
    });
    const workflow = new MemoryWorkflowEngine();
    const auditRecords: AgentRunLogRecord[] = [];
    const auditTrail: IAuditTrail = {
      append: async (record) => { auditRecords.push(record); },
    };
    const orchestrator = new RevenueOrchestrator({
      contextAggregator: { hydrateContext: async () => verifiedContext },
      agentRuntime: runtime,
      policyEngine: createSalesPolicyEngine({ price_floor, auditSecret: 'unit-test-audit-secret', auditTrail }),
      workflowEngine: workflow,
      evidenceLogger,
      planInputResolver: DEFAULT_PLAN_INPUT_RESOLVER,
      auditTrail,
      adapterDispatcher: { dispatch },
      effectGuard: new MemoryEffectGuard(),
      sessionControl: { isTakenOver: async () => false, returnToAgent: async () => undefined },
      leaseManager: { acquireLease: async () => true, releaseLease: async () => undefined },
      workerId: 'connected-order-unit',
    });

    const result = await orchestrator.processSignal(signal);
    expect(result.lifecycle_state, result.message).toBe('awaiting_human');
    expect((await workflow.getTask(TENANT_ID, result.run_id))?.state).toBe('awaiting_human');
    expect(dispatch.mock.calls.map(([action]) => action.skill_id)).toEqual(Object.keys(registryRows).slice(0, 4));
    expect(workflow.listApprovals(TENANT_ID, result.run_id)).toHaveLength(1);
    expect(workflow.listApprovals(TENANT_ID, result.run_id)[0]).toMatchObject({
      decision: 'PENDING',
      payload: expect.objectContaining({ cart_id: 'bound-erp-cart', payment_method: 'STRIPE' }),
    });
    expect(auditRecords).toContainEqual(expect.objectContaining({
      trigger: 'policy_enforcement',
      skill: 'skill.sales.create_order',
      authority: 'AUTH-4',
      decision: expect.objectContaining({ verdict: 'AWAITING_HUMAN_APPROVAL' }),
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['skill.sales.create_cart', 'skill.sales.create_order'])('returns a typed refusal for a locally disabled %s even without a gate', async (skill_id) => {
    const runtime = new SalesAgentRuntime({
      registry: { get: (id) => id === skill_id && registryRows[id] !== undefined
        ? { ...registryRows[id], enabled: false }
        : registryRows[id] ?? null },
    });
    const signal = orderSignal();
    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.terminal_response).toMatchObject({
      response_kind: 'REFUSAL',
      template_key: 'core.skill_unavailable',
      reason_code: 'SKILL_UNAVAILABLE',
    });
  });

  it('checks required purchase skills against the gate even when local binding checks emptied the plan', async () => {
    const runtime = new SalesAgentRuntime({
      registry: { get: (id) => id === 'skill.sales.create_order' ? null : registryRows[id] ?? null },
      gate: {
        available: async (_tenant_id, skill_id) => skill_id === 'skill.sales.create_order'
          ? { available: false, reason: 'CONNECTOR_UNBOUND' }
          : { available: true, reason: 'OK' },
      },
    });
    const signal = orderSignal();
    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.terminal_response).toMatchObject({
      response_kind: 'REFUSAL',
      template_key: 'core.skill_unavailable',
      reason_code: 'CONNECTOR_UNBOUND',
    });
  });

  it('requires identity, SKU, address, and stated payment before any order mutation', async () => {
    const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
    const anonymousContext: HydratedContext = {
      ...verifiedContext,
      customer: null,
      run_state: { sales: {} },
    };
    const anonymousSignal = orderSignal();
    const anonymousHypothesis = await runtime.deriveHypothesis(anonymousSignal, anonymousContext);
    const anonymousRoute = await runtime.resolveRouting(anonymousSignal, anonymousContext, anonymousHypothesis);
    expect(anonymousRoute.clarification_template_key).toBe('sales.identity_required');
    expect((await runtime.formulatePlan(anonymousRoute, anonymousContext, anonymousHypothesis)).steps).toHaveLength(0);

    const missingSkuSignal = orderSignal({ quantity: 1 });
    const missingSkuHypothesis = await runtime.deriveHypothesis(missingSkuSignal, verifiedContext);
    const missingSkuRoute = await runtime.resolveRouting(missingSkuSignal, verifiedContext, missingSkuHypothesis);
    expect(missingSkuRoute.clarification_template_key).toBe('sales.need_sku');
    expect((await runtime.formulatePlan(missingSkuRoute, verifiedContext, missingSkuHypothesis)).steps).toHaveLength(0);

    const addressMissingContext: HydratedContext = {
      ...verifiedContext,
      run_state: { sales: {} },
    };
    const addressMissingSignal = orderSignal({ sku_id: 'SKU-ORDER-12', quantity: 2, payment_method: 'CVS_COD' });
    const addressMissingHypothesis = await runtime.deriveHypothesis(addressMissingSignal, addressMissingContext);
    const addressMissingRoute = await runtime.resolveRouting(addressMissingSignal, addressMissingContext, addressMissingHypothesis);
    expect(addressMissingRoute.clarification_template_key).toBe('sales.need_shipping_or_payment');
    expect((await runtime.formulatePlan(addressMissingRoute, addressMissingContext, addressMissingHypothesis)).steps).toHaveLength(0);

    const paymentMissingSignal = orderSignal({ sku_id: 'SKU-ORDER-12', quantity: 2 });
    const paymentMissingHypothesis = await runtime.deriveHypothesis(paymentMissingSignal, verifiedContext);
    const paymentMissingRoute = await runtime.resolveRouting(paymentMissingSignal, verifiedContext, paymentMissingHypothesis);
    expect(paymentMissingRoute.clarification_template_key).toBe('sales.need_shipping_or_payment');
    expect((await runtime.formulatePlan(paymentMissingRoute, verifiedContext, paymentMissingHypothesis)).steps).toHaveLength(0);
  });

  it('refuses atomically when any required skill is unavailable, without retaining a cart mutation', async () => {
    const runtime = new SalesAgentRuntime({
      registry: createRegistryPort(),
      gate: {
        async available(_tenant_id, skill_id) {
          return skill_id === 'skill.sales.create_order'
            ? { available: false, reason: 'DISABLED_BY_TENANT' }
            : { available: true, reason: 'OK' };
        },
      },
    });
    const signal = orderSignal();
    const hypothesis = await runtime.deriveHypothesis(signal, verifiedContext);
    const routing = await runtime.resolveRouting(signal, verifiedContext, hypothesis);

    const plan = await runtime.formulatePlan(routing, verifiedContext, hypothesis);
    expect(plan.steps).toHaveLength(0);
    expect(plan.terminal_response).toMatchObject({
      response_kind: 'REFUSAL',
      reason_code: 'DISABLED_BY_TENANT',
    });
  });

  it('rejects structured purchase details outside the API gateway message path', async () => {
    const runtime = new SalesAgentRuntime({ registry: createRegistryPort() });
    const signal = {
      ...orderSignal(),
      source_channel: 'INTERNAL_EVENT',
    } as SignalEnvelope;

    await expect(runtime.deriveHypothesis(signal, verifiedContext)).rejects.toMatchObject({
      code: 'SALES_STRUCTURED_INTENT_INVALID',
    });
  });
});

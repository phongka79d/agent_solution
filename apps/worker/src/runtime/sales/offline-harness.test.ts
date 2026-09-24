import { computeEffectKey } from '@agentos/core-engine';
import type { ActionDraft } from '@agentos/core-engine/contracts';
import { describe, expect, it } from 'vitest';

import {
  createSalesOfflineHarness,
  PILOT_02_OFFLINE_FIXTURE,
  SALES_P2_DISABLED_SKILLS,
} from './index.js';

const readContext = {
  run_id: 'run-pilot-02',
  tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
  caller_agent: 'SAL-02',
  correlation_id: PILOT_02_OFFLINE_FIXTURE.correlation_id,
  granted_authority: 'AUTH-0' as const,
  effect_key: 'effect-pilot-02-read',
};

function disabledMutationAction(): ActionDraft {
  const skill_id = 'skill.sales.create_cart';
  const request_id = 'request-pilot-02-cart';
  return {
    action_id: '00000000-0000-0000-0000-000000000002',
    run_id: 'run-pilot-02',
    tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
    agent_id: 'SAL-02',
    skill_id,
    adapter_target: 'API-002.CommerceCartAPI',
    step_index: 1,
    mutating: true,
    price_bearing: false,
    request_id,
    action_revision: 0,
    effect_key: computeEffectKey({
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      skill_id,
      step_index: 1,
      action_revision: 0,
      request_id,
    }),
    required_authority: 'AUTH-3',
    payload: {
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      session_id: 'sess-a-1',
      items: [{ sku_id: 'SKU-OK', quantity: 1 }],
      idempotency_key: 'pilot-02-cart-key',
    },
  };
}

describe('SalesOfflineHarness', () => {
  it('maps the synthetic PILOT-02 catalog and inventory through authoritative envelopes', async () => {
    const harness = createSalesOfflineHarness();
    const products = await harness.erp_read!.read({
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      resource: 'products',
    });
    const inventory = await harness.erp_read!.read({
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      resource: 'inventory',
      key: 'SKU-OK',
    });

    expect(products).toMatchObject({
      resource: 'products',
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      observed_at: PILOT_02_OFFLINE_FIXTURE.observed_at,
      value: {
        tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
        snapshot_at: PILOT_02_OFFLINE_FIXTURE.observed_at,
        items: [{ sku: 'SKU-OK', original_list_price: 1000 }],
      },
    });
    expect(inventory.value).toEqual({
      tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
      snapshot_at: PILOT_02_OFFLINE_FIXTURE.observed_at,
      items: [{
        tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
        sku_id: 'SKU-OK',
        total_available_to_promise: 12,
      }],
    });
    expect(harness.read_calls).toEqual([
      { tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id, resource: 'products' },
      { tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id, resource: 'inventory', key: 'SKU-OK' },
    ]);
  });

  it('executes the real read-only Sales tool port over verified Customer360 fixture seams', async () => {
    const harness = createSalesOfflineHarness();
    const services = harness.createSkillServices();

    const customer = await services.tool_port.invoke({
      skill_id: 'skill.sales.retrieve_customer',
      tool_binding: 'PostgreSQL.Customer360Store',
      input: {
        tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
        customer_identifier: 'cust-a',
      },
      context: readContext,
    });
    const recommendation = await services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
        customer_id: 'cust-a',
        current_cart_skus: [],
      },
      context: { ...readContext, caller_agent: 'SAL-03', granted_authority: 'AUTH-1' as const },
    });

    expect(customer).toEqual({
      customer_id: 'cust-a',
      total_orders: 1,
      lifetime_value: 1000,
      verified: true,
      rfm_segment: 'LOYAL',
      last_order_date: null,
    });
    expect(recommendation).toMatchObject({
      customer: 'cust-a',
      product: { sku: 'SKU-OK', name: 'Aurora Ceramic Mug 350ml', price: 1000 },
      evidence: {
        verified_timeline_event_ids: ['event-pilot-02-product-view'],
        verified_model: 'pilot-02-owner-model',
      },
      eligibility: {
        stock_available: true,
        consent_verified: true,
        suppression_cleared: true,
      },
      expected_outcome: {
        conversion_probability: 0.7,
        expected_revenue: 700,
        currency: 'TWD',
      },
    });
  });

  it('refuses foreign tenant reads and context without disclosing fixture data', async () => {
    const harness = createSalesOfflineHarness();
    const foreignTenant = '22222222-2222-2222-2222-222222222222';

    await expect(harness.erp_read!.read({
      tenant_id: foreignTenant,
      resource: 'products',
    })).rejects.toMatchObject({
      code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
    });
    expect(harness.context.verifiedCustomerFor(foreignTenant, PILOT_02_OFFLINE_FIXTURE.correlation_id)).toBeNull();
    expect(harness.context.verifiedTimelineFor(foreignTenant, PILOT_02_OFFLINE_FIXTURE.correlation_id)).toBeNull();
    expect(harness.read_calls).toEqual([
      { tenant_id: foreignTenant, resource: 'products' },
    ]);
  });

  it('rejects an invalid provider timestamp before exposing a fixture adapter', () => {
    expect(() => createSalesOfflineHarness({
      fixture: { ...PILOT_02_OFFLINE_FIXTURE, observed_at: 'not-a-provider-time' },
    })).toThrow('observed_at must be a provider timestamp');
  });

  it('fails closed when API-001 is unbound', async () => {
    const harness = createSalesOfflineHarness({ erp_available: false });
    const services = harness.createSkillServices();

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.search_product',
      tool_binding: 'API-001.CatalogConnector',
      input: { tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id, query: 'mug' },
      context: readContext,
    })).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
    expect(harness.erp_read).toBeNull();
    expect(harness.effect_dispatches).toEqual([]);
  });

  it('fails closed when owner-approved floor provenance is missing', () => {
    const harness = createSalesOfflineHarness();
    let caught: unknown;
    try {
      harness.probeMissingFloorProvenance();
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'P_FLOOR_UNAVAILABLE' });
    expect(harness.effect_dispatches).toEqual([]);
  });

  it.each(SALES_P2_DISABLED_SKILLS)('refuses prepared disabled skill %s without an effect dispatch', (skill_id) => {
    const harness = createSalesOfflineHarness();
    let caught: unknown;
    try {
      harness.probeDisabledSkill(skill_id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'SKILL_DISABLED' });
    expect(harness.effect_dispatches).toEqual([]);
  });

  it('stops a disabled mutation row before the real Sales dispatcher can reach an adapter', async () => {
    const harness = createSalesOfflineHarness();
    const services = harness.createSkillServices();

    await expect(services.dispatcher.dispatch(disabledMutationAction())).rejects.toMatchObject({
      code: 'SKILL_DISABLED',
    });
    expect(harness.read_calls).toEqual([]);
    expect(harness.effect_dispatches).toEqual([]);
  });

  it('refuses recommendation when the owner-approved revenue source is unbound', async () => {
    const harness = createSalesOfflineHarness({ revenue_evidence_available: false });
    const services = harness.createSkillServices();

    await expect(services.tool_port.invoke({
      skill_id: 'skill.sales.recommend_product',
      tool_binding: 'Core.RecommendationEngine',
      input: {
        tenant_id: PILOT_02_OFFLINE_FIXTURE.tenant_id,
        customer_id: 'cust-a',
        current_cart_skus: [],
      },
      context: { ...readContext, caller_agent: 'SAL-03', granted_authority: 'AUTH-1' as const },
    })).rejects.toMatchObject({ code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
    expect(harness.effect_dispatches).toEqual([]);
  });
});

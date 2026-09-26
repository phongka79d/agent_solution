/**
 * @file The internal handoff channel's ingress boundary (implement/09 §1.1 Gate P4).
 *
 * `ORCHESTRATOR_HANDOFF` is an INTERNAL channel: the broker writes it into a target run's signal
 * only after a durable admission, and no customer-facing route may present it. These cases pin the
 * registry's own half of that boundary — which signal each domain binding accepts — so a change
 * that widens a contract fails here rather than in production.
 *
 * They do not stand in for the missing `TC-E2E-001..009` suite: no API route is exercised, and the
 * HTTP admission path remains unproven (see `blocked.md`).
 */

import { describe, expect, it } from 'vitest';

import type { RevenueOrchestrator } from '@agentos/core-engine';

import {
  CARE_SIGNAL_CONTRACT,
  VALID_AGENT_MODULES,
  CROSS_DOMAIN_HANDOFF_CHANNEL,
  CROSS_DOMAIN_HANDOFF_EVENT_TYPES,
} from '../../worker.js';
import { createDomainRuntimeRegistry } from '../domain-registry.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CORRELATION = 'corr-p4-ingress';
const CUSTOMER = '01920000-0000-7000-8000-0000000000c1';

/** A registry with one binding per domain, as `startWorker` composes it. */
function registry() {
  const binding = (module: string, source_channels: string[], event_types: string[]) => ({
    contract: { module, source_channels, event_types, signal_invalid_code: `${module.toUpperCase()}_INVALID` },
    createOrchestrator: (): RevenueOrchestrator | null => null,
  });

  return createDomainRuntimeRegistry([
    binding('support', [...CARE_SIGNAL_CONTRACT.source_channels], [...CARE_SIGNAL_CONTRACT.event_types]),
    binding('sales', ['WEB_CHAT', CROSS_DOMAIN_HANDOFF_CHANNEL], ['cart.abandoned', CROSS_DOMAIN_HANDOFF_EVENT_TYPES['marketing_to_sales'] as string]),
    binding('marketing', ['WEB_CHAT'], ['campaign.requested']),
  ]);
}

/** The signal the broker writes into a target run, as the admission path builds it. */
function handoffSignal(event_type: string, module: string, channel = CROSS_DOMAIN_HANDOFF_CHANNEL) {
  return {
    signal_id: 'sig-1',
    tenant_id: TENANT,
    correlation_id: CORRELATION,
    source_channel: channel,
    event_type,
    payload: { module, handoff: { target_domain: module, reason: 'leg completed' } },
    subject: { session_id: 'sess-1', channel_type: 'orchestrator', verified_customer_id: CUSTOMER },
    timestamp: '2026-09-26T10:00:00.000Z',
  };
}

describe('internal handoff channel ingress', () => {
  it('resolves each canonical leg to its domain binding', () => {
    const domains = registry();

    expect(
      domains.accepts(handoffSignal(CROSS_DOMAIN_HANDOFF_EVENT_TYPES['marketing_to_sales'] as string, 'sales'), {
        tenant_id: TENANT,
        correlation_id: CORRELATION,
      })?.contract.module,
    ).toBe('sales');

    expect(
      domains.accepts(handoffSignal(CROSS_DOMAIN_HANDOFF_EVENT_TYPES['sales_to_care'] as string, 'support'), {
        tenant_id: TENANT,
        correlation_id: CORRELATION,
      })?.contract.module,
    ).toBe('support');

    // The retention leg runs on the SAME Care module: no fourth worker module exists.
    expect(VALID_AGENT_MODULES).toEqual(['support', 'sales', 'marketing']);
    expect(
      domains.accepts(handoffSignal(CROSS_DOMAIN_HANDOFF_EVENT_TYPES['care_to_retention'] as string, 'support'), {
        tenant_id: TENANT,
        correlation_id: CORRELATION,
      })?.contract.module,
    ).toBe('support');
  });

  it('does not admit a handoff signal on a customer-facing channel', () => {
    const domains = registry();

    for (const channel of ['WEB_CHAT', 'LINE', '']) {
      expect(
        domains.accepts(
          handoffSignal(CROSS_DOMAIN_HANDOFF_EVENT_TYPES['marketing_to_sales'] as string, 'sales', channel),
          { tenant_id: TENANT, correlation_id: CORRELATION },
        ),
      ).toBeNull();
    }
  });

  it('does not admit a handoff event type on a channel the target domain never declared', () => {
    const domains = registry();

    // A support-bound handoff named on the marketing binding's event list is not a Marketing run.
    expect(domains.accepts(handoffSignal('handoff.sales_to_care', 'marketing'), {
      tenant_id: TENANT,
      correlation_id: CORRELATION,
    })).toBeNull();
  });

  it('refuses a handoff signal that leaves its tenant or correlation', () => {
    const domains = registry();
    const signal = handoffSignal(CROSS_DOMAIN_HANDOFF_EVENT_TYPES['marketing_to_sales'] as string, 'sales');

    expect(domains.accepts({ ...signal, tenant_id: '22222222-2222-4222-8222-222222222222' }, {
      tenant_id: TENANT,
      correlation_id: CORRELATION,
    })).toBeNull();
    expect(domains.accepts(signal, { tenant_id: TENANT, correlation_id: 'corr-other' })).toBeNull();
  });
});

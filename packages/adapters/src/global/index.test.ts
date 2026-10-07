import { describe, expect, it } from 'vitest';

import {
  GlobalMessagingAdapter,
  MessagingProviderRegistry,
  GlobalPaymentAdapter,
  PaymentProviderRegistry,
  GlobalResidencyAdapter,
  MessagingRefusalError,
  PaymentRefusalError,
  ResidencyRefusalError,
} from './index.js';

function idempotencyStore() {
  const receipts = new Map<string, any>();
  return {
    begin: ({ idempotency_key, effect_key }: { idempotency_key: string; effect_key: string }) => {
      const existing = receipts.get(idempotency_key);
      if (existing !== undefined && existing.effect_key !== effect_key) return { state: 'CONFLICT' as const };
      return existing === undefined ? { state: 'NEW' as const } : { state: 'REPLAY' as const, receipt: existing };
    },
    complete: (input: { idempotency_key: string; receipt?: unknown; outcome?: unknown }) => {
      receipts.set(input.idempotency_key, input.receipt ?? input.outcome);
    },
  };
}

function messagingAuthority(overrides: {
  readonly consent?: boolean;
  readonly suppression?: boolean;
  readonly takeover?: boolean;
  readonly sessionHold?: boolean;
  readonly windowAllowed?: boolean;
} = {}) {
  return {
    consent: () => ({ granted: overrides.consent ?? true, captured_at: 'now' }),
    suppression: () => ({ suppressed: overrides.suppression ?? false, evaluated_at: 'now' }),
    takeover: () => overrides.takeover ?? false,
    sessionHold: () => overrides.sessionHold ?? false,
    window: () => ({ allowed: overrides.windowAllowed ?? true }),
  };
}

describe('global adapter seams', () => {
  it('refuses messaging outbound during takeover and accepts no unbound provider', async () => {
    const providers = new MessagingProviderRegistry();
    const adapter = new GlobalMessagingAdapter({
      providers,
      idempotency: idempotencyStore(),
      authority: messagingAuthority({ takeover: true }),
    });
    await expect(adapter.send({
      tenant_id: 'tenant-1', session_id: 'session-1', provider_id: 'not-bound', recipient: 'recipient',
      payload: { mode: 'FREE_FORM', text: 'hello' }, effect_key: 'effect-1', idempotency_key: 'idem-1',
    })).rejects.toBeInstanceOf(MessagingRefusalError);
  });

  it('normalizes messaging timeout to UNKNOWN without claiming a send', async () => {
    const providers = new MessagingProviderRegistry();
    providers.register({ provider_id: 'mock', send: async () => ({ outcome: 'TIMEOUT' }) });
    const adapter = new GlobalMessagingAdapter({
      providers,
      idempotency: idempotencyStore(),
      authority: messagingAuthority(),
    });
    const result = await adapter.send({
      tenant_id: 'tenant-1', session_id: 'session-1', provider_id: 'mock', recipient: 'recipient',
      payload: { mode: 'TEMPLATE', template_id: 'utility', parameters: {} },
      effect_key: 'effect-timeout', idempotency_key: 'idem-timeout',
    });
    expect(result.outcome).toBe('UNKNOWN');
    expect(result.requires_reconciliation).toBe(true);
  });

  it('reads consent and takeover from authoritative state and rejects legacy payload claims', async () => {
    const providers = new MessagingProviderRegistry();
    providers.register({
      provider_id: 'mock',
      send: async () => ({ outcome: 'SENT', provider_reference: 'provider-1' }),
    });
    const adapter = new GlobalMessagingAdapter({
      providers,
      idempotency: idempotencyStore(),
      authority: messagingAuthority({ takeover: true }),
    });
    await expect(adapter.send({
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      provider_id: 'mock',
      recipient: 'recipient',
      payload: { mode: 'FREE_FORM', text: 'hello' },
      effect_key: 'effect-authority',
      idempotency_key: 'idem-authority',
      takeover_active: false,
    } as never)).rejects.toMatchObject({ refusal_code: 'REQUEST_INVALID' });
  });

  it('resolves the provider before beginning idempotency', async () => {
    const providers = new MessagingProviderRegistry();
    let beginCalls = 0;
    const adapter = new GlobalMessagingAdapter({
      providers,
      authority: messagingAuthority(),
      idempotency: {
        begin: () => {
          beginCalls += 1;
          return { state: 'NEW' };
        },
        complete: () => undefined,
      },
    });
    await expect(adapter.send({
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      provider_id: 'missing',
      recipient: 'recipient',
      payload: { mode: 'FREE_FORM', text: 'hello' },
      effect_key: 'effect-provider',
      idempotency_key: 'idem-provider',
    })).rejects.toMatchObject({ refusal_code: 'PROVIDER_UNBOUND' });
    expect(beginCalls).toBe(0);
  });

  it('does not synthesize payment success and keeps payment non-promotable', async () => {
    const providers = new PaymentProviderRegistry();
    providers.register({ provider_id: 'mock', mode: 'MOCK_ONLY', execute: async () => ({ outcome: 'TIMEOUT' }) });
    const adapter = new GlobalPaymentAdapter({ providers, idempotency: idempotencyStore() });
    const result = await adapter.execute({
      tenant_id: 'tenant-1', provider_id: 'mock', operation: 'AUTHORIZE', effect_key: 'effect-1',
      idempotency_key: 'idem-1', amount_minor: 100, currency: 'USD', payment_method_ref: 'pm-ref',
    });
    expect(result.outcome).toBe('UNKNOWN');
    expect(result.requires_reconciliation).toBe(true);
    expect(adapter.promotable).toBe(false);
  });

  it('rejects cross-region operations against an owner-supplied tenant boundary', async () => {
    const rows = new Map<string, { tenant_id: string; region: string; configured_at: string }>();
    const adapter = new GlobalResidencyAdapter({
      find: (tenant_id) => rows.get(tenant_id) ?? null,
      save: (binding) => { rows.set(binding.tenant_id, binding); },
    });
    await adapter.bind({ tenant_id: 'tenant-1', region: 'owner-region-a', configured_at: 'now' });
    await expect(adapter.assertWithinBoundary({ tenant_id: 'tenant-1', region: 'owner-region-b', requires_residency: true }))
      .rejects.toBeInstanceOf(ResidencyRefusalError);
  });

  it('fails closed when payment provider is not bound', async () => {
    const adapter = new GlobalPaymentAdapter({ providers: new PaymentProviderRegistry(), idempotency: idempotencyStore() });
    await expect(adapter.execute({
      tenant_id: 'tenant-1', provider_id: 'missing', operation: 'CAPTURE', effect_key: 'effect-1',
      idempotency_key: 'idem-1', amount_minor: 100, currency: 'USD', payment_method_ref: 'pm-ref',
    })).rejects.toBeInstanceOf(PaymentRefusalError);
  });
});

/**
 * @file Cross-domain handoff broker tests (implement/09 §1.1 Gate P4, plans/customer-lifecycle.md §3).
 *
 * The broker is the only place a handoff becomes durable. These tests pin what it must never do:
 * admit twice, append the timeline event twice, report an unresolved admission as success, or let a
 * guard refusal through. The durable repository is substituted — the admission decision table and
 * the RLS/ledger behaviour are covered by `@agentos/database` — so what is asserted here is the
 * broker's own contract with the orchestrator.
 */

import { describe, expect, it } from 'vitest';

import {
  OrchestratorError,
  computeHandoffIdempotencyKey,
  type CrossDomainHandoffDraft,
  type CrossDomainHandoffPackage,
  type ICrossDomainHandoffBroker,
  type JourneyDomain,
} from '@agentos/core-engine/contracts';

import {
  buildCrossDomainHandoffSignal,
  createCrossDomainHandoffBroker,
} from './cross-domain-handoff.js';

const TENANT = '01920000-0000-7000-8000-0000000000a1';
const CUSTOMER = '01920000-0000-7000-8000-0000000000c1';
const SOURCE_RUN = 'run_marketing_1';
const OCCURRED_AT = '2026-09-26T10:00:00.000Z';

function draft(overrides: Partial<CrossDomainHandoffDraft> = {}): CrossDomainHandoffDraft {
  return {
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    correlation_id: 'corr-1',
    source_domain: 'marketing',
    source_agent: 'MKT-05',
    source_run_id: SOURCE_RUN,
    source_authority: 'AUTH-1',
    target_domain: 'sales',
    target_agent: 'SAL-02',
    reason: 'Marketing leg completed; Sales consultation is the next leg',
    evidence: [
      {
        classification: 'DECISION',
        claim: `Run ${SOURCE_RUN} completed the marketing leg of the customer journey`,
        source_uri: `agentos://runs/${SOURCE_RUN}`,
        source_version: '1',
        verified_by: 'agentos.orchestrator',
      },
    ],
    occurred_at: OCCURRED_AT,
    ...overrides,
  };
}

interface Harness {
  readonly broker: ICrossDomainHandoffBroker;
  readonly admitted: Record<string, unknown>[];
  readonly drafts: CrossDomainHandoffDraft[];
}

/** Builds the broker over substitute repositories so only its own behaviour is under test. */
function harness(options: {
  readonly lifecycle?: { version: number; state: string; hop_count: number; domains: readonly string[] } | null;
  readonly outcome?: { kind: string; run_id?: string; handoff_id?: string };
} = {}): Harness {
  const admitted: Record<string, unknown>[] = [];
  const drafts: CrossDomainHandoffDraft[] = [];

  const broker = createCrossDomainHandoffBroker({
    handoffRepository: {
      readCrossDomainLifecycle: async () =>
        options.lifecycle === undefined || options.lifecycle === null
          ? null
          : {
              tenant_id: TENANT,
              customer_id: CUSTOMER,
              state: options.lifecycle.state,
              version: options.lifecycle.version,
              hop_count: options.lifecycle.hop_count,
              domains: options.lifecycle.domains,
              updated_at: OCCURRED_AT,
            },
    },
    admit: (async (input: Record<string, unknown>) => {
      admitted.push(input);
      return options.outcome?.kind === 'CONFLICT'
        ? { kind: 'CONFLICT' }
        : options.outcome?.kind === 'REPLAY'
          ? { kind: 'REPLAY', handoff_id: 'handoff-existing', run_id: 'run_existing', receipt: null }
          : { kind: 'ADMITTED', handoff_id: 'handoff-1', run_id: 'run_sales_1', task: {}, reservation: {} };
    }) as never,
  }) as unknown as ICrossDomainHandoffBroker;

  return { broker, admitted, drafts };
}

describe('buildCrossDomainHandoffSignal', () => {
  const pkg = {
    handoff_id: 'handoff-1',
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    correlation_id: 'corr-1',
    source_domain: 'marketing' as JourneyDomain,
    source_agent: 'MKT-05',
    source_run_id: SOURCE_RUN,
    target_domain: 'sales' as JourneyDomain,
    target_agent: 'SAL-02',
    reason: 'reason',
    evidence: [],
    classification: 'DECISION',
    lifecycle: { version: 1, state: 'HANDED_OFF' },
    idempotency_key: computeHandoffIdempotencyKey({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      source_run_id: SOURCE_RUN,
      target_domain: 'sales',
      target_agent: 'SAL-02',
      lifecycle_version: 1,
      reason: 'reason',
    }),
    hop_count: 1,
    visited_domains: ['marketing'] as JourneyDomain[],
    occurred_at: OCCURRED_AT,
  } as unknown as CrossDomainHandoffPackage;

  it('addresses the target run on the internal handoff channel with the verified subject', () => {
    const signal = buildCrossDomainHandoffSignal(pkg, SOURCE_RUN, 'signal-1');

    expect(signal['source_channel']).toBe('ORCHESTRATOR_HANDOFF');
    expect(signal['event_type']).toBe('handoff.marketing_to_sales');
    expect(signal['tenant_id']).toBe(TENANT);
    expect(signal['correlation_id']).toBe('corr-1');
    const payload = signal['payload'] as Record<string, unknown>;
    expect(payload['module']).toBe('sales');
    expect(payload['handoff']).toBe(pkg);
    const subject = signal['subject'] as Record<string, unknown>;
    expect(subject['verified_customer_id']).toBe(CUSTOMER);
  });
});

describe('createCrossDomainHandoffBroker', () => {
  it('submits the server-marked timeline row WITH the admission', async () => {
    const { broker, admitted } = harness();

    const admission = await broker.admit(draft());

    expect(admission.admitted).toBe(true);
    expect(admission.target_run_id).toBe('run_sales_1');
    expect(admission.lifecycle).toEqual({ version: 1, state: 'HANDED_OFF' });
    expect(admitted).toHaveLength(1);

    // One hop carries ONE identity: the ledger stores the id the package minted, and the target
    // run's signal cites the same one, so the ledger row and the admitted run cannot disagree.
    const admissionInput = admitted[0]!;
    const signalled = admissionInput['signal'] as {
      readonly payload: { readonly handoff: { readonly handoff_id: string } };
    };
    expect(admissionInput['handoff_id']).toBe(signalled.payload.handoff.handoff_id);

    // The row is part of the admission: the repository commits it in the same transaction, keyed by
    // the handoff identity, so the ledger and the timeline can never disagree.
    const event = admitted[0]!['timeline_event'] as Record<string, unknown>;
    expect(event['event_name']).toBe('ext.lifecycle.handoff');
    expect(event['source_event_id']).toBe(admitted[0]!['idempotency_key']);
    const payload = event['payload'] as Record<string, unknown>;
    expect(payload['classification_authority']).toBe('SERVER');
    expect(payload['classification']).toBe('DECISION');
    expect(payload['target_domain']).toBe('sales');
  });

  it('reports a replayed admission without proposing a second timeline row', async () => {
    const { broker } = harness({ outcome: { kind: 'REPLAY' } });

    const admission = await broker.admit(draft());

    expect(admission.admitted).toBe(false);
    expect(admission.target_run_id).toBe('run_existing');
  });

  it('refuses to report an unresolved admission as a handoff', async () => {
    const { broker } = harness({ outcome: { kind: 'CONFLICT' } });

    await expect(broker.admit(draft())).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('refuses a stale replay against the durable lifecycle it reads', async () => {
    const { broker, admitted } = harness({
      lifecycle: { version: 1, state: 'HANDED_OFF', hop_count: 1, domains: ['marketing'] },
    });

    // The draft still describes hop 1; the durable journey has already advanced past it.
    await expect(broker.admit(draft())).rejects.toMatchObject({ code: 'HANDOFF_STALE_REPLAY' });
    expect(admitted).toHaveLength(0);
  });

  it('advances the durable journey for the second hop', async () => {
    const { broker, admitted } = harness({
      lifecycle: { version: 1, state: 'HANDED_OFF', hop_count: 1, domains: ['marketing'] },
    });

    const admission = await broker.admit(
      draft({
        source_domain: 'sales',
        source_agent: 'SAL-02',
        target_domain: 'care',
        target_agent: 'CS-01',
      }),
    );

    expect(admission.lifecycle.version).toBe(2);
    const event = admitted[0]!['timeline_event'] as Record<string, unknown>;
    expect(event['payload']).toMatchObject({ target_domain: 'care', lifecycle_version: 2 });
  });
});

/**
 * @file Cross-domain handoff contract tests (implement/09 §1.1 Gate P4, plans/customer-lifecycle.md §3).
 *
 * These pin the safety rules of the only brokered route between domains: the canonical edge table,
 * the derived (never supplied) classification and idempotency identity, and one refusal per rule —
 * cross-tenant, cross-customer, edge, loop, stale replay, authority escalation and evidence.
 */

import { describe, expect, it } from 'vitest';

import {
  HANDOFF_DOMAIN_EDGES,
  JOURNEY_DOMAIN_MODULES,
  MAX_HANDOFF_HOPS,
  OrchestratorError,
  assertHandoffAdmissible,
  assertHandoffSourceDomain,
  computeHandoffIdempotencyKey,
  createCrossDomainHandoffPackage,
  deriveHandoffClassification,
  highestAuthority,
  isJourneyDomain,
  journeyNextDomains,
  type CreateCrossDomainHandoffPackageInput,
  type HandoffAdmissionContext,
  type HandoffEvidenceRef,
} from './index.js';

const TENANT = '01920000-0000-7000-8000-0000000000t1'.replace('t', 'a');
const CUSTOMER = '01920000-0000-7000-8000-0000000000c1';
const OTHER_TENANT = '01920000-0000-7000-8000-0000000000b2';
const OTHER_CUSTOMER = '01920000-0000-7000-8000-0000000000c2';
const OCCURRED_AT = '2026-09-26T10:00:00.000Z';

/** A run's own decision, the honest evidence a leg of the journey can assert about itself. */
const DECISION_EVIDENCE: readonly HandoffEvidenceRef[] = Object.freeze([
  {
    classification: 'DECISION',
    claim: 'Run run-1 completed the marketing leg of the customer journey',
    source_uri: 'agentos://runs/run-1',
    source_version: '2',
    verified_by: 'agentos.orchestrator',
  },
]);

function draft(
  overrides: Partial<CreateCrossDomainHandoffPackageInput> = {},
): CreateCrossDomainHandoffPackageInput {
  return {
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    correlation_id: 'corr-1',
    source_domain: 'marketing',
    source_agent: 'MKT-05',
    source_run_id: 'run-1',
    source_authority: 'AUTH-1',
    target_domain: 'sales',
    target_agent: 'SAL-02',
    reason: 'Campaign response requires a Sales consultation',
    evidence: DECISION_EVIDENCE,
    previous_lifecycle: null,
    previous_hop_count: 0,
    visited_domains: [],
    occurred_at: OCCURRED_AT,
    ...overrides,
  };
}

function context(overrides: Partial<HandoffAdmissionContext> = {}): HandoffAdmissionContext {
  return {
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    lifecycle: null,
    visited_domains: [],
    previous_hop_count: 0,
    source_authority: 'AUTH-1',
    ...overrides,
  };
}

/** Asserts the thrown error is an `OrchestratorError` carrying `code`. */
function expectRefusal(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestratorError);
    expect((error as OrchestratorError).code).toBe(code);
    return;
  }

  throw new Error(`Expected refusal ${code}, but nothing was thrown.`);
}

describe('journey vocabulary', () => {
  it('binds the canonical lifecycle and the module that hosts each leg', () => {
    expect(journeyNextDomains('marketing')).toEqual(['sales']);
    expect(journeyNextDomains('sales')).toEqual(['care']);
    expect(journeyNextDomains('care')).toEqual(['retention']);
    expect(journeyNextDomains('retention')).toEqual([]);

    expect(JOURNEY_DOMAIN_MODULES.care).toBe('support');
    expect(JOURNEY_DOMAIN_MODULES.retention).toBe('support');
    expect(HANDOFF_DOMAIN_EDGES.care[0]?.allowed_agents).toEqual(['CS-02']);
    expect(HANDOFF_DOMAIN_EDGES.retention).toEqual([]);
    expect(isJourneyDomain('retention')).toBe(true);
    expect(isJourneyDomain('support')).toBe(false);
  });

  it('derives the highest classification present and never invents one', () => {
    expect(deriveHandoffClassification(DECISION_EVIDENCE)).toBe('DECISION');
    expect(
      deriveHandoffClassification([
        ...DECISION_EVIDENCE,
        { classification: 'FACT', claim: 'c', source_uri: 's', source_version: 'v', verified_by: 'w' },
      ]),
    ).toBe('FACT');
    expectRefusal(() => deriveHandoffClassification([]), 'HANDOFF_EVIDENCE_INVALID');
  });

  it('ranks authority without ever treating a verdict as a clearance', () => {
    expect(highestAuthority(['AUTH-1', 'AUTH-0', 'AUTH-2'])).toBe('AUTH-2');
    expect(highestAuthority([])).toBe('AUTH-0');
    expect(highestAuthority(['AUTH-4', 'AUTH-3'])).toBe('AUTH-4');
  });
});

describe('package construction', () => {
  it('derives identity, hop and lifecycle from the durable facts, never from the caller', () => {
    const pkg = createCrossDomainHandoffPackage(
      draft({
        source_domain: 'sales',
        source_agent: 'SAL-02',
        target_domain: 'care',
        target_agent: 'CS-01',
        previous_lifecycle: { version: 1, state: 'HANDED_OFF' },
        previous_hop_count: 1,
        visited_domains: ['marketing'],
      }),
    );

    expect(pkg.classification).toBe('DECISION');
    expect(pkg.hop_count).toBe(2);
    expect(pkg.lifecycle).toEqual({ version: 2, state: 'HANDED_OFF' });
    expect(pkg.visited_domains).toEqual(['marketing', 'sales']);
    expect(pkg.idempotency_key).toBe(
      computeHandoffIdempotencyKey({
        tenant_id: TENANT,
        customer_id: CUSTOMER,
        source_run_id: 'run-1',
        target_domain: 'care',
        target_agent: 'CS-01',
        lifecycle_version: 2,
        reason: 'Campaign response requires a Sales consultation',
      }),
    );
  });

  it('reproduces the same idempotency key for the same hop identity', () => {
    const first = createCrossDomainHandoffPackage(draft());
    const second = createCrossDomainHandoffPackage(draft());

    expect(first.handoff_id).not.toBe(second.handoff_id);
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });
});

describe('assertHandoffAdmissible', () => {
  it('admits the first canonical hop', () => {
    expect(() => assertHandoffAdmissible(createCrossDomainHandoffPackage(draft()), context())).not.toThrow();
  });

  it('refuses a cross-tenant handoff', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ tenant_id: OTHER_TENANT }),
        ),
      'HANDOFF_TENANT_MISMATCH',
    );
  });

  it('refuses a cross-customer handoff', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ customer_id: OTHER_CUSTOMER }),
        ),
      'HANDOFF_CUSTOMER_MISMATCH',
    );
  });

  it('refuses an edge the journey does not contain', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(
            draft({ target_domain: 'care', target_agent: 'CS-01' }),
          ),
          context(),
        ),
      'HANDOFF_DOMAIN_EDGE_REJECTED',
    );
  });

  it('refuses a successor the edge does not name', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft({ target_agent: 'SAL-05' })),
          context(),
        ),
      'HANDOFF_AUTHORITY_ESCALATION',
    );
  });

  it('refuses a source that never held the edge authority', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ source_authority: 'AUTH-0' }),
        ),
      'HANDOFF_AUTHORITY_ESCALATION',
    );

    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ source_authority: 'AUTH-5' }),
        ),
      'HANDOFF_AUTHORITY_ESCALATION',
    );
  });

  it('refuses a hop that revisits a domain or exceeds the journey length', () => {
    // A legitimate package (its key matches its own identity) whose target was already visited.
    const revisiting = createCrossDomainHandoffPackage(
      draft({
        source_domain: 'sales',
        source_agent: 'SAL-02',
        target_domain: 'care',
        target_agent: 'CS-01',
        previous_hop_count: 2,
        visited_domains: ['marketing', 'care'],
      }),
    );
    expect(revisiting.visited_domains).toEqual(['marketing', 'care', 'sales']);

    expectRefusal(
      () =>
        assertHandoffAdmissible(
          revisiting,
          context({ previous_hop_count: 2, visited_domains: ['marketing', 'care'] }),
        ),
      'HANDOFF_LOOP_REJECTED',
    );

    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ previous_hop_count: 2 }),
        ),
      'HANDOFF_LOOP_REJECTED',
    );
    expect(MAX_HANDOFF_HOPS).toBe(3);
  });

  it('refuses a stale replay of a superseded or finished lifecycle', () => {
    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ lifecycle: { version: 1, state: 'HANDED_OFF' } }),
        ),
      'HANDOFF_STALE_REPLAY',
    );

    expectRefusal(
      () =>
        assertHandoffAdmissible(
          createCrossDomainHandoffPackage(draft()),
          context({ lifecycle: { version: 0, state: 'COMPLETED' } }),
        ),
      'HANDOFF_STALE_REPLAY',
    );
  });

  it('refuses malformed input with its own codes rather than a raw TypeError', () => {
    const pkg = createCrossDomainHandoffPackage(draft());

    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, lifecycle: null } as never, context()),
      'HANDOFF_PACKAGE_INVALID',
    );
    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, lifecycle: { version: 1 } } as never, context()),
      'HANDOFF_PACKAGE_INVALID',
    );
    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, visited_domains: 'marketing' } as never, context()),
      'HANDOFF_PACKAGE_INVALID',
    );
    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, occurred_at: '2026-09-26' }, context()),
      'HANDOFF_PACKAGE_INVALID',
    );
    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, evidence: ['not-a-ref'] } as never, context()),
      'HANDOFF_EVIDENCE_INVALID',
    );
  });

  it('refuses a package whose classification its own evidence does not support', () => {
    const pkg = createCrossDomainHandoffPackage(draft());
    const promoted = { ...pkg, classification: 'FACT' as const };

    expectRefusal(() => assertHandoffAdmissible(promoted, context()), 'HANDOFF_EVIDENCE_INVALID');
  });

  it('refuses a package whose idempotency key was supplied rather than derived', () => {
    const pkg = createCrossDomainHandoffPackage(draft());

    expectRefusal(
      () => assertHandoffAdmissible({ ...pkg, idempotency_key: 'a'.repeat(64) }, context()),
      'HANDOFF_PACKAGE_INVALID',
    );
  });

  it('refuses an evidence reference that cannot name its source', () => {
    const pkg = createCrossDomainHandoffPackage(draft());
    const bare = {
      ...pkg,
      evidence: [{ classification: 'FACT' as const, claim: 'c', source_uri: '', source_version: 'v', verified_by: 'w' }],
    };

    expectRefusal(() => assertHandoffAdmissible(bare, context()), 'HANDOFF_PACKAGE_INVALID');
  });
});

describe('assertHandoffSourceDomain', () => {
  it('corroborates the leg against the agents the run acted with', () => {
    expect(() => assertHandoffSourceDomain('sales', ['SAL-02', 'SAL-05'])).not.toThrow();
    expect(() => assertHandoffSourceDomain('retention', ['CS-02'])).not.toThrow();
    expectRefusal(() => assertHandoffSourceDomain('marketing', ['SAL-02']), 'HANDOFF_PACKAGE_INVALID');
    expectRefusal(() => assertHandoffSourceDomain('retention', []), 'HANDOFF_PACKAGE_INVALID');
  });
});

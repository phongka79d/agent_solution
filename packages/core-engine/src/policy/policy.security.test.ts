/**
 * @file Security invariants of the Policy Enforcement Point's fail-closed stages (implement/08 §1,
 * §2, §4, §7, §8).
 *
 * Where the behavioural suite walks the whole decision surface, these cases pin the properties the
 * boundary must never give up: a tenant that never reached the server binding, a payload with no
 * canonical form, a governed member that is present but not usable, a retry of an effect that
 * cannot be duplicated, an AUTH-4 route whose identity or floor input is unresolved, a takeover
 * lock that must not reach reads, and consent that is absent, unverified or revoked.
 *
 * Each case asserts the exact refusal code the caller acts on — never merely "not permitted" — and
 * that the approval store was not called: a durable approval row is an obligation the platform has
 * to answer, so it may exist only for a prepared action that passed every check before it. As in
 * the behavioural suite every edge is an injected callback, so what is asserted is the decision and
 * the side effects it is allowed to have.
 */

import { describe, expect, it } from 'vitest';

import {
  type AuthoritativeCatalogRecord,
  type AuthoritativeSourcePort,
  type ConsentSource,
  type ConsentState,
  type FloorDecision,
  type PendingApprovalRequest,
  PolicyEnforcementPoint,
  type PolicyActionProposal,
  type PolicyAuditPort,
  type PolicyAuditRecord,
  type PolicyDecision,
  type PolicyDenyCode,
  type PolicyRegistryAgent,
  type PolicyRegistrySkill,
  type PolicySecurityContext,
  type PriceFloorSource,
} from './index.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = 'SAL-02';
const CUSTOMER = 'cust-a';
const EFFECT_KEY = 'a'.repeat(64);
const FROZEN_INSTANT = '2026-01-15T10:00:00.000Z';

const CONTEXT: PolicySecurityContext = {
  tenant_id: TENANT,
  agent_id: AGENT,
  run_id: 'run-1',
  request_id: 'req-1',
  correlation_id: 'corr-1',
  session_id: 'sess-1',
  verified_customer_id: CUSTOMER,
  takeover_active: false,
};

/** A context whose tenant never arrived from the gateway: nothing may be read for an unbound run. */
const UNBOUND_CONTEXT: PolicySecurityContext = {
  tenant_id: '',
  agent_id: CONTEXT.agent_id,
  run_id: CONTEXT.run_id,
  request_id: CONTEXT.request_id,
  correlation_id: CONTEXT.correlation_id,
  session_id: CONTEXT.session_id,
  verified_customer_id: CUSTOMER,
  takeover_active: false,
};

/** An anonymous session: the context carries no server-verified customer at all. */
const ANONYMOUS_CONTEXT: PolicySecurityContext = {
  tenant_id: CONTEXT.tenant_id,
  agent_id: CONTEXT.agent_id,
  run_id: CONTEXT.run_id,
  request_id: CONTEXT.request_id,
  correlation_id: CONTEXT.correlation_id,
  session_id: CONTEXT.session_id,
  takeover_active: false,
};

const CATALOG: AuthoritativeCatalogRecord = {
  catalog_ref_id: 'ERP-SKU-OK',
  price: 1_000,
  currency: 'TWD',
};

const APPROVED_FLOOR: FloorDecision = {
  floor_price: 800,
  floor_source: 'owner-approved-ledger#P_FLOOR-2026-01',
  owner_approved: true,
};

const CONSENTED: ConsentState = { consent_marketing: true, suppression_active: false };

/** Builds a registry row with the admission fields the PEP reads. */
function skill(overrides: Partial<PolicyRegistrySkill> & { skill_id: string }): PolicyRegistrySkill {
  return {
    required_authority: 'AUTH-0',
    allowed_agents: [AGENT],
    mutating: false,
    price_bearing: false,
    idempotent: true,
    epistemic_class: 'FACT',
    write_target: 'HYPOTHESIS',
    requires_consent: false,
    requires_verified_identity: false,
    timeout_ms: 5_000,
    ...overrides,
  };
}

const OBSERVE = skill({ skill_id: 'skill.test.observe_account' });

const RATE_QUOTE = skill({ skill_id: 'skill.sales.quote_rate', price_bearing: true });

const CREDIT = skill({
  skill_id: 'skill.test.issue_credit',
  mutating: true,
  idempotent: false,
});

const NOTE = skill({ skill_id: 'skill.test.write_note', mutating: true });

const OUTREACH = skill({
  skill_id: 'skill.mkt.dispatch_campaign',
  required_authority: 'AUTH-4',
  mutating: true,
  idempotent: false,
  requires_consent: true,
  requires_verified_identity: true,
  timeout_ms: 30_000,
});

const REMINDER = skill({
  skill_id: 'skill.mkt.dispatch_reminder',
  required_authority: 'AUTH-4',
  mutating: true,
  idempotent: false,
  requires_consent: true,
});

const CASE_REVIEW = skill({
  skill_id: 'skill.care.open_case_review',
  required_authority: 'AUTH-4',
  requires_verified_identity: true,
});

const PRICE_APPROVAL = skill({
  skill_id: 'skill.sales.confirm_quote',
  required_authority: 'AUTH-4',
  price_bearing: true,
});

/** Every skill the registry here knows; a case names only the rows it needs. */
const DEFAULT_SKILLS: readonly PolicyRegistrySkill[] = [
  OBSERVE,
  RATE_QUOTE,
  CREDIT,
  NOTE,
  OUTREACH,
  REMINDER,
  CASE_REVIEW,
  PRICE_APPROVAL,
];

/** The only server-registered agent here: one assignable grant covers every requirement below. */
const DEFAULT_AGENTS: readonly PolicyRegistryAgent[] = [{ agent_id: AGENT, assigned_authority: 'AUTH-3' }];

/** A payload for the mutating paths: bound customer and a deterministic effect key. */
const MUTATING_PAYLOAD: Record<string, unknown> = {
  customer_id: CUSTOMER,
  effect_key: EFFECT_KEY,
  message: 'order confirmation',
};

/** A payload with a usable catalog reference and a finite effective price. */
const PRICE_PAYLOAD: Record<string, unknown> = {
  catalog_ref_id: CATALOG.catalog_ref_id,
  offered_price: 950,
};

/** Records what the injected callbacks were asked to do, so a side effect is observable. */
interface Harness {
  readonly pep: PolicyEnforcementPoint;
  /** Approval-store calls, logged before the store answers: an untouched queue is a zero length. */
  readonly approvalCalls: PendingApprovalRequest[];
  /** Registry lookups performed, in order: a binding refusal precedes every one of them. */
  readonly registryReads: string[];
  /** Customer ids the consent registry was asked about. */
  readonly consentLookups: string[];
  readonly auditRecords: PolicyAuditRecord[];
}

interface HarnessOptions {
  readonly priceFloor?: PriceFloorSource;
  readonly consent?: ConsentSource;
}

/** A System-of-Record reader answering with the one authenticated catalog fixture. */
function catalogPort(): AuthoritativeSourcePort {
  return {
    resolveCatalogReference: async ({ catalog_ref_id }) =>
      (catalog_ref_id === CATALOG.catalog_ref_id ? CATALOG : undefined),
  };
}

/** A floor port answering with one decision, or with none when the owner approved nothing. */
function floorPort(decision: FloorDecision | null): PriceFloorSource {
  return {
    getFloorDecision: async () => (decision === null ? undefined : decision),
  };
}

/** A consent port answering with one state, or with no record at all, recording each lookup. */
function consentPort(state: ConsentState | null, lookups: string[]): ConsentSource {
  return {
    getConsent: async ({ customer_id }) => {
      lookups.push(customer_id);

      return state === null ? undefined : state;
    },
  };
}

/**
 * Builds the enforcement point over in-memory callbacks; every edge is injected here.
 *
 * @param options - The fixtures a case wants to replace.
 * @returns The boundary plus the call logs its fakes recorded.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const approvalCalls: PendingApprovalRequest[] = [];
  const registryReads: string[] = [];
  const consentLookups: string[] = [];
  const auditRecords: PolicyAuditRecord[] = [];
  const audit: PolicyAuditPort = {
    append: async (record: PolicyAuditRecord) => {
      auditRecords.push(record);
    },
  };

  const pep = new PolicyEnforcementPoint({
    registry: {
      getSkill: (skill_id) => {
        registryReads.push(`skill:${skill_id}`);

        return DEFAULT_SKILLS.find((row) => row.skill_id === skill_id);
      },
      getAgent: (agent_id) => {
        registryReads.push(`agent:${agent_id}`);

        return DEFAULT_AGENTS.find((row) => row.agent_id === agent_id);
      },
    },
    approvals: {
      createOrReadPending: async (request) => {
        approvalCalls.push(request);

        return { approval_id: `APV-${approvalCalls.length}` };
      },
    },
    authoritativeSource: catalogPort(),
    priceFloor: options.priceFloor ?? floorPort(APPROVED_FLOOR),
    consent: options.consent ?? consentPort(CONSENTED, consentLookups),
    audit,
    auditSecret: 'audit-secret-fixture',
    now: () => new Date(FROZEN_INSTANT),
  });

  return { pep, approvalCalls, registryReads, consentLookups, auditRecords };
}

/**
 * Evaluates one proposal at the boundary under a server-resolved context.
 *
 * @param harness - Enforcement point and the fake callbacks behind it.
 * @param proposal - The action proposed for this evaluation.
 * @param context - Server-resolved context; defaults to the bound, verified session.
 * @returns The verdict the caller acts on.
 */
async function evaluate(
  harness: Harness,
  proposal: PolicyActionProposal,
  context: PolicySecurityContext = CONTEXT,
): Promise<PolicyDecision> {
  return harness.pep.enforce(context, proposal);
}

describe('unbound tenant binding', () => {
  it('refuses a blank server-resolved tenant before any registry read or queue row', async () => {
    const harness = createHarness();
    const proposal: PolicyActionProposal = {
      skill_id: OUTREACH.skill_id,
      tool_name: 'adapter:campaign',
      payload: MUTATING_PAYLOAD,
    };
    const contexts: readonly PolicySecurityContext[] = [
      UNBOUND_CONTEXT,
      { ...UNBOUND_CONTEXT, tenant_id: '   ' },
    ];
    const observed: (PolicyDenyCode | null)[] = [];

    for (const context of contexts) {
      observed.push((await evaluate(harness, proposal, context)).errorCode);
    }

    expect(observed).toEqual(['TENANT_CONTEXT_REQUIRED', 'TENANT_CONTEXT_REQUIRED']);
    expect(harness.registryReads).toHaveLength(0);
    expect(harness.approvalCalls).toHaveLength(0);
  });

  it('refuses a payload-asserted tenant while the bound tenant is blank', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      {
        skill_id: OUTREACH.skill_id,
        tool_name: 'adapter:campaign',
        payload: { ...MUTATING_PAYLOAD, tenant_id: TENANT },
      },
      UNBOUND_CONTEXT,
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.ruleId).toBe('PEP-BINDING');
    expect(decision.errorCode).toBe('TENANT_CONTEXT_REQUIRED');
    expect(decision.authorized).toBe(false);
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.registryReads).toHaveLength(0);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('payloads without a canonical form', () => {
  it('refuses a payload that cannot be canonicalized instead of digesting it', async () => {
    const harness = createHarness();

    const non_finite = await evaluate(harness, {
      skill_id: OBSERVE.skill_id,
      tool_name: 'adapter:observe',
      payload: { amount_due: Number.NaN },
    });
    const unrepresentable = await evaluate(harness, {
      skill_id: OBSERVE.skill_id,
      tool_name: 'adapter:observe',
      payload: { observed_at: new Date(FROZEN_INSTANT) },
    });

    expect(non_finite.verdict).toBe('DENIED');
    expect(non_finite.ruleId).toBe('PEP-BINDING');
    expect(non_finite.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(non_finite.authorized).toBe(false);
    expect(non_finite.payloadSha256).toBeNull();
    expect(unrepresentable.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(unrepresentable.authorized).toBe(false);
    expect(harness.registryReads).toHaveLength(0);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('governed member validation', () => {
  it('refuses a present-but-non-finite retry counter instead of reading it as a first attempt', async () => {
    const harness = createHarness();
    const proposal = (retry_attempt: unknown): PolicyActionProposal => ({
      skill_id: OBSERVE.skill_id,
      tool_name: 'adapter:observe',
      payload: { retry_attempt },
    });

    // A non-finite counter has no canonical form at all, so it is refused before any governed read.
    const non_finite = await evaluate(harness, proposal(Number.NaN));
    // A counter that does canonicalize but is not a finite number is refused by BR-006 itself.
    const text = await evaluate(harness, proposal('1'));
    const nulled = await evaluate(harness, proposal(null));
    const first_attempt = await evaluate(harness, proposal(0));

    expect(non_finite.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(non_finite.authorized).toBe(false);
    expect(non_finite.payloadSha256).toBeNull();
    expect(text.ruleId).toBe('BR-006');
    expect(text.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(text.authorized).toBe(false);
    expect(nulled.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(first_attempt.errorCode).toBeNull();
    expect(first_attempt.authorized).toBe(true);
    expect(harness.approvalCalls).toHaveLength(0);
  });

  it('refuses a present-but-non-finite effective price instead of dropping it from the floor check', async () => {
    const harness = createHarness();

    // A non-finite price has no canonical form at all, so it is refused before any governed read.
    const non_finite = await evaluate(harness, {
      skill_id: RATE_QUOTE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { ...PRICE_PAYLOAD, offered_price: Number.NaN },
    });
    // A price that does canonicalize but is not a finite number is refused by the floor check.
    const text = await evaluate(harness, {
      skill_id: RATE_QUOTE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { ...PRICE_PAYLOAD, offered_price: '950' },
    });
    const finite = await evaluate(harness, {
      skill_id: RATE_QUOTE.skill_id,
      tool_name: 'adapter:pricing',
      payload: PRICE_PAYLOAD,
    });

    expect(non_finite.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(non_finite.authorized).toBe(false);
    expect(non_finite.payloadSha256).toBeNull();
    expect(text.ruleId).toBe('BR-002');
    expect(text.errorCode).toBe('POLICY_INPUT_INVALID');
    expect(text.authorized).toBe(false);
    expect(finite.errorCode).toBeNull();
    expect(finite.authorized).toBe(true);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('duplicate-effect retries', () => {
  it('refuses a retry of a mutating skill that is not registered idempotent', async () => {
    const harness = createHarness();

    const retry = await evaluate(harness, {
      skill_id: CREDIT.skill_id,
      tool_name: 'adapter:credit',
      payload: { ...MUTATING_PAYLOAD, retry_attempt: 1 },
    });
    const first_attempt = await evaluate(harness, {
      skill_id: CREDIT.skill_id,
      tool_name: 'adapter:credit',
      payload: MUTATING_PAYLOAD,
    });
    const idempotent_retry = await evaluate(harness, {
      skill_id: NOTE.skill_id,
      tool_name: 'adapter:note',
      payload: { ...MUTATING_PAYLOAD, retry_attempt: 1 },
    });

    expect(retry.verdict).toBe('DENIED');
    expect(retry.ruleId).toBe('BR-006');
    expect(retry.errorCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(retry.authorized).toBe(false);
    expect(retry.reason).toMatch(/IDEMPOTENCY_CONFLICT/);
    expect(first_attempt.authorized).toBe(true);
    expect(idempotent_retry.authorized).toBe(true);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('AUTH-4 route preconditions', () => {
  it('refuses an identity-bound AUTH-4 skill on an anonymous session without queueing it', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      { skill_id: CASE_REVIEW.skill_id, tool_name: 'adapter:case-review', payload: {} },
      ANONYMOUS_CONTEXT,
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.ruleId).toBe('PEP-BINDING');
    expect(decision.errorCode).toBe('IDENTITY_UNVERIFIED');
    expect(decision.authorized).toBe(false);
    expect(decision.resolvedRequirement).toBe('AUTH-4');
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.approvalCalls).toHaveLength(0);
  });

  it('refuses a price-bearing AUTH-4 skill without an approved floor and queues nothing', async () => {
    const proposal: PolicyActionProposal = {
      skill_id: PRICE_APPROVAL.skill_id,
      tool_name: 'adapter:quote',
      payload: PRICE_PAYLOAD,
    };
    const unapproved = createHarness({ priceFloor: floorPort(null) });

    const decision = await evaluate(unapproved, proposal);

    expect(decision.verdict).toBe('DENIED');
    expect(decision.ruleId).toBe('BR-001');
    expect(decision.errorCode).toBe('P_FLOOR_UNAVAILABLE');
    expect(decision.authorized).toBe(false);
    expect(decision.resolvedRequirement).toBe('AUTH-4');
    expect(decision.approvalTicketId).toBeNull();
    expect(unapproved.approvalCalls).toHaveLength(0);

    const approved = createHarness();
    const routed = await evaluate(approved, proposal);

    expect(routed.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(routed.decisionCode).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(routed.approvalTicketId).not.toBeNull();
    expect(approved.approvalCalls).toHaveLength(1);
  });
});

describe('takeover scope', () => {
  it('permits a read-only skill while the SCR-005 session lock is held', async () => {
    const harness = createHarness();
    const held: PolicySecurityContext = { ...CONTEXT, takeover_active: true };

    const read = await evaluate(
      harness,
      { skill_id: OBSERVE.skill_id, tool_name: 'adapter:observe', payload: {} },
      held,
    );
    const mutation = await evaluate(
      harness,
      { skill_id: CREDIT.skill_id, tool_name: 'adapter:credit', payload: MUTATING_PAYLOAD },
      held,
    );

    expect(read.verdict).toBe('AUTO_APPROVED');
    expect(read.decisionCode).toBe('PERMIT');
    expect(read.errorCode).toBeNull();
    expect(read.authorized).toBe(true);
    expect(mutation.ruleId).toBe('PEP-TAKEOVER');
    expect(mutation.errorCode).toBe('HUMAN_TAKEOVER');
    expect(mutation.authorized).toBe(false);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('consent and verified identity', () => {
  it('suppresses outreach whose consent was revoked by an active suppression flag', async () => {
    const harness = createHarness({
      consent: consentPort({ consent_marketing: true, suppression_active: true }, []),
    });

    const decision = await evaluate(harness, {
      skill_id: OUTREACH.skill_id,
      tool_name: 'adapter:campaign',
      payload: MUTATING_PAYLOAD,
    });

    expect(decision.verdict).toBe('DENIED');
    expect(decision.ruleId).toBe('BR-004');
    expect(decision.errorCode).toBe('CONSENT_REQUIRED');
    expect(decision.authorized).toBe(false);
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.approvalCalls).toHaveLength(0);
  });

  it('refuses a consent-bearing skill on an anonymous session without querying consent', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      {
        skill_id: REMINDER.skill_id,
        tool_name: 'adapter:reminder',
        payload: { effect_key: EFFECT_KEY },
      },
      ANONYMOUS_CONTEXT,
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.ruleId).toBe('BR-004');
    expect(decision.errorCode).toBe('IDENTITY_UNVERIFIED');
    expect(decision.authorized).toBe(false);
    expect(decision.resolvedRequirement).toBe('AUTH-4');
    expect(harness.consentLookups).toHaveLength(0);
    expect(harness.approvalCalls).toHaveLength(0);
  });
});

describe('fail-closed invariant', () => {
  it('leaves the approval queue untouched for every refusal and reports no authorization', async () => {
    const harness = createHarness({
      consent: consentPort({ consent_marketing: true, suppression_active: true }, []),
    });
    // The unapproved floor is its own deployment: a missing floor is not a property of the others.
    const unapproved_floor = createHarness({
      priceFloor: floorPort(null),
      consent: consentPort({ consent_marketing: true, suppression_active: true }, []),
    });

    // One refusal per guard the cases above pin, in the same order.
    const decisions: readonly PolicyDecision[] = [
      await evaluate(
        harness,
        {
          skill_id: OUTREACH.skill_id,
          tool_name: 'adapter:campaign',
          payload: { ...MUTATING_PAYLOAD, tenant_id: TENANT },
        },
        UNBOUND_CONTEXT,
      ),
      await evaluate(harness, {
        skill_id: OBSERVE.skill_id,
        tool_name: 'adapter:observe',
        payload: { amount_due: Number.NaN },
      }),
      await evaluate(harness, {
        skill_id: OBSERVE.skill_id,
        tool_name: 'adapter:observe',
        payload: { retry_attempt: '1' },
      }),
      await evaluate(harness, {
        skill_id: RATE_QUOTE.skill_id,
        tool_name: 'adapter:pricing',
        payload: { ...PRICE_PAYLOAD, offered_price: '950' },
      }),
      await evaluate(harness, {
        skill_id: CREDIT.skill_id,
        tool_name: 'adapter:credit',
        payload: { ...MUTATING_PAYLOAD, retry_attempt: 1 },
      }),
      await evaluate(
        harness,
        { skill_id: CASE_REVIEW.skill_id, tool_name: 'adapter:case-review', payload: {} },
        ANONYMOUS_CONTEXT,
      ),
      await evaluate(unapproved_floor, {
        skill_id: PRICE_APPROVAL.skill_id,
        tool_name: 'adapter:quote',
        payload: PRICE_PAYLOAD,
      }),
      await evaluate(harness, {
        skill_id: OUTREACH.skill_id,
        tool_name: 'adapter:campaign',
        payload: MUTATING_PAYLOAD,
      }),
      await evaluate(
        harness,
        {
          skill_id: REMINDER.skill_id,
          tool_name: 'adapter:reminder',
          payload: { effect_key: EFFECT_KEY },
        },
        ANONYMOUS_CONTEXT,
      ),
    ];

    expect(decisions.map((decision) => decision.errorCode)).toEqual([
      'TENANT_CONTEXT_REQUIRED',
      'POLICY_INPUT_INVALID',
      'POLICY_INPUT_INVALID',
      'POLICY_INPUT_INVALID',
      'IDEMPOTENCY_CONFLICT',
      'IDENTITY_UNVERIFIED',
      'P_FLOOR_UNAVAILABLE',
      'CONSENT_REQUIRED',
      'IDENTITY_UNVERIFIED',
    ]);
    expect(decisions.every((decision) => decision.verdict === 'DENIED')).toBe(true);
    expect(decisions.every((decision) => decision.authorized === false)).toBe(true);
    expect(decisions.every((decision) => decision.approvalTicketId === null)).toBe(true);
    expect(harness.approvalCalls).toHaveLength(0);
    expect(unapproved_floor.approvalCalls).toHaveLength(0);
    expect(
      [...harness.auditRecords, ...unapproved_floor.auditRecords]
        .every((record) => record.verdict === 'DENIED'),
    ).toBe(true);
  });
});

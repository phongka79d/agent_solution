/**
 * @file Behavioural contract of the Policy Enforcement Point (implement/08 §1, §7.1, §8).
 *
 * Every case drives the public boundary: a `PolicyEnforcementPoint` built from injected callbacks
 * only — no database, no Redis, no adapter — so what is asserted is the decision itself and the
 * side effects it is allowed to have. The two things that must never happen are the point of the
 * suite: an action that is *not* authorized must leave the approval queue untouched, and no state a
 * refusal could be laundered through (a queue row, a declared downgrade, a payload-asserted
 * identity) may exist.
 */

import { describe, expect, it } from 'vitest';

import {
  type AuthoritativeCatalogRecord,
  type AuthoritativeSourcePort,
  type ConsentSource,
  type ConsentState,
  type FloorDecision,
  type InjectionDetector,
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
  type TenantPolicyParameters,
} from './index.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = 'SAL-02';
const MARKETER = 'MKT-05';
const CARER = 'CS-01';
const CUSTOMER = 'cust-a';
const OTHER_CUSTOMER = 'cust-b';
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

/** Owner-approved autonomy limits; every value is synthetic test configuration (§08 §1.2). */
const APPROVED_LIMITS: TenantPolicyParameters = {
  maxAutonomousDiscountRate: 0.15,
  maxAutonomousRefundAmount: 500,
  maxAutonomousAudienceSize: 5_000,
  maxAutonomousReminderCount: 2,
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

/** Builds an agent row; `assigned_authority` stays a plain string so a corrupt row is testable. */
function agent(agent_id: string, assigned_authority: string): PolicyRegistryAgent {
  return { agent_id, assigned_authority };
}

const SEND_MESSAGE = skill({
  skill_id: 'skill.sales.send_message',
  required_authority: 'AUTH-3',
  mutating: true,
  idempotent: false,
  requires_verified_identity: true,
});

const CHECK_PRICE = skill({
  skill_id: 'skill.sales.check_price',
  required_authority: 'AUTH-0',
  price_bearing: true,
});

const CAMPAIGN = skill({
  skill_id: 'skill.mkt.dispatch_campaign',
  required_authority: 'AUTH-4',
  allowed_agents: [MARKETER],
  mutating: true,
  idempotent: false,
  requires_consent: true,
  requires_verified_identity: true,
  timeout_ms: 30_000,
});

const RAW_EXPORT = skill({
  skill_id: 'skill.governance.raw_dataset_export',
  required_authority: 'AUTH-5',
  allowed_agents: [MARKETER],
});

const REFUND = skill({
  skill_id: 'skill.care.issue_refund',
  required_authority: 'AUTH-4',
  allowed_agents: [CARER],
  mutating: true,
  idempotent: false,
});

const MIRROR_WRITE = skill({
  skill_id: 'skill.customer360.refresh_segment',
  required_authority: 'AUTH-2',
  mutating: true,
  idempotent: false,
  epistemic_class: 'HYPOTHESIS',
  write_target: 'FACT',
});

/** Every skill the default registry knows; a case names only the rows it needs. */
const DEFAULT_SKILLS: readonly PolicyRegistrySkill[] = [
  SEND_MESSAGE,
  CHECK_PRICE,
  CAMPAIGN,
  RAW_EXPORT,
  REFUND,
  MIRROR_WRITE,
];

const DEFAULT_AGENTS: readonly PolicyRegistryAgent[] = [
  agent(AGENT, 'AUTH-3'),
  agent(MARKETER, 'AUTH-3'),
  agent(CARER, 'AUTH-3'),
];

/** A payload for the mutating send path: bound customer and a deterministic effect key. */
const SEND_PAYLOAD: Record<string, unknown> = {
  customer_id: CUSTOMER,
  effect_key: EFFECT_KEY,
  message: 'Đơn hàng của bạn đã được gửi',
};

/** Records what the injected callbacks were asked to do, so "forbidden dispatch" is observable. */
interface Harness {
  readonly pep: PolicyEnforcementPoint;
  readonly queueRequests: PendingApprovalRequest[];
  readonly auditRecords: PolicyAuditRecord[];
}

interface HarnessOptions {
  readonly skills?: readonly PolicyRegistrySkill[];
  readonly agents?: readonly PolicyRegistryAgent[];
  readonly tenantPolicy?: TenantPolicyParameters;
  readonly authoritativeSource?: AuthoritativeSourcePort;
  readonly priceFloor?: PriceFloorSource;
  readonly consent?: ConsentSource;
  readonly injectionDetector?: InjectionDetector;
  /** `null` models an absent audit sink: no durable decision intent is possible. */
  readonly audit?: PolicyAuditPort | null;
  readonly auditSecret?: string;
  readonly approvals?: (request: PendingApprovalRequest) => Promise<{ approval_id: string }>;
}

/** A recording System-of-Record reader; `record === null` means the reference does not resolve. */
function catalogPort(
  record: AuthoritativeCatalogRecord | null,
  lookups: string[] = [],
): AuthoritativeSourcePort {
  return {
    resolveCatalogReference: async ({ catalog_ref_id }) => {
      lookups.push(catalog_ref_id);

      return record === null ? undefined : record;
    },
  };
}

/** A floor port answering with one decision, or with none when the owner approved nothing. */
function floorPort(decision: FloorDecision | null): PriceFloorSource {
  return {
    getFloorDecision: async () => (decision === null ? undefined : decision),
  };
}

/** A consent port answering with one state, or with no record at all. */
function consentPort(state: ConsentState | null): ConsentSource {
  return {
    getConsent: async () => (state === null ? undefined : state),
  };
}

/** Builds the enforcement point over in-memory callbacks; every edge is injected here. */
function createHarness(options: HarnessOptions = {}): Harness {
  const queueRequests: PendingApprovalRequest[] = [];
  const auditRecords: PolicyAuditRecord[] = [];
  const skills = options.skills ?? DEFAULT_SKILLS;
  const agents = options.agents ?? DEFAULT_AGENTS;
  const approvals = options.approvals ?? (async () => ({ approval_id: `APV-${queueRequests.length}` }));
  const audit = options.audit === undefined
    ? {
      append: async (record: PolicyAuditRecord) => {
        auditRecords.push(record);
      },
    }
    : options.audit;

  const pep = new PolicyEnforcementPoint({
    registry: {
      getSkill: (skill_id) => skills.find((row) => row.skill_id === skill_id),
      getAgent: (agent_id) => agents.find((row) => row.agent_id === agent_id),
    },
    approvals: {
      createOrReadPending: async (request) => {
        const pending = await approvals(request);
        queueRequests.push(request);

        return pending;
      },
    },
    tenantPolicy: { get: () => options.tenantPolicy ?? APPROVED_LIMITS },
    authoritativeSource: options.authoritativeSource ?? catalogPort(CATALOG),
    priceFloor: options.priceFloor ?? floorPort(APPROVED_FLOOR),
    consent: options.consent ?? consentPort(CONSENTED),
    now: () => new Date(FROZEN_INSTANT),
    ...(options.injectionDetector === undefined
      ? {}
      : { injectionDetector: options.injectionDetector }),
    ...(audit === null ? {} : { audit }),
    auditSecret: options.auditSecret ?? 'audit-secret-fixture',
  });

  return { pep, queueRequests, auditRecords };
}

/** Evaluates one proposal against the bound context a case does not need to restate. */
async function evaluate(
  harness: Harness,
  proposal: PolicyActionProposal,
  context: Partial<PolicySecurityContext> = {},
): Promise<PolicyDecision> {
  return harness.pep.enforce({ ...CONTEXT, ...context }, proposal);
}

describe('authority verdicts (AUTH-0..AUTH-3)', () => {
  const ranks: readonly string[] = ['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3'];

  it('permits exactly the runs whose grant rank reaches the requirement', async () => {
    const agents = ranks.map((authority, index) => agent(`AGT-${index}`, authority));
    const allowed_agents = agents.map((row) => row.agent_id);
    const listener = skill({
      skill_id: 'skill.test.observe',
      required_authority: 'AUTH-0',
      allowed_agents,
    });
    const bounded = skill({
      skill_id: 'skill.test.bounded',
      required_authority: 'AUTH-3',
      allowed_agents,
    });
    const harness = createHarness({ skills: [listener, bounded], agents });
    const observed: string[] = [];

    for (const [index, authority] of ranks.entries()) {
      const context = { agent_id: `AGT-${index}` };
      const read = await evaluate(
        harness,
        { skill_id: listener.skill_id, tool_name: 'adapter:observe', payload: {} },
        context,
      );
      const execute = await evaluate(
        harness,
        { skill_id: bounded.skill_id, tool_name: 'adapter:bounded', payload: {} },
        context,
      );

      expect(read.verdict).toBe('AUTO_APPROVED');
      expect(read.authorized).toBe(true);
      expect(execute.errorCode).toBe(authority === 'AUTH-3' ? null : 'INSUFFICIENT_AUTHORITY');
      observed.push(`${authority}:${execute.decisionCode}`);
    }

    expect(observed).toEqual([
      'AUTH-0:DENY_PROHIBITED',
      'AUTH-1:DENY_PROHIBITED',
      'AUTH-2:DENY_PROHIBITED',
      'AUTH-3:PERMIT',
    ]);
  });

  it('reports the resolved requirement and never queues a rank shortfall', async () => {
    const harness = createHarness({
      skills: [
        skill({
          skill_id: 'skill.test.bounded',
          required_authority: 'AUTH-3',
          allowed_agents: ['AGT-0'],
        }),
      ],
      agents: [agent('AGT-0', 'AUTH-1')],
    });

    const decision = await evaluate(
      harness,
      { skill_id: 'skill.test.bounded', tool_name: 'adapter:bounded', payload: {} },
      { agent_id: 'AGT-0' },
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.grantedAuthority).toBe('AUTH-1');
    expect(decision.resolvedRequirement).toBe('AUTH-3');
    expect(decision.requirementSource).toBe('REGISTRY');
    expect(decision.reason).toMatch(/INSUFFICIENT_AUTHORITY/);
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses a missing or non-assignable grant instead of reading it as rank zero', async () => {
    const bounded = skill({
      skill_id: 'skill.test.bounded',
      required_authority: 'AUTH-0',
      allowed_agents: ['AGT-MISSING', 'AGT-CORRUPT'],
    });
    const harness = createHarness({
      skills: [bounded],
      agents: [agent('AGT-MISSING', ''), agent('AGT-CORRUPT', 'AUTH-5')],
    });

    const missing = await evaluate(
      harness,
      { skill_id: bounded.skill_id, tool_name: 'adapter:bounded', payload: {} },
      { agent_id: 'AGT-MISSING' },
    );
    const corrupt = await evaluate(
      harness,
      { skill_id: bounded.skill_id, tool_name: 'adapter:bounded', payload: {} },
      { agent_id: 'AGT-CORRUPT' },
    );

    expect(missing.errorCode).toBe('CLEARANCE_REQUIRED');
    expect(corrupt.errorCode).toBe('INVALID_CLEARANCE');
    expect([missing.authorized, corrupt.authorized]).toEqual([false, false]);
    expect(harness.queueRequests).toHaveLength(0);
  });
});

describe('AUTH-4 approval route', () => {
  it('routes a prepared action to one pending approval row and keeps it unauthorized', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY, audience_size: 1_200 },
      },
      { agent_id: MARKETER },
    );

    expect(decision.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(decision.decisionCode).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(decision.authorized).toBe(false);
    expect(decision.resolvedRequirement).toBe('AUTH-4');
    expect(decision.grantedAuthority).toBe('AUTH-3');
    expect(decision.approvalTicketId).toBe('APV-0');
    expect(harness.queueRequests).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        run_id: CONTEXT.run_id,
        skill_id: CAMPAIGN.skill_id,
        agent_id: MARKETER,
        effect_key: EFFECT_KEY,
        required_authority: 'AUTH-4',
        created_at: FROZEN_INSTANT,
      }),
    ]);
  });

  it('queues nothing when an independent check refuses the prepared action', async () => {
    const harness = createHarness({ consent: consentPort(null) });

    const decision = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY, audience_size: 1_200 },
      },
      { agent_id: MARKETER },
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.errorCode).toBe('CONSENT_REQUIRED');
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses the route when the approval store cannot persist the row', async () => {
    const harness = createHarness({
      approvals: async () => {
        throw new Error('approvals table unavailable');
      },
    });

    const decision = await evaluate(
      harness,
      { skill_id: REFUND.skill_id, tool_name: 'adapter:refund', payload: { effect_key: EFFECT_KEY } },
      { agent_id: CARER },
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.errorCode).toBe('APPROVAL_QUEUE_UNAVAILABLE');
    expect(decision.approvalTicketId).toBeNull();
  });

  it('never accepts a blank approval id as a queue row', async () => {
    const harness = createHarness({ approvals: async () => ({ approval_id: '   ' }) });

    const decision = await evaluate(
      harness,
      { skill_id: REFUND.skill_id, tool_name: 'adapter:refund', payload: { effect_key: EFFECT_KEY } },
      { agent_id: CARER },
    );

    expect(decision.errorCode).toBe('APPROVAL_QUEUE_UNAVAILABLE');
    expect(decision.authorized).toBe(false);
  });
});

describe('AUTH-5 terminal deny', () => {
  it('denies a prohibited skill before any queue row exists, even for the top autonomous grant', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      {
        skill_id: RAW_EXPORT.skill_id,
        tool_name: 'adapter:raw-export',
        payload: { tenant_id: TENANT, tables: ['customers'] },
      },
      { agent_id: MARKETER },
    );

    expect(decision.verdict).toBe('DENIED');
    expect(decision.decisionCode).toBe('DENY_PROHIBITED');
    expect(decision.errorCode).toBe('PROHIBITED_ACTION');
    expect(decision.authorized).toBe(false);
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('honours a self-declared AUTH-5 as a deny instead of dropping it', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { catalog_ref_id: CATALOG.catalog_ref_id, offered_price: 1_000 },
      required_authority: 'AUTH-5',
    });

    expect(decision.errorCode).toBe('PROHIBITED_ACTION');
    expect(decision.requirementSource).toBe('PROPOSAL');
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('evaluates the deny and the route before the rank comparison', async () => {
    const harness = createHarness();

    const prohibited = await evaluate(
      harness,
      { skill_id: RAW_EXPORT.skill_id, tool_name: 'adapter:raw-export', payload: {} },
      { agent_id: MARKETER },
    );
    const routed = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY },
      },
      { agent_id: MARKETER },
    );

    expect([prohibited.verdict, prohibited.errorCode]).toEqual(['DENIED', 'PROHIBITED_ACTION']);
    expect([routed.verdict, routed.authorized]).toEqual(['AWAITING_HUMAN_APPROVAL', false]);
  });
});

describe('registry admission', () => {
  it('fails closed on an unregistered skill, an unregistered agent and an unlisted agent', async () => {
    const harness = createHarness();

    const unknown_skill = await evaluate(harness, {
      skill_id: 'skill.sales.experimental_bundle',
      tool_name: 'adapter:experimental',
      payload: {},
    });
    const unknown_agent = await evaluate(
      harness,
      { skill_id: CHECK_PRICE.skill_id, tool_name: 'adapter:pricing', payload: {} },
      { agent_id: 'SAL-99' },
    );
    const unlisted = await evaluate(
      harness,
      { skill_id: CAMPAIGN.skill_id, tool_name: 'adapter:campaign', payload: {} },
      { agent_id: AGENT },
    );

    expect(unknown_skill.errorCode).toBe('UNKNOWN_SKILL');
    expect(unknown_skill.requirementSource).toBeNull();
    expect(unknown_agent.errorCode).toBe('UNKNOWN_AGENT');
    expect(unlisted.errorCode).toBe('UNAUTHORIZED_AGENT');
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses a corrupt registry requirement rather than treating it as unregulated', async () => {
    const harness = createHarness({
      skills: [skill({ skill_id: 'skill.test.broken', required_authority: 'AUTH-9' })],
    });

    const decision = await evaluate(harness, {
      skill_id: 'skill.test.broken',
      tool_name: 'adapter:broken',
      payload: {},
    });

    expect(decision.errorCode).toBe('INVALID_AUTHORITY_REQUIREMENT');
    expect(decision.authorized).toBe(false);
  });

  it('lets the registry requirement win over a declared downgrade', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY },
        required_authority: 'AUTH-0',
      },
      { agent_id: MARKETER },
    );

    expect(decision.resolvedRequirement).toBe('AUTH-4');
    expect(decision.requirementSource).toBe('REGISTRY');
    expect(decision.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(decision.authorized).toBe(false);
  });
});

describe('server-bound identity', () => {
  it('refuses a payload tenant that is not the bound tenant', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { ...SEND_PAYLOAD, tenant_id: OTHER_TENANT },
    });

    expect(decision.errorCode).toBe('CROSS_TENANT_ASSERTION');
    expect(decision.authorized).toBe(false);
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses a payload customer the session is not server-verified as', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { ...SEND_PAYLOAD, customer_id: OTHER_CUSTOMER },
    });

    expect(decision.errorCode).toBe('CROSS_CUSTOMER_ASSERTION');
    expect(decision.authorized).toBe(false);
  });

  it('requires a server-verified subject where the registry row needs one', async () => {
    const harness = createHarness();

    const decision = await harness.pep.enforce(ANONYMOUS_CONTEXT, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { effect_key: EFFECT_KEY },
    });

    expect(decision.errorCode).toBe('IDENTITY_UNVERIFIED');
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses a direct agent-to-agent target', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { ...SEND_PAYLOAD, target_agent_id: CARER },
    });

    expect(decision.errorCode).toBe('AGENT_TO_AGENT_FORBIDDEN');
    expect(decision.ruleId).toBe('PEP-TOPOLOGY');
    expect(decision.authorized).toBe(false);
  });
});

describe('business rules', () => {
  it('refuses a derived HYPOTHESIS aimed at a FACT mirror', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: MIRROR_WRITE.skill_id,
      tool_name: 'adapter:mirror',
      payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY, rfm_segment: 'champion' },
    });

    expect(decision.errorCode).toBe('HYPOTHESIS_PROMOTION_REJECTED');
    expect(decision.authorized).toBe(false);
  });

  it('refuses a price that is not traceable to the catalog, and an unresolvable reference', async () => {
    const harness = createHarness();

    const untraceable = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { offered_price: 900 },
    });
    const unresolvable = await evaluate(
      createHarness({ authoritativeSource: catalogPort(null) }),
      {
        skill_id: CHECK_PRICE.skill_id,
        tool_name: 'adapter:pricing',
        payload: { catalog_ref_id: 'ERP-SKU-GHOST', offered_price: 900 },
      },
    );

    expect(untraceable.errorCode).toBe('ERR_ARBITRARY_PRICING');
    expect(unresolvable.errorCode).toBe('ERR_ARBITRARY_PRICING');
  });

  it('fails closed when the System of Record is unreachable', async () => {
    const harness = createHarness({
      authoritativeSource: {
        resolveCatalogReference: async () => {
          throw new Error('ERP timeout');
        },
      },
    });

    const decision = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { catalog_ref_id: CATALOG.catalog_ref_id, offered_price: 950 },
    });

    expect(decision.errorCode).toBe('AUTHORITATIVE_SOURCE_UNAVAILABLE');
    expect(decision.authorized).toBe(false);
  });

  it('refuses a price-bearing action without an owner-approved floor decision', async () => {
    const harness = createHarness({ priceFloor: floorPort(null) });

    const decision = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { catalog_ref_id: CATALOG.catalog_ref_id, offered_price: 950 },
    });

    expect(decision.errorCode).toBe('P_FLOOR_UNAVAILABLE');
    expect(decision.authorized).toBe(false);
  });

  it('releases a price at the floor and refuses one below it', async () => {
    const harness = createHarness();
    const at_floor = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { catalog_ref_id: CATALOG.catalog_ref_id, offered_price: APPROVED_FLOOR.floor_price },
    });
    const below_floor = await evaluate(harness, {
      skill_id: CHECK_PRICE.skill_id,
      tool_name: 'adapter:pricing',
      payload: { catalog_ref_id: CATALOG.catalog_ref_id, offered_price: 700 },
    });

    expect([at_floor.verdict, at_floor.authorized]).toEqual(['AUTO_APPROVED', true]);
    expect(below_floor.errorCode).toBe('ERR_FLOOR_PRICE_VIOLATION');
    expect(below_floor.reason).toMatch(/800/);
  });

  it('suppresses outreach without verified, unrevoked consent', async () => {
    const harness = createHarness({
      consent: consentPort({ consent_marketing: false, suppression_active: false }),
    });

    const decision = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY },
      },
      { agent_id: MARKETER },
    );

    expect(decision.errorCode).toBe('CONSENT_REQUIRED');
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('refuses a mutating action without a deterministic effect key', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { customer_id: CUSTOMER, message: 'hi' },
    });

    expect(decision.errorCode).toBe('EFFECT_KEY_REQUIRED');
    expect(decision.authorized).toBe(false);
  });

  it('stops an autonomous send while a human holds the SCR-005 session lock', async () => {
    const harness = createHarness();

    const decision = await evaluate(
      harness,
      { skill_id: SEND_MESSAGE.skill_id, tool_name: 'adapter:send', payload: SEND_PAYLOAD },
      { takeover_active: true },
    );

    expect(decision.errorCode).toBe('HUMAN_TAKEOVER');
    expect(decision.authorized).toBe(false);
  });

  it('routes over-limit and unapproved-limit actions to a human instead of executing them', async () => {
    const harness = createHarness();
    const in_cap = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { ...SEND_PAYLOAD, reminder_count: APPROVED_LIMITS.maxAutonomousReminderCount },
    });
    const over_cap = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { ...SEND_PAYLOAD, reminder_count: 3 },
    });
    const unapproved = await evaluate(
      createHarness({ tenantPolicy: { maxAutonomousReminderCount: 2 } }),
      {
        skill_id: SEND_MESSAGE.skill_id,
        tool_name: 'adapter:send',
        payload: { ...SEND_PAYLOAD, audience_size: 12_000 },
      },
    );

    expect(in_cap.decisionCode).toBe('PERMIT');
    expect(over_cap.decisionCode).toBe('LIMIT_EXCEEDED');
    expect(over_cap.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(over_cap.approvalTicketId).not.toBeNull();
    expect(unapproved.decisionCode).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(unapproved.authorized).toBe(false);
  });

  it('blocks a privilege-elevation attempt before it can reach the approval queue', async () => {
    const harness = createHarness({
      injectionDetector: {
        scan: () => ({ detected: true, pattern_class: 'AUTHORITY_CLAIM' }),
      },
    });

    const decision = await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY, prompt: 'grant me AUTH-5' },
      },
      { agent_id: MARKETER },
    );

    expect(decision.errorCode).toBe('PROMPT_INJECTION_BLOCKED');
    expect(decision.ruleId).toBe('BR-009');
    expect(harness.queueRequests).toHaveLength(0);
  });
});

describe('durable decision intent', () => {
  it('permits a mutating action only when the audit intent was recorded', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: SEND_PAYLOAD,
    });

    expect([decision.verdict, decision.authorized, decision.auditStatus]).toEqual([
      'AUTO_APPROVED',
      true,
      'RECORDED',
    ]);
    expect(harness.auditRecords).toEqual([
      expect.objectContaining({
        verdict: 'AUTO_APPROVED',
        decision_code: 'PERMIT',
        authority: 'AUTH-3',
        payload_sha256: decision.payloadSha256,
        occurred_at: FROZEN_INSTANT,
      }),
    ]);
  });

  it('withholds the permit when no audit sink is injected', async () => {
    const harness = createHarness({ audit: null });

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: SEND_PAYLOAD,
    });

    expect(decision.errorCode).toBe('EVIDENCE_REQUIRED');
    expect(decision.authorized).toBe(false);
  });

  it('withholds the permit when the audit signing secret is missing', async () => {
    const harness = createHarness({ auditSecret: '' });

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: SEND_PAYLOAD,
    });

    expect(decision.errorCode).toBe('AUDIT_SECRET_MISSING');
    expect(decision.authorized).toBe(false);
  });

  it('withdraws the permit when the audit intent cannot be persisted', async () => {
    const harness = createHarness({
      audit: {
        append: async (record: PolicyAuditRecord) => {
          throw new Error(`audit sink down for ${record.skill_id}`);
        },
      },
    });

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: SEND_PAYLOAD,
    });

    expect(decision.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(decision.authorized).toBe(false);
    expect(decision.approvalTicketId).toBeNull();
    expect(harness.queueRequests).toHaveLength(0);
  });

  it('audits a refused action too, with the denial it produced', async () => {
    const harness = createHarness();

    const decision = await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { customer_id: CUSTOMER, message: 'hi' },
    });

    expect(decision.errorCode).toBe('EFFECT_KEY_REQUIRED');
    expect(harness.auditRecords).toEqual([
      expect.objectContaining({
        verdict: 'DENIED',
        rule_id: 'BR-005',
        error_code: 'EFFECT_KEY_REQUIRED',
        approval_id: null,
      }),
    ]);
  });
});

describe('determinism', () => {
  it('returns the same decision for the same bound inputs, whatever the member order', async () => {
    const harness = createHarness();
    const proposal: PolicyActionProposal = {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: SEND_PAYLOAD,
    };

    const first = await evaluate(harness, proposal);
    const second = await evaluate(harness, {
      ...proposal,
      payload: { message: SEND_PAYLOAD['message'], effect_key: EFFECT_KEY, customer_id: CUSTOMER },
    });

    expect(first.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
  });
});

describe('no-dispatch guarantee', () => {
  it('leaves the approval queue untouched for every refused action', async () => {
    const harness = createHarness({ consent: consentPort(null) });
    const expected: readonly PolicyDenyCode[] = [
      'UNKNOWN_SKILL',
      'PROHIBITED_ACTION',
      'CONSENT_REQUIRED',
      'EFFECT_KEY_REQUIRED',
      'HUMAN_TAKEOVER',
    ];
    const observed: (PolicyDenyCode | null)[] = [];

    observed.push((await evaluate(harness, {
      skill_id: 'skill.sales.experimental_bundle',
      tool_name: 'adapter:experimental',
      payload: {},
    })).errorCode);
    observed.push((await evaluate(
      harness,
      { skill_id: RAW_EXPORT.skill_id, tool_name: 'adapter:raw-export', payload: {} },
      { agent_id: MARKETER },
    )).errorCode);
    observed.push((await evaluate(
      harness,
      {
        skill_id: CAMPAIGN.skill_id,
        tool_name: 'adapter:campaign',
        payload: { customer_id: CUSTOMER, effect_key: EFFECT_KEY },
      },
      { agent_id: MARKETER },
    )).errorCode);
    observed.push((await evaluate(harness, {
      skill_id: SEND_MESSAGE.skill_id,
      tool_name: 'adapter:send',
      payload: { customer_id: CUSTOMER },
    })).errorCode);
    observed.push((await evaluate(
      harness,
      { skill_id: SEND_MESSAGE.skill_id, tool_name: 'adapter:send', payload: SEND_PAYLOAD },
      { takeover_active: true },
    )).errorCode);

    expect(observed).toEqual(expected);
    expect(harness.queueRequests).toHaveLength(0);
    expect(harness.auditRecords.every((record) => record.verdict === 'DENIED')).toBe(true);
  });
});

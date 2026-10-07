/**
 * @file Policy Enforcement Point (implement/08 §1.2 and §7.1, implement/04 §3.2.1).
 *
 * The PEP is the single admission boundary in front of every tool execution. It is a pure,
 * injected evaluator: it holds no database handle, no Redis client, no adapter and no dispatch
 * port, so *dispatch is unreachable from this module* — it can only return a verdict. Everything it
 * needs from the outside arrives as an injected callback, which is also what makes the boundary
 * runnable without a database runtime in tests.
 *
 * Verdict order is the safety property (§7.1), and no later stage may soften an earlier refusal:
 *
 *   1. bind the server-resolved tenant/session/agent context; a payload-asserted tenant or customer
 *      identity is refused, never merged into the binding;
 *   2. admit through the server registry — unknown agent, unknown skill and an agent outside
 *      `allowed_agents` fail closed before any route or rank exists;
 *   3. validate the assigned grant (`AUTH-0..3` only) and resolve the requirement, where a
 *      proposal may only ever *raise* it (BR-008);
 *   4. `required_authority = AUTH-5` is a terminal deny: it is refused here, before any queue row or
 *      reservation can exist (BR-008);
 *   5. scan untrusted content for a privilege-elevation attempt (BR-009);
 *   6. `required_authority = AUTH-4` is an approval route computed without a rank comparison, and
 *      `AUTH-0..3` is the numeric rank comparison — the only comparison in the platform;
 *   7. the applicable trusted-input checks (identity, consent, floor provenance, price, autonomy
 *      limits, takeover, effect key, epistemic target) run before any approval row is created, so an
 *      unresolved input is refused rather than queued;
 *   8. only then: create the one pending approval row, or return the permit — each preceded by the
 *      durable audit intent (BR-010), because an unrecorded permit is not a permit.
 *
 * What the PEP deliberately does NOT own: the durable effect reservation (§4.4 — the reservation is
 * taken immediately before the authorized dispatch, never at queue time), the duplicate-suppression
 * decision (the `EffectGuard` over `effect_reservations`, never a cache), the dispatch itself, and
 * the approval lifecycle (the orchestrator's `pauseForApproval` / `claimApprovalAndResume`). No
 * Redis handle exists on this boundary, so no cache can ever decide an admission.
 */

import {
  type AssignableAuthority,
  assertNoHypothesisPromotion,
  type AuthorityLevel,
} from '../contracts/index.js';
import { sha256CanonicalJson } from '../durability/canonical-json.js';
import { requireAuditHmacSecret } from '../durability/evidence.js';
import {
  evaluateAuthorityVerdict,
  isAuthorityLevel,
  strictestRequirement,
} from './authority.js';
import type { AutonomyAdmissionPort } from '../autonomy/types.js';
import type {
  ApprovalQueuePort,
  AuthoritativeSourcePort,
  ConsentSource,
  ConsentState,
  InjectionDetector,
  PolicyActionProposal,
  PolicyAuditPort,
  PolicyDecision,
  PolicyEnforcementOptions,
  PolicyRegistryPort,
  PolicyRegistrySkill,
  PolicySecurityContext,
  PriceFloorSource,
  TenantPolicySource,
} from './types.js';
export type * from './types.js';

import {
  EFFECT_KEY_FIELDS,
  RETRY_ATTEMPT_FIELDS,
  deny,
  readNumberField,
  stringValue,
} from './payload-readers.js';
import type { PolicyDenial } from './payload-readers.js';
import { checkAutonomyLimits, checkBinding, checkPrice } from './rule-checks.js';
import type { ApprovalRouteRequest } from './rule-checks.js';
/* ------------------------------------------------------------------------------------------------
 * Evaluation internals
 * ---------------------------------------------------------------------------------------------- */

/** Per-evaluation facts every refusal and the audit intent are built from. */
interface EvaluationBase {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly skill_id: string;
  readonly tool_name: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly evaluated_at: string;
  /** `null` only before the payload digest was computed; a digest failure is itself a refusal. */
  readonly payload_sha256: string | null;
  /** Effect key presented by the payload, when it is a usable string. */
  readonly effect_key: string | null;
  /** One-time approval binding carried only through the resumed action recheck. */
  readonly claimed_approval_id: string | null;
}

 /** Authority facts resolved for the evaluation; `NO_AUTHORITY` until stage 3 has run. */
interface AuthorityFacts {
  readonly granted: AssignableAuthority | null;
  readonly requirement: AuthorityLevel | null;
  readonly requirementSource: 'REGISTRY' | 'PROPOSAL' | null;
}
/** A permitted action. The PEP still dispatches nothing: the orchestrator reserves and calls out. */
interface PermitOutcome {
  readonly kind: 'PERMIT';
  readonly reason: string;
}

type EvaluationOutcome = PolicyDenial | ApprovalRouteRequest | PermitOutcome;
const NO_AUTHORITY: AuthorityFacts = Object.freeze({
  granted: null,
  requirement: null,
  requirementSource: null,
});
/* ------------------------------------------------------------------------------------------------
 * The enforcement point
 * ---------------------------------------------------------------------------------------------- */

/**
 * Deterministic policy enforcement point (implement/08 §1.2, §7.1). Every dependency is injected,
 * the clock is injected, and the class holds no state that one evaluation could leak into another.
 */
export class PolicyEnforcementPoint {
  private readonly registry: PolicyRegistryPort;
  private readonly approvals: ApprovalQueuePort;
  private readonly tenantPolicy: TenantPolicySource | undefined;
  private readonly authoritativeSource: AuthoritativeSourcePort | undefined;
  private readonly priceFloor: PriceFloorSource | undefined;
  private readonly consent: ConsentSource | undefined;
  private readonly injectionDetector: InjectionDetector | undefined;
  private readonly audit: PolicyAuditPort | undefined;
  private readonly auditSecret: string | undefined;
  private readonly autonomy: AutonomyAdmissionPort | undefined;
  private readonly now: () => Date;

  constructor(options: PolicyEnforcementOptions) {
    this.registry = options.registry;
    this.approvals = options.approvals;
    this.tenantPolicy = options.tenantPolicy;
    this.authoritativeSource = options.authoritativeSource;
    this.priceFloor = options.priceFloor;
    this.consent = options.consent;
    this.injectionDetector = options.injectionDetector;
    this.audit = options.audit;
    this.auditSecret = options.auditSecret;
    this.autonomy = options.autonomy;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Evaluates one proposed action against the authority model, the registry, the trusted policy
   * inputs and the applicable business rules.
   *
   * @param context - Server-resolved tenant, session, agent and subject binding.
   * @param proposal - The action the caller proposes.
   * @returns The verdict: `PERMIT` (dispatch may be prepared by the orchestrator), an approval
   *   route with its durable ticket, or a typed refusal. The PEP itself never dispatches.
   */
  async enforce(
    context: PolicySecurityContext,
    proposal: PolicyActionProposal,
  ): Promise<PolicyDecision> {
    const evaluated_at = this.now().toISOString();
    const initial: EvaluationBase = {
      tenant_id: context.tenant_id,
      agent_id: context.agent_id,
      skill_id: proposal.skill_id,
      tool_name: proposal.tool_name,
      run_id: context.run_id,
      request_id: context.request_id,
      correlation_id: context.correlation_id,
      evaluated_at,
      payload_sha256: null,
      effect_key: null,
      claimed_approval_id: null,
    };

    const claimedApprovalId = proposal.approval_id === undefined ? null : proposal.approval_id.trim();

    if (claimedApprovalId !== null && claimedApprovalId.length === 0) {
      return this.settle(
        initial,
        NO_AUTHORITY,
        deny(
          'BR-007',
          'APPROVAL_BINDING_INVALID',
          'APPROVAL_BINDING_INVALID: a resumed action must carry a non-empty claimed approval id.',
        ),
      );
    }

    const boundInitial = { ...initial, claimed_approval_id: claimedApprovalId };

    // Stage 1: the binding is server-resolved. A missing tenant is refused before anything else, so
    // no private record can be read for an unbound request (NFR-006).
    if (context.tenant_id.trim().length === 0) {
      return this.settle(
        initial,
        NO_AUTHORITY,
        deny(
          'PEP-BINDING',
          'TENANT_CONTEXT_REQUIRED',
          'TENANT_CONTEXT_REQUIRED: the run carries no server-bound tenant, and a payload-asserted '
            + 'tenant is never accepted as a binding (NFR-006).',
        ),
      );
    }

    // Stage 2: the action digest every later guard and the audit intent are bound to.
    let payload_sha256: string;

    try {
      payload_sha256 = sha256CanonicalJson(proposal.payload);
    } catch {
      return this.settle(
        initial,
        NO_AUTHORITY,
        deny(
          'PEP-BINDING',
          'POLICY_INPUT_INVALID',
          'POLICY_INPUT_INVALID: the action payload has no canonical JSON form, so no approval or '
            + 'evidence row could be bound to it (NFR-002).',
        ),
      );
    }

      const base: EvaluationBase = {
        ...boundInitial,
        payload_sha256,
        effect_key: stringValue(proposal.payload, EFFECT_KEY_FIELDS),
      };

    const binding = checkBinding(context, proposal, this.registry);
    if (binding !== null) {
      return this.settle(base, NO_AUTHORITY, binding);
    }

    // Stage 3: explicit server registry admission — unknown agent, unknown skill and an agent
    // outside `allowed_agents` each fail closed before any route or rank is computed (§7.1).
    const skill = this.registry.getSkill(proposal.skill_id.trim());

    if (skill === undefined) {
      return this.settle(
        base,
        NO_AUTHORITY,
        deny(
          'BR-008',
          'UNKNOWN_SKILL',
          `UNKNOWN_SKILL: '${proposal.skill_id}' is not in the server registry; a missing registry `
            + 'row is never replaced by a caller-declared requirement (BR-008).',
        ),
      );
    }

    const agent_id = context.agent_id.trim();
    const agent = agent_id.length === 0 ? undefined : this.registry.getAgent(agent_id, context.tenant_id);

    if (agent === undefined) {
      return this.settle(
        base,
        NO_AUTHORITY,
        deny(
          'BR-008',
          'UNKNOWN_AGENT',
          agent_id.length === 0
            ? 'UNKNOWN_AGENT: no agent identity was presented, so no assigned grant exists (BR-008).'
            : `UNKNOWN_AGENT: '${agent_id}' is not a server-registered agent (BR-008).`,
        ),
      );
    }

    if (!skill.allowed_agents.some((allowed) => allowed === agent_id)) {
      return this.settle(
        base,
        NO_AUTHORITY,
        deny(
          'BR-008',
          'UNAUTHORIZED_AGENT',
          `UNAUTHORIZED_AGENT: '${agent_id}' is not in the allowed_agents binding of `
            + `${skill.skill_id} (BR-008).`,
        ),
      );
    }

    if (!isAuthorityLevel(skill.required_authority)) {
      return this.settle(
        base,
        NO_AUTHORITY,
        deny(
          'BR-008',
          'INVALID_AUTHORITY_REQUIREMENT',
          `INVALID_AUTHORITY_REQUIREMENT: registry row ${skill.skill_id} carries `
            + `'${String(skill.required_authority)}', which is outside AUTH-0..AUTH-5 (BR-008).`,
        ),
      );
    }

    // A declared requirement may only raise the registry's: an untrusted payload can never lower a
    // requirement, and a self-declared AUTH-5 is honoured as a hard deny instead of being dropped.
    const declared = proposal.required_authority;
    if (declared !== undefined && !isAuthorityLevel(declared)) {
      return this.settle(
        base,
        NO_AUTHORITY,
        deny(
          'BR-008',
          'INVALID_AUTHORITY_REQUIREMENT',
          `INVALID_AUTHORITY_REQUIREMENT: the proposal declares '${String(declared)}', which is `
            + 'outside AUTH-0..AUTH-5 (BR-008).',
        ),
      );
    }

    const folded = declared === undefined
      ? skill.required_authority
      : strictestRequirement(skill.required_authority, declared);
    const verdict = evaluateAuthorityVerdict(agent.assigned_authority, folded);
    const facts: AuthorityFacts = {
      granted: verdict.granted,
      requirement: verdict.required,
      requirementSource: folded === skill.required_authority ? 'REGISTRY' : 'PROPOSAL',
    };

    if (verdict.verdict === 'DENIED') {
      return this.settle(
        base,
        facts,
        deny('BR-008', verdict.errorCode ?? 'INVALID_CLEARANCE', verdict.reason),
      );
    }

    // Stage 4: untrusted content is scanned next, so a privilege-elevation attempt is refused before
    // any approval route can be considered (BR-009, §2.2 item 2).
    const injection = this.injectionDetector?.scan(proposal.payload);

    if (injection?.detected === true) {
      return this.settle(
        base,
        facts,
        deny(
          'BR-009',
          'PROMPT_INJECTION_BLOCKED',
          `PROMPT_INJECTION_BLOCKED: the proposal content carries a privilege-elevation attempt `
            + `(${injection.pattern_class ?? 'unclassified'}), which is neutralised before dispatch `
            + '(BR-009).',
        ),
      );
    }

    // Stage 5: the applicable trusted-input checks run for BOTH routes, so an approval is never a
    // way to queue an input that could not be resolved (identity, consent, floor, takeover, effects).
    const checked = await this.runChecks({
      context,
      skill,
      proposal,
      effect_key: base.effect_key,
    });

    if (checked?.kind === 'DENY') {
      return this.settle(base, facts, checked);
    }

    if (base.claimed_approval_id !== null && folded !== 'AUTH-4') {
      return this.settle(
        base,
        facts,
        deny(
          'BR-007',
          'APPROVAL_BINDING_INVALID',
          'APPROVAL_BINDING_INVALID: a claimed approval may satisfy only the exact AUTH-4 route; it '
            + 'never raises or replaces the run clearance.',
        ),
      );
    }

    if (base.claimed_approval_id !== null && checked?.kind === 'ROUTE') {
      return this.settle(
        base,
        facts,
        deny(
          'BR-007',
          'APPROVAL_BINDING_INVALID',
          `APPROVAL_BINDING_INVALID: the claimed AUTH-4 decision cannot bypass the current policy `
            + `route ${checked.ruleId}; the action is refused rather than re-approved implicitly.`,
        ),
      );
    }

    const route = base.claimed_approval_id !== null
      ? null
      : verdict.verdict === 'AWAITING_HUMAN_APPROVAL'
        ? {
          kind: 'ROUTE',
          decisionCode: 'REQUIRE_HUMAN_APPROVAL',
          ruleId: 'BR-007',
          reason: verdict.reason,
        } as const
        : checked;

    // Stage 6: BR-010 preconditions. An effect-bearing permit, and every approval row, must be
    // backed by a durable, signed audit intent; otherwise the permit is withheld, not warned about.
    if (skill.mutating || route !== null) {
      const auditPrecondition = this.auditPrecondition(skill.mutating);

      if (auditPrecondition !== null) {
        return this.settle(base, facts, auditPrecondition);
      }
    }

    return this.settle(base, facts, route ?? {
      kind: 'PERMIT',
      reason: base.claimed_approval_id !== null
        ? `AUTHORIZED: claimed approval ${base.claimed_approval_id} covers this exact AUTH-4 action; current policy checks passed.`
        : `AUTHORIZED: ${String(facts.granted)} covers ${String(facts.requirement)} for `
          + `${skill.skill_id}; the orchestrator may reserve the effect and dispatch.`,
    });
  }

  /**
   * Runs every check the registry row makes applicable, in BR order, and reports the first failure.
   * A check that cannot be evaluated fails closed: no default value, cached value or model guess is
   * ever substituted for a trusted input (NFR-008).
   *
   * @param params - Bound context, registry row, proposal and the derived action digest.
   * @returns A refusal, a limit-driven approval route, or `null` when every applicable check passed.
   */
  private async runChecks(params: {
    readonly context: PolicySecurityContext;
    readonly skill: PolicyRegistrySkill;
    readonly proposal: PolicyActionProposal;
    readonly effect_key: string | null;
  }): Promise<PolicyDenial | ApprovalRouteRequest | null> {
    const { context, skill, proposal, effect_key } = params;
    const tenant_id = context.tenant_id.trim();
    const verified_customer_id = context.verified_customer_id?.trim() ?? '';

    // FR-C360-003: a derived value is never written into a System-of-Record mirror.
    try {
      assertNoHypothesisPromotion({
        target: skill.write_target,
        source: skill.epistemic_class,
        target_ref: `${skill.skill_id} → ${skill.write_target}`,
      });
    } catch {
      return deny(
        'PEP-EPISTEMIC',
        'HYPOTHESIS_PROMOTION_REJECTED',
        `HYPOTHESIS_PROMOTION_REJECTED: ${skill.skill_id} is registered as `
          + `${skill.epistemic_class} and may not write the FACT target ${skill.write_target} `
          + '(FR-C360-003).',
      );
    }

    if (skill.requires_verified_identity && verified_customer_id.length === 0) {
      return deny(
        'PEP-BINDING',
        'IDENTITY_UNVERIFIED',
        `IDENTITY_UNVERIFIED: ${skill.skill_id} requires a server-verified customer and this `
          + 'session has none; verification is completed before the lookup, never asserted in a '
          + 'payload (NFR-008, TC-E2E-004).',
      );
    }

    if (context.takeover_active && skill.mutating) {
      return deny(
        'PEP-TAKEOVER',
        'HUMAN_TAKEOVER',
        'HUMAN_TAKEOVER: an operator holds the SCR-005 session lock, so no autonomous send may be '
          + 'prepared or dispatched while the hold is active (NFR-007).',
      );
    }

    if (skill.requires_consent) {
      if (verified_customer_id.length === 0) {
        return deny(
          'BR-004',
          'IDENTITY_UNVERIFIED',
          'IDENTITY_UNVERIFIED: consent is scoped to a verified customer, and this session has '
            + 'none (BR-004, NFR-008).',
        );
      }

      if (this.consent === undefined) {
        return deny(
          'BR-004',
          'CONSENT_REQUIRED',
          'CONSENT_REQUIRED: no consent source is available, so verified, unrevoked consent cannot '
            + 'be established for this outreach (BR-004).',
        );
      }

      let state: ConsentState | undefined;

      try {
        state = await this.consent.getConsent({
          tenant_id,
          customer_id: verified_customer_id,
        });
      } catch {
        state = undefined;
      }

      if (
        state === undefined
        || state.consent_marketing !== true
        || state.suppression_active === true
      ) {
        return deny(
          'BR-004',
          'CONSENT_REQUIRED',
          `CONSENT_REQUIRED: outreach to ${verified_customer_id} is not covered by verified, `
            + 'unrevoked consent, so the message is suppressed without retry (BR-004).',
        );
      }
    }

    if (skill.price_bearing) {
      const priced = await checkPrice({
        tenant_id,
        skill_id: skill.skill_id,
        mutating: skill.mutating,
        payload: proposal.payload,
        authoritativeSource: this.authoritativeSource,
        priceFloor: this.priceFloor,
      });

      if (priced !== null) {
        return priced;
      }
    }

    if (skill.mutating && effect_key === null) {
      return deny(
        'BR-005',
        'EFFECT_KEY_REQUIRED',
        `EFFECT_KEY_REQUIRED: mutating skill ${skill.skill_id} was proposed without a deterministic `
          + 'effect_key, and no effect may be dispatched unreserved (BR-005, §4.4).',
      );
    }

    const retry = readNumberField(proposal.payload, RETRY_ATTEMPT_FIELDS);

    if (retry.state === 'INVALID') {
      return deny(
        'BR-006',
        'POLICY_INPUT_INVALID',
        'POLICY_INPUT_INVALID: the retry counter must be a finite non-negative number; a malformed '
          + 'value is never interpreted as a first attempt (BR-006).',
      );
    }

    if (
      retry.state === 'VALID'
      && retry.value > 0
      && skill.mutating
      && !skill.idempotent
    ) {
      return deny(
        'BR-006',
        'IDEMPOTENCY_CONFLICT',
        `IDEMPOTENCY_CONFLICT: ${skill.skill_id} is not registered as idempotent, so a retry cannot `
          + 'duplicate the effect; an indeterminate outcome is reconciled by effect_key instead '
          + '(BR-006, §4.4).',
      );
    }

    return checkAutonomyLimits({
      tenant_id,
      payload: proposal.payload,
      tenantPolicy: this.tenantPolicy,
    });
  }

  /**
   * Checks the BR-010 preconditions: the audit sink exists, and — for an effect-bearing action —
   * the canonical audit signing secret is configured, because an unsigned audit chain is not an
   * audit chain (§04 §6.1).
   *
   * @param requiresSigning - `true` for a mutating action, which produces signed evidence.
   * @returns A refusal, or `null` when the durable audit intent can be written.
   */
  private auditPrecondition(requiresSigning: boolean): PolicyDenial | null {
    if (this.audit === undefined) {
      return deny(
        'BR-010',
        'EVIDENCE_REQUIRED',
        'EVIDENCE_REQUIRED: no audit sink is injected, so the decision intent could not be made '
          + 'durable before dispatch, and an unrecorded permit is not a permit (BR-010, NFR-002).',
      );
    }

    if (!requiresSigning) {
      return null;
    }

    try {
      requireAuditHmacSecret(this.auditSecret);
    } catch {
      return deny(
        'BR-010',
        'AUDIT_SECRET_MISSING',
        'AUDIT_SECRET_MISSING: no audit signing secret is configured, so the evidence chain of this '
          + 'external effect cannot be signed and the permit is withheld (BR-010, NFR-002).',
      );
    }

    return null;
  }

  /**
   * Applies the durability half of one outcome: the audit intent precedes any pending approval row,
   * and both are fail-closed.
   *
   * @param base - Per-evaluation facts.
   * @param authority - Resolved authority facts.
   * @param outcome - The evaluated outcome.
   * @returns The final decision, with the ticket id and the audit status it earned.
   */
  private async settle(
    base: EvaluationBase,
    authority: AuthorityFacts,
    outcome: EvaluationOutcome,
  ): Promise<PolicyDecision> {
    if (outcome.kind === 'ROUTE') {
      // The route intent is durable before an approval row exists. The ticket id is necessarily
      // absent here: the approval store is the authority that creates or reads it.
      const intent = this.buildDecision(base, authority, outcome, null, 'NOT_APPLICABLE');
      const intentAuditStatus = await this.appendAudit(intent);

      if (intentAuditStatus === 'FAILED') {
        const denied = this.buildDecision(
          base,
          authority,
          deny(
            'BR-010',
            'AUDIT_UNAVAILABLE',
            'AUDIT_UNAVAILABLE: the decision intent could not be persisted, so the approval route '
              + 'and any permit it implies are withheld — audit failure blocks dispatch, it is never '
              + 'a logging warning (BR-010, NFR-002).',
          ),
          null,
          'FAILED',
        );
        return this.applyAutonomy(denied);
      }

      const queued = await this.createPendingApproval(base, outcome);

      if (queued.kind === 'DENY') {
        // The route intent was recorded, but no pending row exists. Record the compensating refusal
        // so the append-only chain cannot imply that a human decision is still claimable.
        const compensation = this.buildDecision(base, authority, queued, null, 'NOT_APPLICABLE');
        const compensationAuditStatus = await this.appendAudit(compensation);
        const denied = this.buildDecision(
          base,
          authority,
          queued,
          null,
          compensationAuditStatus,
        );
        return this.applyAutonomy(denied);
      }

      return this.applyAutonomy(
        this.buildDecision(base, authority, outcome, queued.approval_id, intentAuditStatus),
      );
    }

    const provisional = this.buildDecision(base, authority, outcome, base.claimed_approval_id, 'NOT_APPLICABLE');
    const auditStatus = await this.appendAudit(provisional);

    if (outcome.kind !== 'DENY' && auditStatus === 'FAILED') {
      const denied = this.buildDecision(
        base,
        authority,
        deny(
          'BR-010',
          'AUDIT_UNAVAILABLE',
          'AUDIT_UNAVAILABLE: the decision intent could not be persisted, so the permit is withheld '
            + '— audit failure blocks dispatch, it is never a logging warning (BR-010, NFR-002).',
        ),
        null,
        'FAILED',
      );
      return this.applyAutonomy(denied);
    }

    return this.applyAutonomy({ ...provisional, auditStatus });
  }

  /**
   * Controlled autonomy is an annotation after the canonical PEP outcome is final. A port failure
   * or an unexpected response can never turn a refusal into a permit or alter the verdict.
   */
  private async applyAutonomy(decision: PolicyDecision): Promise<PolicyDecision> {
    if (this.autonomy === undefined) return decision;
    try {
      const skill = this.registry.getSkill(decision.skillId);
      const admission = await this.autonomy.admit({
        tenant_id: decision.tenantId,
        skill_id: decision.skillId,
        policy_version: skill?.policy_version?.trim() ?? '',
        required_authority: skill?.required_authority?.trim() ?? '',
      });
      if (decision.verdict !== 'AUTO_APPROVED') return decision;
      return { ...decision, autonomyWorkflow: admission.workflow };
    } catch {
      if (decision.verdict !== 'AUTO_APPROVED') return decision;
      return { ...decision, autonomyWorkflow: 'PARKED_DRAFT' };
    }
  }

  /**
   * Creates or reads the one PENDING approval row of an approval route (§7.2). No row is created
   * before every applicable check has passed, and a store that cannot answer produces a refusal
   * rather than an approval without a ticket.
   *
   * @param base - Per-evaluation facts bound into the row.
   * @param route - The route being taken.
   * @returns The durable approval id, or the refusal that replaces the route.
   */
  private async createPendingApproval(
    base: EvaluationBase,
    route: ApprovalRouteRequest,
  ): Promise<{ readonly kind: 'TICKET'; readonly approval_id: string } | PolicyDenial> {
    if (base.payload_sha256 === null) {
      return deny(
        'BR-007',
        'APPROVAL_QUEUE_UNAVAILABLE',
        'APPROVAL_QUEUE_UNAVAILABLE: an approval row binds the action payload digest, and this '
          + 'action has none (BR-007).',
      );
    }

    try {
      const pending = await this.approvals.createOrReadPending({
        tenant_id: base.tenant_id.trim(),
        run_id: base.run_id,
        request_id: base.request_id,
        skill_id: base.skill_id,
        agent_id: base.agent_id.trim(),
        effect_key: base.effect_key,
        payload_sha256: base.payload_sha256,
        required_authority: 'AUTH-4',
        route: route.decisionCode,
        reason: route.reason,
        created_at: base.evaluated_at,
      });

      if (pending.approval_id.trim().length === 0) {
        return deny(
          'BR-007',
          'APPROVAL_QUEUE_UNAVAILABLE',
          'APPROVAL_QUEUE_UNAVAILABLE: the approval store returned no id for the prepared action, '
            + 'and a route without a durable row is not a route (BR-007).',
        );
      }

      return { kind: 'TICKET', approval_id: pending.approval_id };
    } catch {
      return deny(
        'BR-007',
        'APPROVAL_QUEUE_UNAVAILABLE',
        'APPROVAL_QUEUE_UNAVAILABLE: the approval store could not persist the PENDING row, so the '
          + 'action is refused rather than approved without a bound human decision (BR-007).',
      );
    }
  }

  /**
   * Writes the decision intent to the audit sink (§08 §7.1 step 6). A refusal is still recorded:
   * the audit trail must show every attempt, including the denied ones (NFR-002).
   *
   * @param decision - The decision about to be returned.
   * @returns `RECORDED`, `FAILED`, or `NOT_APPLICABLE` when no sink was injected and none was
   *   required for this action.
   */
  private async appendAudit(
    decision: PolicyDecision,
  ): Promise<'RECORDED' | 'FAILED' | 'NOT_APPLICABLE'> {
    if (this.audit === undefined) {
      return 'NOT_APPLICABLE';
    }

    try {
      await this.audit.append({
        tenant_id: decision.tenantId,
        run_id: decision.runId,
        correlation_id: decision.correlationId,
        agent_id: decision.agentId,
        skill_id: decision.skillId,
        tool_name: decision.toolName,
        authority: decision.resolvedRequirement,
        verdict: decision.verdict,
        decision_code: decision.decisionCode,
        rule_id: decision.ruleId,
        error_code: decision.errorCode,
        approval_id: decision.approvalTicketId,
        effect_key: decision.effectKey,
        payload_sha256: decision.payloadSha256,
        occurred_at: decision.evaluatedAt,
      });

      return 'RECORDED';
    } catch {
      return 'FAILED';
    }
  }

  /**
   * Maps an outcome onto the public decision shape, preserving the canonical verdict vocabulary.
   *
   * @param base - Per-evaluation facts.
   * @param authority - Resolved authority facts.
   * @param outcome - Outcome to render.
   * @param approvalTicketId - Ticket of the route, when one was created.
   * @param auditStatus - Audit status known at rendering time.
   * @returns The decision returned to the caller.
   */
  private buildDecision(
    base: EvaluationBase,
    authority: AuthorityFacts,
    outcome: EvaluationOutcome,
    approvalTicketId: string | null,
    auditStatus: 'RECORDED' | 'FAILED' | 'NOT_APPLICABLE',
  ): PolicyDecision {
    const common = {
      tenantId: base.tenant_id,
      agentId: base.agent_id,
      skillId: base.skill_id,
      runId: base.run_id,
      correlationId: base.correlation_id,
      toolName: base.tool_name,
      grantedAuthority: authority.granted,
      resolvedRequirement: authority.requirement,
      requirementSource: authority.requirementSource,
      effectKey: base.effect_key,
      payloadSha256: base.payload_sha256,
      evaluatedAt: base.evaluated_at,
      auditStatus,
    } as const;

    if (outcome.kind === 'DENY') {
      return {
        ...common,
        verdict: 'DENIED',
        decisionCode: 'DENY_PROHIBITED',
        authorized: false,
        ruleId: outcome.ruleId,
        errorCode: outcome.errorCode,
        reason: outcome.reason,
        approvalTicketId: null,
      };
    }

    if (outcome.kind === 'ROUTE') {
      return {
        ...common,
        verdict: 'AWAITING_HUMAN_APPROVAL',
        decisionCode: outcome.decisionCode,
        authorized: false,
        ruleId: outcome.ruleId,
        errorCode: null,
        reason: outcome.reason,
        approvalTicketId,
      };
    }

    return {
      ...common,
      verdict: 'AUTO_APPROVED',
      decisionCode: 'PERMIT',
      authorized: true,
      ruleId: null,
      errorCode: null,
      reason: outcome.reason,
      approvalTicketId: null,
    };
  }
}

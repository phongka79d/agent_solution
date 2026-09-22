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
  type AuthorityVerdict,
  type EpistemicClassification,
  type EpistemicWriteTarget,
} from '../contracts/index.js';
import { sha256CanonicalJson } from '../durability/canonical-json.js';
import { requireAuditHmacSecret } from '../durability/evidence.js';
import {
  evaluateAuthorityVerdict,
  isAuthorityLevel,
  strictestRequirement,
} from './authority.js';

/**
 * PEP-level spelling of a decision (implement/08 §1.2 `decisionCode`, mapped to the verdict
 * vocabulary by §7.2): `PERMIT` → `AUTO_APPROVED`, `REQUIRE_HUMAN_APPROVAL` / `LIMIT_EXCEEDED` →
 * `AWAITING_HUMAN_APPROVAL`, `DENY_PROHIBITED` → `DENIED`. `DENY_PROHIBITED` is the spelling of
 * every terminal refusal; the exact rule is carried by `errorCode` and `ruleId`.
 */
export type EnforcementDecisionCode =
  | 'PERMIT'
  | 'REQUIRE_HUMAN_APPROVAL'
  | 'LIMIT_EXCEEDED'
  | 'DENY_PROHIBITED';

/** The rule an outcome belongs to: the ten business rules, plus the PEP's own binding stages. */
export type PolicyRuleId =
  | 'PEP-BINDING'
  | 'PEP-TOPOLOGY'
  | 'PEP-EPISTEMIC'
  | 'PEP-TAKEOVER'
  | 'BR-001'
  | 'BR-002'
  | 'BR-003'
  | 'BR-004'
  | 'BR-005'
  | 'BR-006'
  | 'BR-007'
  | 'BR-008'
  | 'BR-009'
  | 'BR-010';

/**
 * Stable refusal codes (implement/08 §8 matrix, §7.1). Every one of them is a fail-closed answer to
 * a question the PEP could not answer safely — never a default, a fallback or a retryable guess.
 */
export type PolicyDenyCode =
  /** No server-bound tenant reached the PEP (NFR-006). */
  | 'TENANT_CONTEXT_REQUIRED'
  /** The payload asserted a tenant other than the bound one (NFR-006, SRS §19). */
  | 'CROSS_TENANT_ASSERTION'
  /** The payload asserted a customer the session is not server-verified as (BR-003, NFR-006). */
  | 'CROSS_CUSTOMER_ASSERTION'
  /** A skill that needs a verified customer was evaluated with none (NFR-008, TC-E2E-004). */
  | 'IDENTITY_UNVERIFIED'
  /** A direct agent-to-agent target: routing belongs to the supervisor, never to a peer call. */
  | 'AGENT_TO_AGENT_FORBIDDEN'
  /** The agent id is absent or not a server-registered agent row (BR-008). */
  | 'UNKNOWN_AGENT'
  /** The skill id is absent from the server registry: `UNKNOWN_SKILL`, never a declared fallback. */
  | 'UNKNOWN_SKILL'
  /** The agent is not in the registry row's `allowed_agents` (BR-008). */
  | 'UNAUTHORIZED_AGENT'
  /** No grant was presented at all. */
  | 'CLEARANCE_REQUIRED'
  /** The grant is outside the assignable `AUTH-0..3` set (BR-008). */
  | 'INVALID_CLEARANCE'
  /** The requirement is missing or outside the `AUTH-0..AUTH-5` vocabulary (BR-008). */
  | 'INVALID_AUTHORITY_REQUIREMENT'
  /** `AUTH-5`: prohibited, never queued and never approvable (BR-008). */
  | 'PROHIBITED_ACTION'
  /** A valid grant below a valid autonomous requirement (BR-008). */
  | 'INSUFFICIENT_AUTHORITY'
  /** Untrusted content attempted a privilege elevation or a policy rewrite (BR-009). */
  | 'PROMPT_INJECTION_BLOCKED'
  /** A derived value was aimed at a System-of-Record FACT target (FR-C360-003). */
  | 'HYPOTHESIS_PROMOTION_REJECTED'
  /** Marketing/outreach without verified, unrevoked consent (BR-004). */
  | 'CONSENT_REQUIRED'
  /** A price-bearing action without an owner-approved, provenance-bearing floor decision (BR-001). */
  | 'P_FLOOR_UNAVAILABLE'
  /** A price that is not traceable to an authenticated catalog reference (BR-001). */
  | 'ERR_ARBITRARY_PRICING'
  /** An effective price below the approved floor (BR-002). */
  | 'ERR_FLOOR_PRICE_VIOLATION'
  /** Price/inventory could not be read from the System of Record (BR-003). */
  | 'AUTHORITATIVE_SOURCE_UNAVAILABLE'
  /** A mutating action without the deterministic effect key of BR-005. */
  | 'EFFECT_KEY_REQUIRED'
  /** A retry that would duplicate a non-idempotent effect (BR-006). */
  | 'IDEMPOTENCY_CONFLICT'
  /** A governed field was present but not a usable value: no default is ever invented (BR-007). */
  | 'POLICY_INPUT_INVALID'
  /** A human holds the SCR-005 session lock; no autonomous send during the hold (NFR-007). */
  | 'HUMAN_TAKEOVER'
  /** No audit sink was injected for an action that requires a durable audit intent (BR-010). */
  | 'EVIDENCE_REQUIRED'
  /** `AUDIT_HMAC_SECRET` is not configured, so no signed chain can exist (NFR-002). */
  | 'AUDIT_SECRET_MISSING'
  /** The audit intent could not be persisted, so no permit may stand (BR-010, NFR-002). */
  | 'AUDIT_UNAVAILABLE'
  /** No durable PENDING row could be created/read for an approval route (BR-007). */
  | 'APPROVAL_QUEUE_UNAVAILABLE';

/** The verdict, the PEP-level decision code and the reason a caller acts on. */
export interface PolicyDecision {
  /** Canonical verdict vocabulary, preserved unchanged (`04` §3.1, `08` §7.2). */
  readonly verdict: AuthorityVerdict;
  readonly decisionCode: EnforcementDecisionCode;
  /** `true` only for `PERMIT`. A refusal and an approval route are both "not authorized". */
  readonly authorized: boolean;
  readonly ruleId: PolicyRuleId | null;
  /** `null` for every permitted decision and for an approval route. */
  readonly errorCode: PolicyDenyCode | null;
  readonly reason: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly skillId: string;
  /** Run the action belongs to; the audit intent and any approval row are bound to it. */
  readonly runId: string;
  readonly correlationId: string;
  /** Registry-bound tool identifier, carried into the audit intent. */
  readonly toolName: string;
  readonly grantedAuthority: AssignableAuthority | null;
  readonly resolvedRequirement: AuthorityLevel | null;
  /** `PROPOSAL` only when a declared requirement raised the registry's; never when it lowered it. */
  readonly requirementSource: 'REGISTRY' | 'PROPOSAL' | null;
  /** Set exactly when an approval route owns a durable PENDING row. */
  readonly approvalTicketId: string | null;
  /** SHA-256 of the canonical payload; the digest an approval row is bound to (§08 §7.2). */
  readonly payloadSha256: string | null;
  readonly evaluatedAt: string;
  readonly auditStatus: 'RECORDED' | 'FAILED' | 'NOT_APPLICABLE';
}

/* ------------------------------------------------------------------------------------------------
 * Server-side registry projection (implement/05 §6.1, implement/08 §1.2)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The registry row the PEP trusts as the *only* authority source: a projection of `skills` (§03
 * Entity 20) carrying the fields an admission decision needs.
 */
export interface PolicyRegistrySkill {
  readonly skill_id: string;
  /**
   * Stored `skills.required_authority`. Kept as a `string` on purpose: a corrupt or hand-edited row
   * must be refused with `INVALID_AUTHORITY_REQUIREMENT`, not assumed to be well typed.
   */
  readonly required_authority: string;
  /** Registry-declared agent binding; an agent absent here is `UNAUTHORIZED_AGENT`. */
  readonly allowed_agents: readonly string[];
  /** `true` ⇒ the step has an external effect that must be reserved before dispatch (§4.4). */
  readonly mutating: boolean;
  /** `true` ⇒ the payload carries pricing intent, so the floor decision applies (BR-001/BR-002). */
  readonly price_bearing: boolean;
  /** `true` ⇒ replaying the same effect key is safe (BR-006). */
  readonly idempotent: boolean;
  /** The class this skill produces; a non-`FACT` class may never target a FACT mirror. */
  readonly epistemic_class: EpistemicClassification;
  /** Destination classification the row is registered to write. */
  readonly write_target: EpistemicWriteTarget;
  /** `true` ⇒ marketing/outreach: verified, unrevoked consent is required (BR-004). */
  readonly requires_consent: boolean;
  /** `true` ⇒ the skill needs a server-verified customer identity (NFR-008, TC-E2E-004). */
  readonly requires_verified_identity: boolean;
  /** Registry-declared hard deadline (§05 field 10). */
  readonly timeout_ms: number;
}

/** The agent row the PEP trusts: `agents.assigned_authority` only ever assigns `AUTH-0..3`. */
export interface PolicyRegistryAgent {
  readonly agent_id: string;
  /**
   * Stored `agents.assigned_authority`. Typed `string` for the same reason as the skill row: a
   * `CHECK` constraint protects the table, and a value that reached the PEP anyway must still be
   * refused by `INVALID_CLEARANCE` (BR-008) instead of being trusted.
   */
  readonly assigned_authority: string;
}

/** Explicit server-side registry lookup; there is no implicit or cached fallback behind it. */
export interface PolicyRegistryPort {
  /**
   * @param skill_id - Skill id from the proposal.
   * @returns The registry row, or `undefined` when the skill is not registered — a miss is
   *   `UNKNOWN_SKILL` and never a fallback to a caller-declared requirement.
   */
  getSkill(skill_id: string): PolicyRegistrySkill | undefined;
  /**
   * @param agent_id - Agent id from the server-bound context.
   * @returns The registry row, or `undefined` when the agent is not registered.
   */
  getAgent(agent_id: string): PolicyRegistryAgent | undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Trusted-input ports
 * ---------------------------------------------------------------------------------------------- */

/**
 * Tenant autonomy limits that move an action from autonomous execution to the AUTH-4 gate
 * (implement/08 §1.2). Every value is owned and approved by the tenant's Business/Finance function;
 * `undefined` means "the owner has approved no value yet" and MUST fail closed — it is never
 * "unlimited", and no illustrative constant may be substituted.
 */
export interface TenantPolicyParameters {
  readonly maxAutonomousDiscountRate?: number;
  readonly maxAutonomousRefundAmount?: number;
  readonly maxAutonomousAudienceSize?: number;
  readonly maxAutonomousReminderCount?: number;
}

/** Source of owner-approved autonomy limits. */
export interface TenantPolicySource {
  /**
   * @param tenant_id - Bound tenant.
   * @returns The approved parameters, or `undefined` when the tenant has approved none.
   */
  get(tenant_id: string): TenantPolicyParameters | undefined;
}

/** One authoritative catalog record as the System of Record returned it (BR-001, BR-003). */
export interface AuthoritativeCatalogRecord {
  readonly catalog_ref_id: string;
  readonly price: number;
  readonly currency: string;
}

/** Read side of the System of Record for pricing references; never a cached or derived price. */
export interface AuthoritativeSourcePort {
  /**
   * Resolves an authenticated catalog/SKU reference.
   *
   * @param input - Tenant and the reference the payload claims.
   * @returns The record, or `undefined` when the reference does not resolve. Throwing means the
   *   source is unreachable, which fails closed as `AUTHORITATIVE_SOURCE_UNAVAILABLE`.
   */
  resolveCatalogReference(input: {
    readonly tenant_id: string;
    readonly catalog_ref_id: string;
  }): Promise<AuthoritativeCatalogRecord | undefined>;
}

/**
 * Owner-approved floor decision (README §8.1, implement/08 §7.3). The PEP never derives a floor and
 * never reads one from the proposal: a locally computed or LLM-influenced number is not a decision.
 */
export interface FloorDecision {
  readonly floor_price: number;
  /** Provenance of the approved decision; a blank source is not provenance. */
  readonly floor_source: string;
  /** `true` only for a decision the owner approved. */
  readonly owner_approved: boolean;
}

/** Source of owner-approved floor decisions. An absent or unapproved decision refuses dispatch. */
export interface PriceFloorSource {
  /**
   * @param input - Tenant and the catalog reference the floor is asked about.
   * @returns The approved decision, or `undefined` when the owner has approved none.
   */
  getFloorDecision(input: {
    readonly tenant_id: string;
    readonly catalog_ref_id: string;
  }): Promise<FloorDecision | undefined>;
}

/** Consent state of one verified customer, as the consent registry holds it (BR-004). */
export interface ConsentState {
  readonly consent_marketing: boolean;
  readonly suppression_active: boolean;
}

/** Consent read port; consent is scoped to a verified customer, never to a payload assertion. */
export interface ConsentSource {
  /**
   * @param input - Tenant and the server-verified customer.
   * @returns The consent state, or `undefined` when no record exists (which is not consent).
   */
  getConsent(input: {
    readonly tenant_id: string;
    readonly customer_id: string;
  }): Promise<ConsentState | undefined>;
}

/**
 * The one row an approval route may create (implement/08 §1.2, §7.2: queue creation uses the real
 * `approvals` row bound to `(tenant_id, run_id, effect_key, payload_digest)`). The row is *not*
 * taken at queue time from a cache and carries no engine-generated identifier.
 */
export interface PendingApprovalRequest {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly request_id: string;
  readonly skill_id: string;
  readonly agent_id: string;
  readonly effect_key: string | null;
  readonly payload_sha256: string;
  /** Always `AUTH-4`: an approval is a routing outcome for one prepared action, never a grant. */
  readonly required_authority: 'AUTH-4';
  readonly route: 'REQUIRE_HUMAN_APPROVAL' | 'LIMIT_EXCEEDED';
  readonly reason: string;
  readonly created_at: string;
}

/** Durable approval store; `createOrReadPending` is idempotent per binding (§7.2). */
export interface ApprovalQueuePort {
  /**
   * Creates the PENDING row for the binding, or reads the existing one.
   *
   * @param request - Binding of the prepared action.
   * @returns The durable approval id. An empty id is refused: no timestamp-generated or synthetic
   *   approval id is accepted as a queue row.
   */
  createOrReadPending(request: PendingApprovalRequest): Promise<{ readonly approval_id: string }>;
}

/** The decision intent the PEP persists before an action can exist (§08 §7.1 step 6, §1.2). */
export interface PolicyAuditRecord {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly agent_id: string;
  readonly skill_id: string;
  readonly tool_name: string;
  readonly authority: AuthorityLevel | null;
  readonly verdict: AuthorityVerdict;
  readonly decision_code: EnforcementDecisionCode;
  readonly rule_id: PolicyRuleId | null;
  readonly error_code: PolicyDenyCode | null;
  readonly approval_id: string | null;
  readonly payload_sha256: string | null;
  readonly occurred_at: string;
}

/** Append-only audit sink. A rejection here blocks a permit; it never becomes a warning. */
export interface PolicyAuditPort {
  append(record: PolicyAuditRecord): Promise<void>;
}

/** Result of scanning untrusted proposal content (BR-009). */
export interface InjectionScanResult {
  readonly detected: boolean;
  readonly pattern_class?: string;
}

/**
 * Privilege-elevation detector port. Pattern matching may raise the alert but is explicitly *not*
 * the security boundary (implement/08 §2.2): the grant, registry and binding checks above hold even
 * when an attack matches none of the detector's words.
 */
export interface InjectionDetector {
  /**
   * @param payload - Untrusted proposal content, scanned as data only.
   * @returns Whether a privilege-elevation or policy-rewrite attempt was observed.
   */
  scan(payload: Record<string, unknown>): InjectionScanResult;
}

/* ------------------------------------------------------------------------------------------------
 * Evaluation inputs
 * ---------------------------------------------------------------------------------------------- */

/**
 * Server-resolved context of one run (implement/08 §1.2 `SecurityContext`). Every identity in it is
 * bound by the gateway or the identity service; nothing here is ever read back from the proposal.
 */
export interface PolicySecurityContext {
  /** Tenant bound to the caller's authenticated session (RLS scope). */
  readonly tenant_id: string;
  /** Server-registered agent identity; the registry row is the only authority source. */
  readonly agent_id: string;
  readonly run_id: string;
  /** Immutable inbound identity (`signal_id` / delivery id) the effect key derives from. */
  readonly request_id: string;
  readonly correlation_id: string;
  /** Server-issued session id; never shared between sessions (NFR-006). */
  readonly session_id: string;
  /** Server-verified customer UUID; absent ⇒ anonymous session, never a payload-supplied value. */
  readonly verified_customer_id?: string;
  /** Live projection of the SCR-005 takeover lock; a human hold suppresses autonomous send. */
  readonly takeover_active: boolean;
}

/** The action the caller proposes; every field except the payload id is descriptive only. */
export interface PolicyActionProposal {
  readonly skill_id: string;
  /** Registry-bound tool/connector identifier, recorded in the audit intent. */
  readonly tool_name: string;
  readonly payload: Record<string, unknown>;
  /**
   * Requirement the proposal declares for itself. It can only *raise* the registry's requirement
   * (a declared `AUTH-5` is honoured as a hard deny); a declared downgrade is ignored (BR-008).
   */
  readonly required_authority?: AuthorityLevel;
  /** Target of a proposed delegation; naming a registered peer agent is a topology violation. */
  readonly target_agent_id?: string;
  /** `0` or absent for a first attempt; `> 0` marks a retry (BR-006). */
  readonly retry_attempt?: number;
}

/** Every edge the PEP is allowed to hold. All of them are injected; the process supplies none. */
export interface PolicyEnforcementOptions {
  /** Server registry projection — the only authority source (required). */
  readonly registry: PolicyRegistryPort;
  /** Durable approval store used by an approval route (required: a route without a row is no route). */
  readonly approvals: ApprovalQueuePort;
  /** Owner-approved autonomy limits; absent ⇒ every limit is unapproved and fails closed. */
  readonly tenantPolicy?: TenantPolicySource;
  /** System-of-Record pricing reference resolution (BR-001/BR-003). */
  readonly authoritativeSource?: AuthoritativeSourcePort;
  /** Owner-approved floor decisions (BR-001/BR-002). */
  readonly priceFloor?: PriceFloorSource;
  /** Consent registry (BR-004). */
  readonly consent?: ConsentSource;
  /** Privilege-elevation detector (BR-009); absence weakens no structural check. */
  readonly injectionDetector?: InjectionDetector;
  /** Durable decision intent (BR-010); required for effect-bearing permits and approval routes. */
  readonly audit?: PolicyAuditPort;
  /**
   * Audit signing secret. When omitted, the canonical `AUDIT_HMAC_SECRET` resolution applies and
   * fails closed when unset; the value is never echoed into a decision or an error.
   */
  readonly auditSecret?: string;
  /** Injected clock, so a decision is reproducible in a test. */
  readonly now?: () => Date;
}

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
  /** Effect key presented by the payload, when it is a usable string (BR-005). */
  readonly effect_key: string | null;
}

/** Authority facts resolved for the evaluation; `NO_AUTHORITY` until stage 3 has run. */
interface AuthorityFacts {
  readonly granted: AssignableAuthority | null;
  readonly requirement: AuthorityLevel | null;
  readonly requirementSource: 'REGISTRY' | 'PROPOSAL' | null;
}

/** A terminal refusal. */
interface PolicyDenial {
  readonly kind: 'DENY';
  readonly ruleId: PolicyRuleId;
  readonly errorCode: PolicyDenyCode;
  readonly reason: string;
}

/** An approval route: one prepared action awaiting a bound human decision. */
interface ApprovalRouteRequest {
  readonly kind: 'ROUTE';
  readonly decisionCode: 'REQUIRE_HUMAN_APPROVAL' | 'LIMIT_EXCEEDED';
  readonly ruleId: PolicyRuleId;
  readonly reason: string;
}

/** A permitted action. The PEP still dispatches nothing: the orchestrator reserves and calls out. */
interface PermitOutcome {
  readonly kind: 'PERMIT';
  readonly reason: string;
}

type EvaluationOutcome = PolicyDenial | ApprovalRouteRequest | PermitOutcome;

/** Read result of an optional payload member: absent, usable, or present-but-unusable. */
type FieldRead<T> =
  | { readonly state: 'ABSENT' }
  | { readonly state: 'VALID'; readonly value: T }
  | { readonly state: 'INVALID' };

const NO_AUTHORITY: AuthorityFacts = Object.freeze({
  granted: null,
  requirement: null,
  requirementSource: null,
});

/** Payload member groups the PEP reads. Everything else in a payload stays opaque to it. */
const TENANT_ASSERTION_FIELDS = Object.freeze(['tenant_id', 'tenantId']);
const CUSTOMER_ASSERTION_FIELDS = Object.freeze([
  'customer_id',
  'customerId',
  'customer_or_entity_id',
]);
const TARGET_AGENT_FIELDS = Object.freeze(['target_agent_id', 'targetAgentId']);
const CATALOG_REFERENCE_FIELDS = Object.freeze(['catalog_ref_id', 'catalogRefId']);
const EFFECTIVE_PRICE_FIELDS = Object.freeze(['effective_price', 'offered_price', 'proposed_price']);
const EFFECT_KEY_FIELDS = Object.freeze(['effect_key', 'effectKey']);
const RETRY_ATTEMPT_FIELDS = Object.freeze(['retry_attempt', 'attempt']);

/**
 * The autonomy limits of `TenantPolicyParameters`, each with the payload members it governs
 * (BR-007). A governed member that is present is bounded by its approved limit; an unapproved limit
 * routes the action to a human instead of being defaulted.
 */
const AUTONOMY_LIMITS = Object.freeze([
  { parameter: 'maxAutonomousDiscountRate', fields: ['discount_rate'] },
  { parameter: 'maxAutonomousRefundAmount', fields: ['refund_amount', 'refund_amount_twd'] },
  { parameter: 'maxAutonomousAudienceSize', fields: ['audience_size'] },
  { parameter: 'maxAutonomousReminderCount', fields: ['reminder_count'] },
] as const);

/** Builds a terminal refusal. */
function deny(ruleId: PolicyRuleId, errorCode: PolicyDenyCode, reason: string): PolicyDenial {
  return { kind: 'DENY', ruleId, errorCode, reason };
}

/**
 * Reads the first present member of a payload.
 *
 * @param payload - Proposal payload.
 * @param candidates - Member names to try, in order.
 * @returns `ABSENT` when no member is present (a member set to `undefined` is absent), otherwise the
 *   raw value.
 */
function readMember(
  payload: Record<string, unknown>,
  candidates: readonly string[],
): FieldRead<unknown> {
  for (const name of candidates) {
    if (Object.hasOwn(payload, name)) {
      const value = payload[name];

      return value === undefined ? { state: 'ABSENT' } : { state: 'VALID', value };
    }
  }

  return { state: 'ABSENT' };
}

/** Reads a payload member that must be a non-empty string. */
function readStringField(
  payload: Record<string, unknown>,
  candidates: readonly string[],
): FieldRead<string> {
  const member = readMember(payload, candidates);

  if (member.state !== 'VALID') {
    return member;
  }

  return typeof member.value === 'string' && member.value.trim().length > 0
    ? { state: 'VALID', value: member.value.trim() }
    : { state: 'INVALID' };
}

/** Reads a payload member that must be a finite number. */
function readNumberField(
  payload: Record<string, unknown>,
  candidates: readonly string[],
): FieldRead<number> {
  const member = readMember(payload, candidates);

  if (member.state !== 'VALID') {
    return member;
  }

  return typeof member.value === 'number' && Number.isFinite(member.value)
    ? { state: 'VALID', value: member.value }
    : { state: 'INVALID' };
}

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
    };

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
      ...initial,
      payload_sha256,
      effect_key: stringValue(proposal.payload, EFFECT_KEY_FIELDS),
    };

    const binding = this.checkBinding(context, proposal);
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
    const agent = agent_id.length === 0 ? undefined : this.registry.getAgent(agent_id);

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

    const route = verdict.verdict === 'AWAITING_HUMAN_APPROVAL'
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
      reason: `AUTHORIZED: ${String(facts.granted)} covers ${String(facts.requirement)} for `
        + `${skill.skill_id}; the orchestrator may reserve the effect and dispatch.`,
    });
  }

  /**
   * Refuses any payload-asserted identity and any direct agent-to-agent target. Trusted identity
   * arrives only through `PolicySecurityContext`; a payload that names a tenant or customer can
   * neither widen nor replace it (SRS §19, NFR-006, BR-003).
   *
   * @param context - Server-bound context.
   * @param proposal - Proposal whose payload may carry assertions.
   * @returns A refusal, or `null` when the payload asserts nothing contradictory.
   */
  private checkBinding(
    context: PolicySecurityContext,
    proposal: PolicyActionProposal,
  ): PolicyDenial | null {
    const tenantAssertion = readStringField(proposal.payload, TENANT_ASSERTION_FIELDS);

    if (
      tenantAssertion.state === 'INVALID'
      || (tenantAssertion.state === 'VALID' && tenantAssertion.value !== context.tenant_id.trim())
    ) {
      return deny(
        'PEP-BINDING',
        'CROSS_TENANT_ASSERTION',
        'CROSS_TENANT_ASSERTION: the payload asserts a tenant that is not the bound tenant; the '
          + 'server-resolved binding is the only identity and never a payload value (NFR-006).',
      );
    }

    const customerAssertion = readStringField(proposal.payload, CUSTOMER_ASSERTION_FIELDS);

    if (customerAssertion.state !== 'ABSENT') {
      const bound = context.verified_customer_id?.trim() ?? '';

      if (customerAssertion.state === 'INVALID' || customerAssertion.value !== bound) {
        return deny(
          'PEP-BINDING',
          'CROSS_CUSTOMER_ASSERTION',
          'CROSS_CUSTOMER_ASSERTION: the payload asserts a customer the session is not '
            + 'server-verified as; a claimed identifier or flag is never an identity (BR-003, '
            + 'NFR-006).',
        );
      }
    }

    const target = proposal.target_agent_id?.trim()
      ?? stringValue(proposal.payload, TARGET_AGENT_FIELDS)
      ?? '';

    if (
      target.length > 0
      && target !== context.agent_id.trim()
      && this.registry.getAgent(target) !== undefined
    ) {
      return deny(
        'PEP-TOPOLOGY',
        'AGENT_TO_AGENT_FORBIDDEN',
        `AGENT_TO_AGENT_FORBIDDEN: '${target}' is a registered peer agent and peer invocation is a `
          + 'topology violation; routing belongs to the supervisor (`02` §2).',
      );
    }

    return null;
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
      const priced = await this.checkPrice({
        tenant_id,
        skill_id: skill.skill_id,
        payload: proposal.payload,
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

    return this.checkAutonomyLimits({ tenant_id, payload: proposal.payload });
  }

  /**
   * Applies BR-001..BR-003 to a price-bearing action: the price must be traceable to an
   * authenticated catalog reference that resolves in the System of Record, the floor decision must
   * be owner-approved and provenance-bearing, and the effective price must respect that floor.
   *
   * @param params - Bound tenant, skill id and payload.
   * @returns A refusal, or `null` when the price intent is fully traceable and within the floor.
   */
  private async checkPrice(params: {
    readonly tenant_id: string;
    readonly skill_id: string;
    readonly payload: Record<string, unknown>;
  }): Promise<PolicyDenial | null> {
    const reference = readStringField(params.payload, CATALOG_REFERENCE_FIELDS);

    if (reference.state !== 'VALID') {
      return deny(
        'BR-001',
        'ERR_ARBITRARY_PRICING',
        `ERR_ARBITRARY_PRICING: price-bearing skill ${params.skill_id} carries no usable catalog `
          + 'reference id, and a price that is not traceable to the catalog is never invented '
          + '(BR-001, SRS §13).',
      );
    }

    if (this.authoritativeSource === undefined) {
      return deny(
        'BR-003',
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'AUTHORITATIVE_SOURCE_UNAVAILABLE: no System-of-Record reader is injected, so the catalog '
          + 'reference cannot be authenticated and the price is refused rather than assumed '
          + '(BR-003).',
      );
    }

    let record: AuthoritativeCatalogRecord | undefined;

    try {
      record = await this.authoritativeSource.resolveCatalogReference({
        tenant_id: params.tenant_id,
        catalog_ref_id: reference.value,
      });
    } catch {
      return deny(
        'BR-003',
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'AUTHORITATIVE_SOURCE_UNAVAILABLE: the System of Record could not be reached, so no price '
          + 'or stock may be claimed and no cached value may stand in for it (BR-003, NFR-008).',
      );
    }

    if (record === undefined || record.catalog_ref_id !== reference.value) {
      return deny(
        'BR-001',
        'ERR_ARBITRARY_PRICING',
        `ERR_ARBITRARY_PRICING: catalog reference '${reference.value}' does not resolve in the `
          + 'System of Record; a well-formed but unknown reference is treated exactly like a '
          + 'missing one (BR-001).',
      );
    }

    if (this.priceFloor === undefined) {
      return deny(
        'BR-001',
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: no owner-approved floor source is available for `
          + `${reference.value}, and a price-bearing action never dispatches without a floor `
          + 'decision (BR-001, §7.3).',
      );
    }

    let floor: FloorDecision | undefined;

    try {
      floor = await this.priceFloor.getFloorDecision({
        tenant_id: params.tenant_id,
        catalog_ref_id: reference.value,
      });
    } catch {
      floor = undefined;
    }

    if (
      floor === undefined
      || floor.owner_approved !== true
      || floor.floor_source.trim().length === 0
      || !Number.isFinite(floor.floor_price)
    ) {
      return deny(
        'BR-001',
        'P_FLOOR_UNAVAILABLE',
        `P_FLOOR_UNAVAILABLE: the floor decision for ${reference.value} is missing, unapproved or `
          + 'carries no provenance; an owner decision is required and no local computation or '
          + 'approval can substitute for it (BR-001, §7.3).',
      );
    }

    const effective = readNumberField(params.payload, EFFECTIVE_PRICE_FIELDS);

    if (effective.state === 'INVALID') {
      return deny(
        'BR-002',
        'POLICY_INPUT_INVALID',
        'POLICY_INPUT_INVALID: the effective price must be a finite number; a malformed price is '
          + 'never rounded, defaulted or dropped from the floor check (BR-002).',
      );
    }

    if (effective.state === 'VALID' && effective.value < floor.floor_price) {
      return deny(
        'BR-002',
        'ERR_FLOOR_PRICE_VIOLATION',
        `ERR_FLOOR_PRICE_VIOLATION: the effective price ${effective.value} is below the approved `
          + `floor ${floor.floor_price} for ${reference.value}; the floor is immutable and human `
          + 'approval cannot waive it (BR-002).',
      );
    }

    return null;
  }

  /**
   * Applies BR-007 to the payload's governed members: an action above an approved autonomy limit
   * routes to the approval gate, and an action whose governing limit the owner has not approved
   * routes there too — an unset limit is not "unlimited" (implement/08 §1.1, §7.3).
   *
   * @param params - Bound tenant and the payload carrying the governed members.
   * @returns An approval route request, or `null` when every present governed member is within an
   *   approved limit.
   */
  private checkAutonomyLimits(params: {
    readonly tenant_id: string;
    readonly payload: Record<string, unknown>;
  }): ApprovalRouteRequest | null {
    const parameters = this.tenantPolicy?.get(params.tenant_id);

    for (const limit of AUTONOMY_LIMITS) {
      const governed = readNumberField(params.payload, limit.fields);

      if (governed.state === 'ABSENT') {
        continue;
      }

      if (governed.state === 'INVALID') {
        return {
          kind: 'ROUTE',
          decisionCode: 'REQUIRE_HUMAN_APPROVAL',
          ruleId: 'BR-007',
          reason: `REQUIRE_HUMAN_APPROVAL: the governed member ${limit.fields[0]} is present but not `
            + 'a finite number, so no autonomy limit can bound the action; it is routed to a human '
            + 'instead of being interpreted or defaulted (BR-007, NFR-008).',
        };
      }

      const approved = parameters?.[limit.parameter];

      if (approved === undefined || !Number.isFinite(approved)) {
        return {
          kind: 'ROUTE',
          decisionCode: 'REQUIRE_HUMAN_APPROVAL',
          ruleId: 'BR-007',
          reason: `REQUIRE_HUMAN_APPROVAL: the tenant has approved no ${limit.parameter} value, and `
            + 'an unset autonomy limit is not unlimited — the action is routed to the approval gate '
            + 'rather than executed (BR-007, NFR-008).',
        };
      }

      if (governed.value > approved) {
        return {
          kind: 'ROUTE',
          decisionCode: 'LIMIT_EXCEEDED',
          ruleId: 'BR-007',
          reason: `LIMIT_EXCEEDED: ${limit.fields[0]}=${governed.value} exceeds the approved `
            + `${limit.parameter}=${approved}; the action is prepared for human approval instead of `
            + 'being executed autonomously (BR-007).',
        };
      }
    }

    return null;
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
   * Applies the durability half of one outcome: the single pending approval row of a route, then the
   * audit intent, both fail-closed.
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
    let effective = outcome;
    let approvalTicketId: string | null = null;

    if (outcome.kind === 'ROUTE') {
      const queued = await this.createPendingApproval(base, outcome);

      if (queued.kind === 'DENY') {
        effective = queued;
      } else {
        approvalTicketId = queued.approval_id;
      }
    }

    const provisional = this.buildDecision(base, authority, effective, approvalTicketId, 'NOT_APPLICABLE');
    const auditStatus = await this.appendAudit(provisional);

    if (effective.kind !== 'DENY' && auditStatus === 'FAILED') {
      return this.buildDecision(
        base,
        authority,
        deny(
          'BR-010',
          'AUDIT_UNAVAILABLE',
          'AUDIT_UNAVAILABLE: the decision intent could not be persisted, so the permit and any '
            + 'queue row it implies are withheld — audit failure blocks dispatch, it is never a '
            + 'logging warning (BR-010, NFR-002).',
        ),
        null,
        'FAILED',
      );
    }

    return { ...provisional, auditStatus };
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

/**
 * Reads the first usable string member of a payload, or `null`.
 *
 * @param payload - Proposal payload.
 * @param candidates - Member names to try, in order.
 * @returns The trimmed value, or `null` when no member carries a usable string.
 */
function stringValue(payload: Record<string, unknown>, candidates: readonly string[]): string | null {
  const read = readStringField(payload, candidates);

  return read.state === 'VALID' ? read.value : null;
}

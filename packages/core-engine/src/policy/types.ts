/**
 * @file Public policy contracts shared by the enforcement façade and its pure helpers.
 *
 * The PolicyEnforcementPoint façade re-exports these declarations to preserve the existing public
 * module surface while keeping runtime policy helpers type-only dependent on the contracts.
 */

import type {
  AssignableAuthority,
  AuthorityLevel,
  AuthorityVerdict,
  EpistemicClassification,
  EpistemicWriteTarget,
} from '../contracts/index.js';
import type { AutonomyAdmissionPort } from '../autonomy/types.js';

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
  | 'APPROVAL_QUEUE_UNAVAILABLE'
  /** A claimed AUTH-4 binding was supplied for a non-route or cannot be reused safely. */
  | 'APPROVAL_BINDING_INVALID';

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
  /** Human-readable refusal/authorization explanation. */
  readonly reason: string;
  /** Optional workflow admission; it can annotate a final decision but never replace its verdict. */
  readonly autonomyWorkflow?: 'UNCHANGED' | 'AUTO_EXECUTE' | 'PARKED_DRAFT';
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
  /** Deterministic effect key from proposal payload (BR-005); null for non-mutating actions without one. */
  readonly effectKey: string | null;
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
  /** Server policy version used by the optional controlled-autonomy admission port. */
  readonly policy_version?: string;
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
   * @param tenant_id - Tenant binding for tenant-scoped authority registries and caches.
   * @returns The registry row, or `undefined` when the agent is not registered.
   */
  getAgent(agent_id: string, tenant_id?: string): PolicyRegistryAgent | undefined;
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
  /** Deterministic effect key from proposal payload (BR-005); null for non-mutating actions without one. */
  readonly effect_key: string | null;
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
  /** Durable claim for this exact AUTH-4 action; never a clearance or a general permit. */
  readonly approval_id?: string;
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
  /** Optional durable autonomy admission; absent preserves every existing PEP path. */
  readonly autonomy?: AutonomyAdmissionPort;
  /** Injected clock, so a decision is reproducible in a test. */
  readonly now?: () => Date;
}

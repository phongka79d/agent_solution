/**
 * @file Cross-domain orchestration contract (implement/04 §8, implement/05 §2414, plans/customer-lifecycle.md §3).
 *
 * The Revenue Orchestrator is the ONLY broker of a handoff between domains. An agent never calls,
 * messages or addresses another agent: a run declares a `HandoffIntent` on its plan, and the
 * orchestrator — after that run has completed — builds a `CrossDomainHandoffPackage` and hands it
 * to an injected `ICrossDomainHandoffBroker`. The broker admits a NEW durable run for the target
 * domain through the same reservation + durable-task admission the platform already uses for an
 * inbound turn; there is no second queue, orchestrator, approval or effect system behind it.
 *
 * The canonical lifecycle is `marketing → sales → care → retention`, with `retention` terminal,
 * and the journey never exceeds `MAX_HANDOFF_HOPS` hops. `care` and `retention` both run on the
 * existing Customer Care (`support`) module: the journey domain names the leg of the journey, the
 * module names the worker binding, and `JOURNEY_DOMAIN_MODULES` is the only place the two meet.
 *
 * Two rules are total and dependency-free, so they can wrap every handoff path without a model, a
 * database handle or a clock:
 *
 *  * **No promotion.** A package's classification is DERIVED from the evidence it carries
 *    (`deriveHandoffClassification`), never supplied by a caller. `SIGNAL` and `HYPOTHESIS`
 *    content can therefore never be relabelled `FACT`, and a package that carries no `FACT`
 *    evidence can never claim one (FR-C360-003).
 *  * **No escalation.** A handoff routes work; it never widens it. The edge must exist, the target
 *    agent must be the one the edge names, and the source run must already have held the edge's
 *    minimum authority. `AUTH-4` and `AUTH-5` are never granted, raised or bypassed here.
 *
 * Provenance of `FACT` evidence is deliberately NOT decided here: this module proves the shape and
 * the classification rule, and the durable admission boundary re-checks every `FACT` reference
 * against the persisted evidence rows of the source run. A caller-asserted fact therefore has no
 * path to a stored handoff, and a client-supplied payload can never manufacture one.
 */

import { createHash, randomUUID } from 'node:crypto';

import { canonicalizeJson } from '../effects/canonical-json.js';
import {
  AUTHORITY_RANK,
  OrchestratorError,
  type AssignableAuthority,
  type AuthorityLevel,
  type EpistemicClassification,
  type PlatformAgentId,
} from './types.js';

/** The four legs of the canonical journey. `retention` is terminal. */
export type JourneyDomain = 'marketing' | 'sales' | 'care' | 'retention';

/** Every journey domain, in canonical order. */
export const JOURNEY_DOMAINS: readonly JourneyDomain[] = Object.freeze([
  'marketing',
  'sales',
  'care',
  'retention',
]);

/**
 * The longest legal journey: `marketing → sales → care → retention` is three handoffs. A fourth
 * is a loop that has come back around, not a longer journey.
 */
export const MAX_HANDOFF_HOPS = 3;

/**
 * The worker module that hosts each journey domain. `retention` is a leg of the journey carried by
 * the existing Customer Care module — no fourth worker module exists, and `VALID_AGENT_MODULES` is
 * unchanged.
 */
export const JOURNEY_DOMAIN_MODULES: Readonly<Record<JourneyDomain, string>> = Object.freeze({
  marketing: 'marketing',
  sales: 'sales',
  care: 'support',
  retention: 'support',
});

/** Where a customer stands in the journey, as the durable handoff ledger records it. */
export type JourneyLifecycleState = 'ENTERED' | 'IN_PROGRESS' | 'HANDED_OFF' | 'COMPLETED';

/**
 * One evidence reference carried by a handoff package.
 *
 * Every field is required and non-empty: a reference that cannot name its claim, its source, its
 * version and its verifier is not evidence. Classifying a reference `FACT` asserts that an
 * authoritative source produced it — the durable admission boundary re-reads the source run's
 * persisted evidence rows and refuses the handoff when that assertion is untrue.
 */
export interface HandoffEvidenceRef {
  readonly classification: EpistemicClassification;
  readonly claim: string;
  readonly source_uri: string;
  readonly source_version: string;
  readonly verified_by: string;
}

/** The durable journey cursor a package advances: a monotonic version plus the state it left. */
export interface HandoffLifecycleRef {
  readonly version: number;
  readonly state: JourneyLifecycleState;
}

/**
 * The next leg a completed run asks the orchestrator to broker.
 *
 * An intent is a request, never an admission: the orchestrator builds the package, and the broker
 * and the durable ledger decide whether the handoff exists. `source_domain` names the leg the run
 * itself executed, and the orchestrator refuses an intent whose declared leg the run's own steps
 * do not corroborate — a run cannot claim to be a domain it did not act in.
 */
export interface HandoffIntent {
  readonly source_domain: JourneyDomain;
  readonly target_domain: JourneyDomain;
  readonly target_agent: PlatformAgentId;
  readonly reason: string;
}

/** The agent-id families each journey leg may act with. `care` and `retention` share Care agents. */
export const JOURNEY_DOMAIN_AGENT_PREFIXES: Readonly<Record<JourneyDomain, readonly string[]>> =
  Object.freeze({
    marketing: Object.freeze(['MKT-']),
    sales: Object.freeze(['SAL-']),
    care: Object.freeze(['CS-']),
    retention: Object.freeze(['CS-']),
  });

/**
 * Corroborates a handoff intent's declared leg against the steps the run actually planned.
 *
 * A run may only hand off as the domain it acted in: a Sales plan cannot declare itself marketing
 * to reach an edge it otherwise could not, and a Care plan cannot declare itself retention to skip
 * the handoff that opens that leg.
 *
 * @param source_domain The leg the intent declares.
 * @param agent_ids The agents of the run's own plan steps.
 * @throws OrchestratorError `HANDOFF_PACKAGE_INVALID` when no step corroborates the declared leg.
 */
export function assertHandoffSourceDomain(
  source_domain: JourneyDomain,
  agent_ids: readonly PlatformAgentId[],
): void {
  const prefixes = JOURNEY_DOMAIN_AGENT_PREFIXES[source_domain];
  const corroborating = agent_ids.filter((agent_id) =>
    prefixes.some((prefix) => agent_id.startsWith(prefix)),
  );

  if (agent_ids.length === 0 || corroborating.length !== agent_ids.length) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      `A run handing off as '${source_domain}' must have acted only through `
        + `${prefixes.join('/')} agents; its plan names `
        + `${agent_ids.length === 0 ? 'none' : agent_ids.join(', ')}, which does not corroborate `
        + 'the declared leg of the journey.',
    );
  }
}

/** One legal edge of the journey, with the entry agent and the authority the source must hold. */
export interface HandoffEdge {
  readonly target: JourneyDomain;
  readonly allowed_agents: readonly PlatformAgentId[];
  readonly minimum_source_authority: AssignableAuthority;
}

/**
 * The journey graph. Each edge names exactly one canonical entry agent for the target domain: the
 * target domain's own runtime may still plan its other agents internally, but the brokered entry
 * point is fixed, so an agent can neither choose its successor nor widen its own mandate.
 */
export const HANDOFF_DOMAIN_EDGES: Readonly<Record<JourneyDomain, readonly HandoffEdge[]>> =
  Object.freeze({
    marketing: Object.freeze([
      Object.freeze({
        target: 'sales' as JourneyDomain,
        allowed_agents: Object.freeze(['SAL-02'] as const),
        minimum_source_authority: 'AUTH-1' as AssignableAuthority,
      }),
    ]),
    sales: Object.freeze([
      Object.freeze({
        target: 'care' as JourneyDomain,
        allowed_agents: Object.freeze(['CS-01'] as const),
        minimum_source_authority: 'AUTH-1' as AssignableAuthority,
      }),
    ]),
    care: Object.freeze([
      Object.freeze({
        target: 'retention' as JourneyDomain,
        allowed_agents: Object.freeze(['CS-02'] as const),
        minimum_source_authority: 'AUTH-1' as AssignableAuthority,
      }),
    ]),
    retention: Object.freeze([]),
  });

/**
 * The full Orchestrator Context Handoff Package (plans/customer-lifecycle.md §3), as accepted by
 * the broker. Identity is `(tenant_id, customer_id)`: the customer is the server-resolved verified
 * subject of the source run, never an identifier the inbound payload asserted.
 */
export interface CrossDomainHandoffPackage {
  readonly handoff_id: string;
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly correlation_id: string;
  readonly source_domain: JourneyDomain;
  readonly source_agent: PlatformAgentId;
  readonly source_run_id: string;
  readonly target_domain: JourneyDomain;
  readonly target_agent: PlatformAgentId;
  readonly reason: string;
  readonly evidence: readonly HandoffEvidenceRef[];
  readonly classification: EpistemicClassification;
  readonly lifecycle: HandoffLifecycleRef;
  readonly idempotency_key: string;
  readonly hop_count: number;
  readonly visited_domains: readonly JourneyDomain[];
  readonly occurred_at: string;
}

/** What the broker reports back: the admitted target run and the lifecycle it advanced to. */
export interface HandoffAdmission {
  readonly handoff_id: string;
  readonly target_run_id: string;
  /** `false` when the idempotency key was already admitted — a replay, never a second run. */
  readonly admitted: boolean;
  readonly lifecycle: HandoffLifecycleRef;
}

/**
 * The durable facts an admission is judged against: who the run is for, where the journey stands,
 * and what authority the source run actually held.
 */
export interface HandoffAdmissionContext {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly lifecycle: HandoffLifecycleRef | null;
  readonly visited_domains: readonly JourneyDomain[];
  readonly previous_hop_count: number;
  readonly source_authority: AuthorityLevel;
}

/**
 * What the ORCHESTRATOR knows about the hop it is brokering: who the run is for, which leg it
 * completed, where it goes, why, on what evidence, and under what authority.
 *
 * The durable half of the package's identity — the lifecycle version, the visited history and the
 * hop count — is deliberately absent. It lives in the handoff ledger, so the broker reads it there
 * inside the admission transaction rather than trusting a caller's snapshot of it, and derives the
 * package (and its idempotency key) from the durable facts it just read.
 */
export interface CrossDomainHandoffDraft {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly correlation_id: string;
  readonly source_domain: JourneyDomain;
  readonly source_agent: PlatformAgentId;
  readonly source_run_id: string;
  /** The authority the source run actually held, as resolved by the platform — never a payload. */
  readonly source_authority: AuthorityLevel;
  readonly target_domain: JourneyDomain;
  readonly target_agent: PlatformAgentId;
  readonly reason: string;
  readonly evidence: readonly HandoffEvidenceRef[];
  readonly occurred_at: string;
}

/** Input of `createCrossDomainHandoffPackage`: the draft plus the durable journey facts. */
export interface CreateCrossDomainHandoffPackageInput extends CrossDomainHandoffDraft {
  readonly previous_lifecycle: HandoffLifecycleRef | null;
  readonly previous_hop_count: number;
  readonly visited_domains: readonly JourneyDomain[];
}

/** Ascending: the highest-ranked classification present in a package's evidence is its own. */
export const EPISTEMIC_HANDOFF_STRENGTH: readonly EpistemicClassification[] = Object.freeze([
  'SIGNAL',
  'HYPOTHESIS',
  'ACTION',
  'DECISION',
  'FACT',
]);

/** The classification vocabulary, for callers that must validate an untrusted string. */
const EPISTEMIC_CLASSIFICATIONS: readonly string[] = Object.freeze([
  'FACT',
  'SIGNAL',
  'HYPOTHESIS',
  'DECISION',
  'ACTION',
]);

/** Highest number of evidence references one package may carry. */
const MAX_HANDOFF_EVIDENCE_REFS = 32;

/** Longest accepted free-text reason; a handoff reason is a sentence, not a document. */
const MAX_HANDOFF_REASON_LENGTH = 1024;

/** @returns `true` when `value` names a journey domain. */
export function isJourneyDomain(value: string): value is JourneyDomain {
  return (JOURNEY_DOMAINS as readonly string[]).includes(value);
}

/** @returns The legal successors of `domain` (empty for the terminal `retention`). */
export function journeyNextDomains(domain: JourneyDomain): readonly JourneyDomain[] {
  return Object.freeze(HANDOFF_DOMAIN_EDGES[domain].map((edge) => edge.target));
}

/**
 * The package's classification, derived from the evidence it carries.
 *
 * This is the anti-promotion rule in executable form: a package can claim `FACT` only by carrying
 * a `FACT` reference, so `SIGNAL` or `HYPOTHESIS` content cannot be relabelled on the way across a
 * domain boundary.
 *
 * @param evidence The references the package carries.
 * @returns The highest-ranked classification present.
 * @throws OrchestratorError `HANDOFF_EVIDENCE_INVALID` when no evidence is carried.
 */
export function deriveHandoffClassification(
  evidence: readonly HandoffEvidenceRef[],
): EpistemicClassification {
  if (evidence.length === 0) {
    throw new OrchestratorError(
      'HANDOFF_EVIDENCE_INVALID',
      'A handoff package must carry at least one evidence reference; a handoff without evidence '
        + 'is an assertion, and the platform does not route assertions (BR-010).',
    );
  }

  let derived: EpistemicClassification = 'SIGNAL';
  let derivedRank = EPISTEMIC_HANDOFF_STRENGTH.indexOf('SIGNAL');

  for (const ref of evidence) {
    const rank = EPISTEMIC_HANDOFF_STRENGTH.indexOf(ref.classification);
    if (rank > derivedRank) {
      derived = ref.classification;
      derivedRank = rank;
    }
  }

  return derived;
}

/**
 * The deterministic idempotency identity of one handoff (§3.2.3 discipline applied to a handoff).
 *
 * The canonical object is built field by field from server-derived identity only: no timestamp, no
 * random id and no caller-supplied property can reach the digest, so a replayed admission of the
 * same hop reproduces the same key and is answered from the ledger rather than admitted twice.
 *
 * @param input The bound identity fields of the hop.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function computeHandoffIdempotencyKey(input: {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly source_run_id: string;
  readonly target_domain: JourneyDomain;
  readonly target_agent: PlatformAgentId;
  readonly lifecycle_version: number;
  readonly reason: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        tenant_id: input.tenant_id,
        customer_id: input.customer_id,
        source_run_id: input.source_run_id,
        target_domain: input.target_domain,
        target_agent: input.target_agent,
        lifecycle_version: input.lifecycle_version,
        reason: input.reason,
      }),
    )
    .digest('hex');
}

/**
 * Builds the package for one hop, deriving every identity field rather than accepting it.
 *
 * The caller supplies what the hop IS — who it is for, where it comes from, where it goes, why and
 * on what evidence. The package's `handoff_id`, `idempotency_key`, `hop_count`, `visited_domains`,
 * `lifecycle` and `classification` are computed here, so no caller can mint a package that skips a
 * hop, rewinds a version or promotes its own evidence.
 *
 * @param input The substance of the hop.
 * @returns The complete, self-consistent package.
 */
export function createCrossDomainHandoffPackage(
  input: CreateCrossDomainHandoffPackageInput,
): CrossDomainHandoffPackage {
  const classification = deriveHandoffClassification(input.evidence);
  const lifecycle: HandoffLifecycleRef = Object.freeze({
    version: (input.previous_lifecycle?.version ?? 0) + 1,
    state: 'HANDED_OFF' as JourneyLifecycleState,
  });
  const visited_domains = Object.freeze([...input.visited_domains, input.source_domain]);

  return Object.freeze({
    handoff_id: randomUUID(),
    tenant_id: input.tenant_id,
    customer_id: input.customer_id,
    correlation_id: input.correlation_id,
    source_domain: input.source_domain,
    source_agent: input.source_agent,
    source_run_id: input.source_run_id,
    target_domain: input.target_domain,
    target_agent: input.target_agent,
    reason: input.reason,
    evidence: Object.freeze([...input.evidence]),
    classification,
    lifecycle,
    idempotency_key: computeHandoffIdempotencyKey({
      tenant_id: input.tenant_id,
      customer_id: input.customer_id,
      source_run_id: input.source_run_id,
      target_domain: input.target_domain,
      target_agent: input.target_agent,
      lifecycle_version: lifecycle.version,
      reason: input.reason,
    }),
    hop_count: input.previous_hop_count + 1,
    visited_domains,
    occurred_at: input.occurred_at,
  });
}

/** Rank of any authority level, including the two that are never assignable. */
function authorityRank(level: AuthorityLevel): number {
  return Object.hasOwn(AUTHORITY_RANK, level)
    ? AUTHORITY_RANK[level as AssignableAuthority]
    : level === 'AUTH-4'
      ? 4
      : 5;
}

/**
 * The highest authority actually exercised among a set of levels.
 *
 * A handoff is judged against what the source run really held, so this reads the run's own steps
 * rather than a caller's claim; `AUTH-4` and `AUTH-5` rank above every clearance and are never
 * raised, granted or downgraded by this function.
 *
 * @param levels The authority levels required by the run's own steps.
 * @returns The highest-ranked level, or `AUTH-0` for an empty set.
 */
export function highestAuthority(levels: readonly AuthorityLevel[]): AuthorityLevel {
  return levels.reduce<AuthorityLevel>(
    (highest, level) => (authorityRank(level) > authorityRank(highest) ? level : highest),
    'AUTH-0',
  );
}

/**
 * Whether a value is a canonical ISO-8601 UTC instant.
 *
 * `Date.parse` alone is not enough: it accepts `2026-09-26`, `2026-09-26T10:00` and free-form
 * variants, none of which keep a durable ordering key comparable. The instant must round-trip.
 */
function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** @throws OrchestratorError `HANDOFF_PACKAGE_INVALID` when `value` is not a usable free-text field. */
function assertText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      `Handoff package field '${field}' must be a non-empty string of at most ${maxLength} `
        + 'characters (plans/customer-lifecycle.md §3).',
    );
  }

  return value;
}

/** @throws OrchestratorError `HANDOFF_EVIDENCE_INVALID` when the evidence reference is unusable. */
function assertEvidenceRefShape(ref: unknown, index: number): void {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    throw new OrchestratorError(
      'HANDOFF_EVIDENCE_INVALID',
      `Evidence reference ${index} is not an object; a reference names a classification, a claim, `
        + 'its source, its version and its verifier (implement/04 §1.1).',
    );
  }

  const candidate = ref as HandoffEvidenceRef;

  if (!EPISTEMIC_CLASSIFICATIONS.includes(candidate.classification)) {
    throw new OrchestratorError(
      'HANDOFF_EVIDENCE_INVALID',
      `Evidence reference ${index} carries unknown classification '${String(candidate.classification)}'; `
        + 'the vocabulary is FACT, SIGNAL, HYPOTHESIS, DECISION, ACTION (implement/04 §1.1).',
    );
  }

  assertText(candidate.claim, `evidence[${index}].claim`, 2048);
  assertText(candidate.source_uri, `evidence[${index}].source_uri`, 255);
  assertText(candidate.source_version, `evidence[${index}].source_version`, 64);
  assertText(candidate.verified_by, `evidence[${index}].verified_by`, 128);
}

/**
 * Admits or refuses one handoff, against the durable facts of the journey.
 *
 * The rules are the safety contract of §6 and §3: no cross-tenant routing, no cross-customer
 * routing, no stale replay, no repeated hop, no journey beyond `MAX_HANDOFF_HOPS`, no authority
 * escalation and no promoted classification. Refusal codes are stable and each names the rule.
 *
 * @param pkg The package the orchestrator built.
 * @param ctx The durable facts the admission is judged against.
 * @throws OrchestratorError `HANDOFF_PACKAGE_INVALID` when the package is not self-consistent.
 * @throws OrchestratorError `HANDOFF_TENANT_MISMATCH` when the package leaves its tenant.
 * @throws OrchestratorError `HANDOFF_CUSTOMER_MISMATCH` when the package leaves its customer.
 * @throws OrchestratorError `HANDOFF_DOMAIN_EDGE_REJECTED` when the edge is not a journey edge.
 * @throws OrchestratorError `HANDOFF_AUTHORITY_ESCALATION` when the target agent or the source
 *   authority is outside the edge's mandate.
 * @throws OrchestratorError `HANDOFF_LOOP_REJECTED` when the hop count or the visited set says
 *   the journey is going in circles.
 * @throws OrchestratorError `HANDOFF_STALE_REPLAY` when the package belongs to a superseded or
 *   already-finished lifecycle.
 * @throws OrchestratorError `HANDOFF_EVIDENCE_INVALID` when the evidence cannot support the
 *   classification the package carries.
 */
export function assertHandoffAdmissible(
  pkg: CrossDomainHandoffPackage,
  ctx: HandoffAdmissionContext,
): void {
  // 1. The package must be self-consistent before anything is compared to it.
  assertText(pkg.handoff_id, 'handoff_id', 128);
  assertText(pkg.correlation_id, 'correlation_id', 128);
  assertText(pkg.source_run_id, 'source_run_id', 128);
  assertText(pkg.reason, 'reason', MAX_HANDOFF_REASON_LENGTH);

  if (!isJourneyDomain(pkg.source_domain) || !isJourneyDomain(pkg.target_domain)) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'Both source_domain and target_domain must be journey domains '
        + `(marketing, sales, care, retention); received '${String(pkg.source_domain)}' → `
        + `'${String(pkg.target_domain)}'.`,
    );
  }

  if (typeof pkg.occurred_at !== 'string' || !isCanonicalInstant(pkg.occurred_at)) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'occurred_at must be an ISO-8601 instant so the handoff keeps a comparable durable '
        + 'position on the Customer 360 timeline.',
    );
  }

  // The package may arrive from durable storage, so its shape is validated before any field is
  // dereferenced: malformed input is refused with these codes, never with a raw TypeError.
  const lifecycle: unknown = pkg.lifecycle;
  if (typeof lifecycle !== 'object' || lifecycle === null || Array.isArray(lifecycle)) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'lifecycle must be an object carrying the journey version and state.',
    );
  }
  const { version, state } = lifecycle as { version?: unknown; state?: unknown };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'lifecycle.version must be a positive integer; a handoff always advances the journey by '
        + 'exactly one version.',
    );
  }
  if (
    state !== 'ENTERED'
    && state !== 'IN_PROGRESS'
    && state !== 'HANDED_OFF'
    && state !== 'COMPLETED'
  ) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      `lifecycle.state '${String(state)}' is not a journey state (ENTERED, IN_PROGRESS, `
        + 'HANDED_OFF, COMPLETED).',
    );
  }

  if (!Array.isArray(pkg.visited_domains) || !Array.isArray(pkg.evidence)) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'visited_domains and evidence must both be arrays.',
    );
  }

  if (
    pkg.visited_domains.length === 0
    || !pkg.visited_domains.includes(pkg.source_domain)
    || pkg.hop_count !== pkg.visited_domains.length
  ) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'visited_domains must contain the source domain and its length must equal hop_count, so the '
        + 'journey cannot be renumbered by its sender.',
    );
  }

  const evidence = Array.isArray(pkg.evidence) ? pkg.evidence : [];
  if (evidence.length === 0 || evidence.length > MAX_HANDOFF_EVIDENCE_REFS) {
    throw new OrchestratorError(
      'HANDOFF_EVIDENCE_INVALID',
      `A handoff must carry between 1 and ${MAX_HANDOFF_EVIDENCE_REFS} evidence references; `
        + `received ${evidence.length}.`,
    );
  }

  evidence.forEach((ref, index) => assertEvidenceRefShape(ref, index));

  if (pkg.classification !== deriveHandoffClassification(evidence)) {
    throw new OrchestratorError(
      'HANDOFF_EVIDENCE_INVALID',
      `Package classification '${String(pkg.classification)}' is not the classification its own `
        + `evidence supports ('${deriveHandoffClassification(evidence)}'); a SIGNAL or HYPOTHESIS `
        + 'is never promoted to FACT on the way across a domain boundary (FR-C360-003).',
    );
  }

  if (
    pkg.idempotency_key
    !== computeHandoffIdempotencyKey({
      tenant_id: pkg.tenant_id,
      customer_id: pkg.customer_id,
      source_run_id: pkg.source_run_id,
      target_domain: pkg.target_domain,
      target_agent: pkg.target_agent,
      lifecycle_version: pkg.lifecycle.version,
      reason: pkg.reason,
    })
  ) {
    throw new OrchestratorError(
      'HANDOFF_PACKAGE_INVALID',
      'idempotency_key is not the digest of this package\'s own identity; a handoff key is '
        + 'derived, never supplied.',
    );
  }

  // 2. Tenant, then customer: data of one tenant never appears in another tenant's journey.
  if (pkg.tenant_id !== ctx.tenant_id) {
    throw new OrchestratorError(
      'HANDOFF_TENANT_MISMATCH',
      'A handoff never crosses a tenant boundary (NFR-006); the package tenant and the '
        + 'lease-bound tenant must be the same.',
    );
  }

  if (
    typeof pkg.customer_id !== 'string'
    || pkg.customer_id.trim().length === 0
    || pkg.customer_id !== ctx.customer_id
  ) {
    throw new OrchestratorError(
      'HANDOFF_CUSTOMER_MISMATCH',
      'A handoff is addressed to the verified subject of the source run and to no one else; an '
        + 'absent or different customer_id is refused rather than re-routed (NFR-006).',
    );
  }

  // 3. The edge, and the mandate the edge carries.
  const edge = HANDOFF_DOMAIN_EDGES[pkg.source_domain].find(
    (candidate) => candidate.target === pkg.target_domain,
  );
  if (edge === undefined) {
    throw new OrchestratorError(
      'HANDOFF_DOMAIN_EDGE_REJECTED',
      `There is no journey edge ${pkg.source_domain} → ${pkg.target_domain}; the canonical `
        + 'lifecycle is marketing → sales → care → retention (plans/customer-lifecycle.md §3).',
    );
  }

  if (!edge.allowed_agents.includes(pkg.target_agent)) {
    throw new OrchestratorError(
      'HANDOFF_AUTHORITY_ESCALATION',
      `Agent '${pkg.target_agent}' is not the entry agent of the ${pkg.source_domain} → `
        + `${pkg.target_domain} edge (${edge.allowed_agents.join(', ')}); a handoff never chooses `
        + 'its own successor or widens its mandate (BR-008).',
    );
  }

  const sourceRank = authorityRank(ctx.source_authority);
  if (
    ctx.source_authority === 'AUTH-5'
    || sourceRank < authorityRank(edge.minimum_source_authority)
  ) {
    throw new OrchestratorError(
      'HANDOFF_AUTHORITY_ESCALATION',
      `Source authority '${ctx.source_authority}' is below the ${edge.minimum_source_authority} `
        + `the ${pkg.source_domain} → ${pkg.target_domain} edge requires; a handoff routes work, `
        + 'it never raises authority (BR-008, AUTH-5 is a hard deny).',
    );
  }

  // 4. The journey must move forward, exactly one hop, never back onto a domain already visited.
  if (
    pkg.visited_domains.includes(pkg.target_domain)
    || pkg.hop_count > MAX_HANDOFF_HOPS
    || pkg.hop_count !== ctx.previous_hop_count + 1
  ) {
    throw new OrchestratorError(
      'HANDOFF_LOOP_REJECTED',
      `Hop ${pkg.hop_count} to '${pkg.target_domain}' is not the next hop of the canonical `
        + `journey (max ${MAX_HANDOFF_HOPS} hops, visited: ${pkg.visited_domains.join(' → ')}); `
        + 'a journey never revisits a domain or exceeds its length.',
    );
  }

  // 5. Stale replay: a superseded version, a finished journey, a leg the journey already left, or
  // a different history.
  if (ctx.lifecycle !== null) {
    const contextHistory = ctx.visited_domains;
    const sharesHistory =
      contextHistory.length < pkg.visited_domains.length
      && contextHistory.every((domain, index) => pkg.visited_domains[index] === domain);

    if (
      pkg.lifecycle.version <= ctx.lifecycle.version
      || ctx.lifecycle.state === 'COMPLETED'
      || contextHistory.includes(pkg.source_domain)
      || !sharesHistory
    ) {
      throw new OrchestratorError(
        'HANDOFF_STALE_REPLAY',
        `Lifecycle version ${pkg.lifecycle.version} does not advance the durable lifecycle `
          + `(version ${ctx.lifecycle.version}, state ${ctx.lifecycle.state}, history `
          + `${contextHistory.join(' → ') || 'none'}, handing off from '${pkg.source_domain}'); a `
          + 'replayed, superseded or already-left leg is refused, and the stored handoff is '
          + 'answered from the ledger instead.',
      );
    }
  }
}

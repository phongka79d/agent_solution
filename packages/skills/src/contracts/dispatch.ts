/**
 * @file The invocation envelope the Revenue Orchestrator submits, the result it receives back, and
 * the adapter seam a row is bound to (implement/05 §1.1, §6.3, §8.1).
 *
 * Agents never call a skill or a tool directly: a request that did not enter through the
 * orchestrator route marker is refused rather than executed.
 */

import type { AuthorityVerdict } from '@agentos/core-engine/contracts';

import type { ExecutionContext, SkillEffectClass } from './types.js';

/**
 * The one value `SkillDispatchRequest.broker` may hold. Agents never call a skill or a tool
 * directly (implement/05 §1.1 invariant 1): the Revenue Orchestrator owns every invocation, and a
 * request that does not arrive through it is refused with `UNBROKERED_INVOCATION`.
 */
export const ORCHESTRATOR_BROKER = 'REVENUE_ORCHESTRATOR';

/** Route marker proving an invocation entered the skill layer through the orchestrator. */
export type OrchestratorBroker = typeof ORCHESTRATOR_BROKER;

/**
 * The invocation envelope the Revenue Orchestrator submits. The fields above `input` are the
 * server-resolved run identity: the skill layer derives the effect key from them rather than
 * trusting a caller-produced value, so a key built from a timestamp or a random UUID can never
 * reach a reservation.
 */
export interface SkillDispatchRequest {
  /** Route marker; anything but `REVENUE_ORCHESTRATOR` is refused with `UNBROKERED_INVOCATION`. */
  readonly broker: OrchestratorBroker;
  readonly skill_id: string;
  readonly run_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly caller_agent: string;
  readonly granted_authority: AssignableAuthorityLike;
  /** Immutable inbound identity (signal, webhook delivery or message id) — never a run id. */
  readonly request_id: string;
  /** Position of the action inside the immutable plan. */
  readonly step_index: number;
  /** Revision of the action; a re-drafted action is a new revision and a new effect identity. */
  readonly action_revision: number;
  /**
   * Optional caller-supplied effect key. When present it must equal the canonical BR-005
   * derivation of this dispatch, otherwise the invocation is refused with
   * `EFFECT_KEY_NOT_DETERMINISTIC`; the engine never adopts a foreign key.
   */
  readonly effect_key?: string;
  readonly approval_id?: string;
  readonly approval_payload_digest?: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

/**
 * The grant slot as it arrives from the orchestrator. Typed as the assignable set, but the runtime
 * treats it as `unknown` so a corrupt or verdict-only value (an `AUTH-4`/`AUTH-5` "grant") is
 * refused with a clearance error instead of being trusted for being well-typed.
 */
type AssignableAuthorityLike = ExecutionContext['granted_authority'];

/** One successful, schema-validated invocation. */
export interface SkillDispatchResult<TOutput = unknown> {
  readonly skill_id: string;
  /** Verdict the authority gate reached: `AUTO_APPROVED`, or `AWAITING_HUMAN_APPROVAL`. */
  readonly verdict: AuthorityVerdict;
  readonly effect_class: SkillEffectClass;
  readonly effect_key: string;
  readonly approval_id?: string;
  readonly output: TOutput;
  /** Attempts consumed inside the declared retry budget, `1` when the first attempt succeeded. */
  readonly attempts: number;
  readonly latency_ms: number;
}

/**
 * The adapter seam a skill row is bound to. Implementing a production connector is the adapter
 * layer's job; a row only names its `tool_binding`, so an unavailable connector is a declared
 * refusal — never a silent substitution and never a cached value (§6.1).
 */
export interface SkillToolInvocation<TInput = unknown> {
  readonly skill_id: string;
  readonly tool_binding: string;
  readonly input: TInput;
  readonly context: ExecutionContext;
}

export interface SkillToolPort {
  invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput>;
}

/** Bindings a skill row needs to be constructed. Both are injected; neither is read from ambient state. */
export interface PlatformSkillDependencies {
  /** Adapter seam the row's `tool_binding` is dispatched through. */
  readonly tools: SkillToolPort;
  /** Injected clock, so a row that stamps a timestamp stays deterministic under test. */
  readonly clock: () => Date;
}

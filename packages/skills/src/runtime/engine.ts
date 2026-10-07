/**
 * @file The skill dispatch pipeline (implement/05 §1.1, §6.3, §8.1).
 *
 * The pipeline is the admission contract in execution order: registry lookup, orchestrator route,
 * server-resolved identity, enablement, authority, schema, approval binding, effect identity,
 * breaker admission, bounded execution, response validation. Every step above the adapter call is
 * pre-side-effect, so a failure in any of them prevents the effect entirely.
 *
 * Two steps of the §6.3 sequence are deliberately absent because another owner holds them:
 * BR/policy evaluation (the Policy Enforcement Point, `04`/`08`) and the durable effect reservation,
 * evidence and audit writes (`04`). This engine derives the effect identity those steps consume — it
 * never reserves, settles or re-dispatches an external effect itself.
 */

import {
  ORCHESTRATOR_BROKER,
  SkillError,
  type ExecutionContext,
  type SkillDispatchRequest,
  type SkillDispatchResult,
  type SkillEngineSeams,
} from '../contracts/index.js';
import type { SkillRegistry } from '../registry.js';
import { validateAgainstSchema } from '../schema/index.js';
import { assertApprovalCoversPayload } from './approval.js';
import { executeBounded } from './attempt.js';
import { enforceAuthorityAdmission } from './authority.js';
import { CircuitBreaker, DEFAULT_FAILURE_THRESHOLD, DEFAULT_RESET_TIMEOUT_MS } from './circuit-breaker.js';
import { resolveDispatchEffectKey } from './effect.js';

/** Everything the pipeline needs; all four canonical primitives and all ambient seams are injected. */
export interface SkillRuntimeOptions extends SkillEngineSeams {
  readonly registry: SkillRegistry;
  /** Injected monotonic-enough clock, used for latency and the breaker window. */
  readonly now?: () => number;
  /** Injected jitter source; never a hidden `Math.random` call. */
  readonly random?: () => number;
  /** Injected breaker factory; the default keeps an independent breaker per `(tenant_id, skill_id)`. */
  readonly breakerFor?: (
    tenant_id: string,
    skill_id: string,
    guarded_dependency?: string,
  ) => CircuitBreaker;
  /** Injected sleep seam for deterministic retry tests; defaults to a timer-backed delay. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The one entry point into skill execution. */
export interface SkillRuntimeEngine {
  /**
   * Dispatches one orchestrator-brokered invocation.
   *
   * @param request The server-resolved dispatch envelope.
   * @returns The validated output plus the verdict, effect identity and attempt count.
   * @throws {SkillError} The most specific fail-closed refusal for the step that refused.
   */
  dispatch<TOutput = unknown>(request: SkillDispatchRequest): Promise<SkillDispatchResult<TOutput>>;
}

/** A field the orchestrator must have resolved server-side before any skill can run. */
function requireResolvedText(value: unknown, field: string, skill_id: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SkillError(
      'MISSING_DISPATCH_CONTEXT',
      `${field} must be the server-resolved value of this run; a skill is never dispatched from a payload assertion`,
      skill_id,
    );
  }
  return value;
}

/** The default delay seam; injectable so a retry budget can be exercised without real waiting. */
function waitFor(ms: number): Promise<void> {
  // `Promise.withResolvers()` is deliberately not used: the api/worker images run Node 20, where the
  // method does not exist (same reasoning as `apps/api/src/server.ts`).
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Builds the skill runtime engine.
 *
 * @param options The registry, the four canonical seams and the ambient seams.
 * @returns An engine that refuses before any side effect rather than guessing.
 */
export function createSkillRuntimeEngine(options: SkillRuntimeOptions): SkillRuntimeEngine {
  const { registry, digestPayload, deriveEffectKey, evaluateAuthority } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? waitFor;

  const breakers = new Map<string, CircuitBreaker>();
  const breakerFor =
    options.breakerFor ??
    ((tenant_id: string, skill_id: string): CircuitBreaker => {
      const key = `${tenant_id}\u0000${skill_id}`;
      const existing = breakers.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = new CircuitBreaker(
        DEFAULT_FAILURE_THRESHOLD,
        DEFAULT_RESET_TIMEOUT_MS,
        now,
      );
      breakers.set(key, created);
      return created;
    });

  return {
    async dispatch<TOutput = unknown>(
      request: SkillDispatchRequest,
    ): Promise<SkillDispatchResult<TOutput>> {
      const startedAt = now();

      // 1. Registry lookup: an unknown id has no fallback row and no cached definition.
      const skill = registry.resolve(request.skill_id);
      const { skill_id } = skill;

      // 2. Route marker: agents never call a skill directly; only the orchestrator does.
      if (request.broker !== ORCHESTRATOR_BROKER) {
        throw new SkillError(
          'UNBROKERED_INVOCATION',
          `the invocation did not arrive through ${ORCHESTRATOR_BROKER}; every skill execution is brokered by the Revenue Orchestrator (§1.1 invariant 1)`,
          skill_id,
        );
      }

      // 3. Server-resolved identity. Nothing here is ever read back from the input.
      const run_id = requireResolvedText(request.run_id, 'run_id', skill_id);
      const tenant_id = requireResolvedText(request.tenant_id, 'tenant_id', skill_id);
      const correlation_id = requireResolvedText(request.correlation_id, 'correlation_id', skill_id);
      const caller_agent = requireResolvedText(request.caller_agent, 'caller_agent', skill_id);

      // 4. Enablement flag stored with the row (§7): a disabled row hands off, it never degrades.
      if (!skill.enabled) {
        throw new SkillError(
          'SKILL_DISABLED',
          'the row is not enabled for this gate; a disabled skill refuses and hands off to a human rather than falling back',
          skill_id,
        );
      }

      // 5. Agent binding, then the canonical verdict. Evaluated before the schema check so an
      //    unauthorized caller receives a verdict rather than target-schema detail.
      const admission = enforceAuthorityAdmission({
        skill_id,
        allowed_agents: skill.allowed_agents,
        required_authority: skill.required_authority,
        caller_agent,
        granted_authority: request.granted_authority,
        evaluateAuthority,
      });

      // 6. Caller-controlled effect identity never enters a skill payload. It belongs to the
      // server-resolved dispatch envelope and the canonical BR-005 derivation below.
      if (
        typeof request.input === 'object' &&
        request.input !== null &&
        !Array.isArray(request.input) &&
        Object.hasOwn(request.input, 'effect_key')
      ) {
        throw new SkillError(
          'EFFECT_KEY_IN_INPUT',
          'effect_key is server-resolved dispatch identity and must not be supplied inside skill input',
          skill_id,
        );
      }

      // 7. Tenant binding is checked against the raw inbound object before normalization. A schema
      // that strips unknown members must not turn a cross-tenant assertion into an absent field.
      const inputRecord =
        typeof request.input === 'object' &&
        request.input !== null &&
        !Array.isArray(request.input)
          ? (request.input as Record<string, unknown>)
          : null;
      if (
        inputRecord !== null &&
        Object.hasOwn(inputRecord, 'tenant_id') &&
        inputRecord['tenant_id'] !== tenant_id
      ) {
        throw new SkillError(
          'CROSS_TENANT_ASSERTION',
          'input tenant_id must equal the server-resolved dispatch tenant; payload assertions never cross tenant boundaries',
          skill_id,
        );
      }

      // 8. Schema validation and normalization. The normalized payload — defaults applied, unknown
      //    keys stripped — is the payload the digest is taken over and the one executed.
      const normalized = skill.validateInput(request.input);
      if (
        typeof normalized === 'object' &&
        normalized !== null &&
        !Array.isArray(normalized) &&
        Object.hasOwn(normalized, 'tenant_id') &&
        (normalized as Record<string, unknown>)['tenant_id'] !== tenant_id
      ) {
        throw new SkillError(
          'CROSS_TENANT_ASSERTION',
          'normalized input tenant_id must equal the server-resolved dispatch tenant',
          skill_id,
        );
      }

      // 8. Approval binding: only an AUTH-4 route owes a bound approval, and only for THIS payload.
      const approval_id =
        admission.verdict === 'AWAITING_HUMAN_APPROVAL'
          ? assertApprovalCoversPayload({
              skill_id,
              normalized_input: normalized,
              request,
              digestPayload,
            })
          : undefined;

      // 9. Effect identity (BR-005): derived from the immutable inbound request, never adopted.
      const effect_key = resolveDispatchEffectKey(request, deriveEffectKey);

      // 10. Circuit-breaker admission: an OPEN provider is refused before any adapter call.
      const breaker = breakerFor(tenant_id, skill_id, skill.guarded_dependency);
      if (!breaker.canExecute()) {
        throw new SkillError(
          'CIRCUIT_BREAKER_OPEN',
          `the guarded dependency ${skill.guarded_dependency} is unavailable for this tenant/skill stream; the breaker refuses before any adapter call (NFR-004)`,
          skill_id,
        );
      }

      // 11. Bounded execution under the row's deadline and retry budget.
      const context: ExecutionContext = {
        run_id,
        tenant_id,
        caller_agent,
        correlation_id,
        granted_authority: request.granted_authority,
        effect_key,
        ...(approval_id === undefined
          ? {}
          : {
              approval_id,
              approval_payload_digest: request.approval_payload_digest,
            }),
      };

      const execution = await executeBounded<unknown>({
        skill_id,
        retry_policy: skill.retry_policy,
        timeout_ms: skill.timeout_ms,
        runAttempt: (signal) => skill.execute(normalized, { ...context, signal }),
        onAttemptFailure: () => breaker.recordFailure(),
        random,
        sleep,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      // 11. Response validation: a malformed response is never success. For an effect-bearing row,
      // the provider may already have committed before returning malformed bytes, so the outcome is
      // unknown and must be reconciled by effect_key rather than reported as a schema-only failure.
      const violations = validateAgainstSchema(skill.output_schema, execution.output);
      if (violations.length > 0) {
        if (skill.effect_class === 'EFFECT' || skill.effect_class === 'APPROVAL') {
          breaker.recordFailure();
          throw new SkillError(
            'EFFECT_UNKNOWN',
            `the adapter response failed output_schema after an effect-bearing call (${violations
              .map((violation) => `${violation.path}: ${violation.keyword} ${violation.message}`)
              .join('; ')}); reconcile by effect_key before any retry`,
            skill_id,
          );
        }
        throw new SkillError(
          'OUTPUT_SCHEMA_VALIDATION_ERROR',
          `the adapter response failed this row's output_schema: ${violations
            .map((violation) => `${violation.path}: ${violation.keyword} ${violation.message}`)
            .join('; ')}`,
          skill_id,
        );
      }
      breaker.recordSuccess();

      return {
        skill_id,
        verdict: admission.verdict,
        effect_class: skill.effect_class,
        effect_key,
        ...(approval_id === undefined ? {} : { approval_id }),
        output: execution.output as TOutput,
        attempts: execution.attempts,
        latency_ms: now() - startedAt,
      };
    },
  };
}

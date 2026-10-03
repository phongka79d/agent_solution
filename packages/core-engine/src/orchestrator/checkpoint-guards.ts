import { classifyErrorCode } from '../errors/catalog.js';

import {
  OrchestratorError,
  type ActionDraft,
  type DurableTaskCheckpoint,
  type ExecutionPlan,
  type HypothesisRecord,
  type ImmutableEvidenceRecord,
  type RetryClass,
  type FinalResponse,
  type PlatformAgentId,
  type SignalEnvelope,
  type TaskLifecycleState,
} from '../contracts/index.js';

/** Disposition of the guarded step loop, consumed by the façade entry points. */
export interface StepLoopOutcome {
  readonly lifecycle_state: TaskLifecycleState;
  readonly evidence?: ImmutableEvidenceRecord;
  readonly message?: string;
  readonly terminal_response?: FinalResponse;
  readonly response_agent_id?: PlatformAgentId;
}

/** The plan-step cursor a resume must continue from: the ordinal AFTER the last planned step. */
export function nextStepCursor(plan: ExecutionPlan): number {
  return plan.steps.reduce((highest, step) => Math.max(highest, step.step_index), 0) + 1;
}

/** Copies only optional outcome fields that are actually present. */
export function outcomeFields(fields: {
  evidence?: ImmutableEvidenceRecord | undefined;
  message?: string | undefined;
}): { evidence?: ImmutableEvidenceRecord; message?: string } {
  const present: { evidence?: ImmutableEvidenceRecord; message?: string } = {};
  if (fields.evidence !== undefined) {
    present.evidence = fields.evidence;
  }
  if (fields.message !== undefined) {
    present.message = fields.message;
  }
  return present;
}

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A timer retry is valid only for the exact durable retry generation and its persisted schedule. */
export function isRetryTimerCheckpoint(
  value: unknown,
  eventRetryCount: unknown,
  durableRetryCount: number,
): boolean {
  if (!isPlainJsonObject(value)) return false;
  const retryNotBefore = value['retry_not_before'];
  return value['wait_reason'] === 'RETRY'
    && typeof retryNotBefore === 'string'
    && Number.isFinite(Date.parse(retryNotBefore))
    && typeof eventRetryCount === 'number'
    && Number.isSafeInteger(eventRetryCount)
    && eventRetryCount > 0
    && eventRetryCount === durableRetryCount;
}

/** Generic timer events may wake non-mutating waits only; effects require reconciliation proof. */
export function allowsGenericTimerResume(value: unknown): boolean {
  if (!isPlainJsonObject(value)) return false;
  const waitReason = value['wait_reason'];
  const pendingAction = isPlainJsonObject(value['pending_action']) ? value['pending_action'] : null;
  return (waitReason === undefined || waitReason === 'OTHER')
    && pendingAction?.['mutating'] !== true;
}

/**
 * Validates the closed receipt-binding language before the first step can dispatch. Bindings must
 * point to an earlier step that is explicitly listed in `depends_on_steps`; destination fields are
 * top-level action inputs and response paths are bounded dotted fields or array indexes.
 */
export function validatePlanInputBindings(plan: ExecutionPlan): void {
  if (!Array.isArray(plan.steps)) {
    throw new OrchestratorError('INPUT_BINDING_PLAN_INVALID', 'A plan with receipt bindings must contain a step array.');
  }
  if (!plan.steps.some((step) => step.input_bindings !== undefined)) {
    return;
  }
  const positions = new Map<number, number>();
  for (const [position, step] of plan.steps.entries()) {
    if (!Number.isInteger(step.step_index) || step.step_index < 1 || positions.has(step.step_index)) {
      throw new OrchestratorError('INPUT_BINDING_STEP_INVALID', 'Receipt bindings require unique positive step indexes.');
    }
    positions.set(step.step_index, position);
  }

  const protectedDestinations: Readonly<Record<string, true>> = {
    tenant_id: true, run_id: true, request_id: true, action_id: true, agent_id: true, skill_id: true,
    adapter_target: true, step_index: true, mutating: true, price_bearing: true,
    required_authority: true, action_revision: true, effect_key: true,
  };
  const destinationPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const pathPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.(?:[A-Za-z][A-Za-z0-9_]*|0|[1-9][0-9]?)){0,7}$/;

  for (const step of plan.steps) {
    if (step.input_bindings === undefined) continue;
    if (!isPlainJsonObject(step.input_bindings)) {
      throw new OrchestratorError('INPUT_BINDING_INVALID', `Step ${step.step_index} input_bindings must be an object.`);
    }
    const dependencies = step.depends_on_steps;
    for (const [destination, rawBinding] of Object.entries(step.input_bindings)) {
      if (
        !destinationPattern.test(destination)
        || protectedDestinations[destination] === true
        || !isPlainJsonObject(rawBinding)
      ) {
        throw new OrchestratorError(
          'INPUT_BINDING_INVALID',
          `Step ${step.step_index} has an invalid receipt binding destination.`,
        );
      }
      const bindingKeys = Object.keys(rawBinding).sort();
      if (bindingKeys.length !== 2 || bindingKeys[0] !== 'response_path' || bindingKeys[1] !== 'source_step_index') {
        throw new OrchestratorError(
          'INPUT_BINDING_INVALID',
          `Step ${step.step_index}.${destination} contains unsupported binding fields.`,
        );
      }
      const sourceStepIndex = rawBinding['source_step_index'];
      const responsePath = rawBinding['response_path'];
      const sourcePosition = typeof sourceStepIndex === 'number' ? positions.get(sourceStepIndex) : undefined;
      const targetPosition = positions.get(step.step_index);
      if (
        !Number.isInteger(sourceStepIndex)
        || sourceStepIndex < 1
        || sourcePosition === undefined
        || targetPosition === undefined
        || sourcePosition >= targetPosition
        || sourceStepIndex >= step.step_index
        || !Array.isArray(dependencies)
        || !dependencies.includes(sourceStepIndex)
        || typeof responsePath !== 'string'
        || !pathPattern.test(responsePath)
      ) {
        throw new OrchestratorError(
          'INPUT_BINDING_INVALID',
          `Step ${step.step_index}.${destination} must reference an earlier declared dependency and a bounded response path.`,
        );
      }
    }
  }
}

export function readCompleteResumeCheckpoint(
  value: unknown,
  run_id: string,
): DurableTaskCheckpoint {
  if (!isPlainJsonObject(value)) {
    throw new OrchestratorError(
      'CHECKPOINT_INCOMPLETE',
      'Task ' + run_id + ' has no complete resume checkpoint; a human operator must resolve it in SCR-003.',
    );
  }
  const { plan, current_step, pending_action, context, previous_evidence_hash, request_id } = value;
  if (
    !isPlainJsonObject(plan) ||
    !Number.isInteger(current_step) ||
    (current_step as number) < 1 ||
    !Object.prototype.hasOwnProperty.call(value, 'pending_action') ||
    (pending_action !== null && !isPlainJsonObject(pending_action)) ||
    !isPlainJsonObject(context) ||
    typeof previous_evidence_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(previous_evidence_hash) ||
    typeof request_id !== 'string' ||
    request_id.trim().length === 0
  ) {
    throw new OrchestratorError(
      'CHECKPOINT_INCOMPLETE',
      'Task ' + run_id + ' has no complete resume checkpoint; a human operator must resolve it in SCR-003.',
    );
  }
  return value as unknown as DurableTaskCheckpoint;
}

export function validateSignalEnvelope(signal: SignalEnvelope): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(signal.tenant_id)) {
    throw new OrchestratorError('INVALID_TENANT_ID', 'tenant_id must be a UUID (NFR-006).');
  }
  if (!signal.signal_id || !signal.correlation_id || !signal.source_channel) {
    throw new OrchestratorError('INVALID_SIGNAL', 'Missing mandatory envelope routing metadata (SRS §17).');
  }
  if (!signal.subject?.session_id) {
    throw new OrchestratorError(
      'INVALID_SESSION',
      'A unique server-issued session_id is mandatory for every signal, including anonymous traffic (NFR-006).'
    );
  }
}

/** Hard Invariant FR-C360-003: HYPOTHESIS records can never be promoted to FACT. */
export function enforceEpistemicSeparation(hypothesis: HypothesisRecord): void {
  if (hypothesis.classification !== 'HYPOTHESIS') {
    throw new OrchestratorError('SECURITY_VIOLATION', 'Inferred data must be stamped classification: HYPOTHESIS');
  }
}

/** Hard Invariant BR-001 / BR-002 / BR-003: a price-bearing action needs an authoritative floor. */
export function verifyFloorPrice(action: ActionDraft): void {
  const payloadPriceBearing = action.payload['price_bearing'] === true
    || action.payload['offer_id'] !== undefined
    || action.payload['discount_amount'] !== undefined
    || action.payload['discount_percent'] !== undefined
    || action.proposed_price !== undefined;
  if (!action.price_bearing && !payloadPriceBearing) return;
  const proposedPrice = action.proposed_price;
  const priceFloor = action.computed_price_floor;
  if (typeof proposedPrice !== 'number'
    || !Number.isFinite(proposedPrice)
    || typeof priceFloor !== 'number'
    || !Number.isFinite(priceFloor)
    || !action.floor_source?.trim()) {
    throw new OrchestratorError(
      'P_FLOOR_UNAVAILABLE',
      `No owner-approved P_floor with provenance for ${action.skill_id}; refusing to price (BR-001, BR-003, NFR-008).`
    );
  }
  if (proposedPrice < priceFloor) {
    throw new OrchestratorError(
      'ERR_FLOOR_PRICE_VIOLATION',
      `Proposed price ${proposedPrice} < P_floor ${priceFloor} (${action.floor_source}).`
    );
  }
}

export function classifyFailure(error: unknown): RetryClass {
  let code: string | null = null;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    code = error.code;
  }
  if (code !== null) return classifyErrorCode(code);
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/connection reset/i.test(message)) return 'RETRYABLE';
  return 'FATAL';
}

export function serializeError(error: unknown): Record<string, unknown> {
  let code: string | undefined;
  let rawMessage: unknown;
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string') code = error.code;
    if ('message' in error) rawMessage = error.message;
  }
  const message = error instanceof Error
    ? error.message
    : typeof rawMessage === 'string'
      ? rawMessage
      : String(error);
  return {
    code: code ?? 'UNCLASSIFIED',
    message,
  };
}

/** Copies the optional floor mirrors a plan step actually carries. */
export function floorMirrors(step: {
  computed_price_floor?: number;
  floor_source?: string;
  proposed_price?: number;
}): Pick<ActionDraft, 'computed_price_floor' | 'floor_source' | 'proposed_price'> {
  const mirrors: { computed_price_floor?: number; floor_source?: string; proposed_price?: number } = {};
  if (step.computed_price_floor !== undefined) mirrors.computed_price_floor = step.computed_price_floor;
  if (step.floor_source !== undefined) mirrors.floor_source = step.floor_source;
  if (step.proposed_price !== undefined) mirrors.proposed_price = step.proposed_price;
  return mirrors;
}

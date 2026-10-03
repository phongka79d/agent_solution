/**
 * @file One Customer Care conversational-turn admission path shared by R02 and R11.
 *
 * The route owns one `conversation.turn` identity: its deterministic effect key, durable run,
 * message-history append and replay receipt. Keeping this boundary shared prevents the storefront
 * stream from reserving a second key or starting a differently shaped worker signal.
 */

import type { RedisInjectedClient } from '@agentos/database';

import type {
  AgentModule,
  GatewayPrincipal,
  TaskAcceptedResponse,
  TaskStoredState,
  TaskWireStatus,
} from '../../gateway/contracts.js';
import { fail } from '../../gateway/http.js';
import type { ConversationRecord, GatewayRuntime, RunAdmission } from '../../gateway/ports.js';

const CONVERSATION_TURN_SKILL = 'conversation.turn';

export interface HumanOwnedResponse {
  readonly conversation_id: string;
  readonly status: 'HUMAN_OWNED';
  readonly correlation_id: string;
}

type CareTurnAcceptedResponse = TaskAcceptedResponse | HumanOwnedResponse;

export const VALID_AGENT_MODULES: readonly string[] = Object.freeze(['support', 'sales', 'marketing']);

export function parseEnabledAgentModules(raw?: string): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return Object.freeze(['support']);
  }
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const part of parts) {
    if (!VALID_AGENT_MODULES.includes(part)) {
      throw new Error(
        `ENABLED_AGENT_MODULES_INVALID: unknown module '${part}'. Valid modules are ${VALID_AGENT_MODULES.join(', ')}`,
      );
    }
  }
  return Object.freeze([...new Set(parts)]);
}

export const CARE_EVENT_TYPES: readonly string[] = Object.freeze(['message.received']);
export const MARKETING_EVENT_TYPES: readonly string[] = Object.freeze(['campaign.requested']);
export const DEFAULT_ADMISSION_EVENT_TYPE = 'message.received';

export function parseMarketingSignalEventTypes(raw?: string): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return MARKETING_EVENT_TYPES;
  }
  return Object.freeze(raw.split(',').map((eventType) => eventType.trim()).filter(Boolean));
}

export function parseSalesSignalEventTypes(raw?: string): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(raw.split(',').map((e) => e.trim()).filter(Boolean));
}

export function acceptedEventTypesForModule(
  module: string,
  options?: { readonly salesSignalEventTypes?: readonly string[]; readonly marketingSignalEventTypes?: readonly string[] },
): readonly string[] {
  if (module === 'support') {
    return CARE_EVENT_TYPES;
  }
  if (module === 'sales') {
    return options?.salesSignalEventTypes ?? parseSalesSignalEventTypes(process.env.SALES_SIGNAL_EVENT_TYPES);
  }
  if (module === 'marketing') {
    return options?.marketingSignalEventTypes ?? parseMarketingSignalEventTypes(process.env.MARKETING_SIGNAL_EVENT_TYPES);
  }
  return Object.freeze([]);
}

export function validateAdmissionEventType(
  eventType: unknown,
  module: string,
  options?: { readonly salesSignalEventTypes?: readonly string[]; readonly marketingSignalEventTypes?: readonly string[] },
): string {
  if (eventType === undefined) {
    return module === 'marketing' ? MARKETING_EVENT_TYPES[0]! : DEFAULT_ADMISSION_EVENT_TYPE;
  }
  if (typeof eventType !== 'string' || eventType.trim().length === 0) {
    fail('VALIDATION_FAILED', 'event_type is required and must be a non-empty string');
  }
  const accepted = acceptedEventTypesForModule(module, options);
  if (!accepted.includes(eventType)) {
    fail('VALIDATION_FAILED', 'event_type is not accepted for the requested module');
  }
  return eventType;
}

const RECEIPT_WAIT_ATTEMPTS = 10;
const RECEIPT_WAIT_INTERVAL_MS = 250;

const DEFAULT_TURN_RATE_LIMIT_CAPACITY = 10;
const DEFAULT_TURN_RATE_LIMIT_REFILL_PER_SECOND = 1 / 6;
const DEFAULT_TURN_RATE_LIMIT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TURN_RATE_LIMIT_MAX_BUCKETS = 10_000;

/** Admission limiter keyed by the authenticated tenant and channel/widget session. */
export interface TurnRateLimiter {
  consume(tenant_id: string, session_id: string): boolean | Promise<boolean>;
}

interface TokenBucketOptions {
  readonly capacity?: number;
  readonly refill_per_second?: number;
  readonly idle_ttl_ms?: number;
}

export interface InMemoryTurnRateLimiterOptions extends TokenBucketOptions {
  readonly max_buckets?: number;
  readonly clock?: () => Date;
}

export type RedisTurnRateLimiterOptions = TokenBucketOptions;

type TokenBucket = {
  tokens: number;
  last_refill_ms: number;
  last_access_ms: number;
};

const REDIS_TURN_RATE_LIMIT_SCRIPT = `
  -- care_turn_token_bucket
  local clock = redis.call("TIME")
  local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  local capacity = tonumber(ARGV[1])
  local refill_per_second = tonumber(ARGV[2])
  local idle_ttl_ms = tonumber(ARGV[3])
  local tokens = capacity
  local last_refill_ms = now_ms
  local stored = redis.call("GET", KEYS[1])
  if stored then
    local separator = string.find(stored, ":", 1, true)
    if separator then
      tokens = tonumber(string.sub(stored, 1, separator - 1))
      last_refill_ms = tonumber(string.sub(stored, separator + 1))
    end
  end
  if tokens == nil or last_refill_ms == nil then
    tokens = capacity
    last_refill_ms = now_ms
  end
  local elapsed_ms = math.max(0, now_ms - last_refill_ms)
  tokens = math.min(capacity, tokens + elapsed_ms * refill_per_second / 1000)
  local allowed = 0
  if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
  end
  redis.call("SET", KEYS[1], string.format("%.17g:%.0f", tokens, now_ms), "PX", idle_ttl_ms)
  return allowed
`;


/**
 * A bounded process-local limiter for intent proposals. Expired buckets are reclaimed first;
 * pressure evicts the least recently used bucket when the configured maximum is reached.
 */
export class InMemoryTurnRateLimiter implements TurnRateLimiter {
  private readonly capacity: number;
  private readonly refill_per_second: number;
  private readonly idle_ttl_ms: number;
  private readonly max_buckets: number;
  private readonly clock: () => Date;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(options: InMemoryTurnRateLimiterOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_TURN_RATE_LIMIT_CAPACITY;
    this.refill_per_second = options.refill_per_second ?? DEFAULT_TURN_RATE_LIMIT_REFILL_PER_SECOND;
    this.idle_ttl_ms = options.idle_ttl_ms ?? DEFAULT_TURN_RATE_LIMIT_IDLE_TTL_MS;
    this.max_buckets = options.max_buckets ?? DEFAULT_TURN_RATE_LIMIT_MAX_BUCKETS;
    this.clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new TypeError('turn rate limiter capacity must be a positive integer');
    }
    if (!Number.isFinite(this.refill_per_second) || this.refill_per_second < 0) {
      throw new TypeError('turn rate limiter refill_per_second must be a non-negative finite number');
    }
    if (!Number.isSafeInteger(this.idle_ttl_ms) || this.idle_ttl_ms < 1) {
      throw new TypeError('turn rate limiter idle_ttl_ms must be a positive integer');
    }
    if (!Number.isSafeInteger(this.max_buckets) || this.max_buckets < 1) {
      throw new TypeError('turn rate limiter max_buckets must be a positive integer');
    }
  }

  consume(tenant_id: string, session_id: string): boolean {
    const now_ms = this.clock().getTime();
    this.evictIdleBuckets(now_ms);
    const key = `${tenant_id.length}:${tenant_id}${session_id.length}:${session_id}`;
    const previous = this.buckets.get(key);
    const bucket: TokenBucket = previous === undefined
      ? { tokens: this.capacity, last_refill_ms: now_ms, last_access_ms: now_ms }
      : previous;
    const elapsed_ms = Math.max(0, now_ms - bucket.last_refill_ms);
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsed_ms * this.refill_per_second / 1000,
    );
    bucket.last_refill_ms = now_ms;
    bucket.last_access_ms = Math.max(bucket.last_access_ms, now_ms);
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    if (previous !== undefined) {
      this.buckets.delete(key);
    } else if (this.buckets.size >= this.max_buckets) {
      const leastRecentKey = this.buckets.keys().next().value;
      if (leastRecentKey !== undefined) this.buckets.delete(leastRecentKey);
    }
    this.buckets.set(key, bucket);
    return allowed;
  }

  private evictIdleBuckets(now_ms: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now_ms - bucket.last_access_ms <= this.idle_ttl_ms) break;
      this.buckets.delete(key);
    }
  }
}

/**
 * Shared token-bucket limiter for deployments with Redis. Lua keeps refill and consumption atomic
 * across API processes, while an idle TTL bounds the lifetime of abandoned session keys.
 */
export class RedisTurnRateLimiter implements TurnRateLimiter {
  private readonly capacity: number;
  private readonly refill_per_second: number;
  private readonly idle_ttl_ms: number;

  constructor(
    private readonly redis: Pick<RedisInjectedClient, 'eval'>,
    options: RedisTurnRateLimiterOptions = {},
  ) {
    this.capacity = options.capacity ?? DEFAULT_TURN_RATE_LIMIT_CAPACITY;
    this.refill_per_second = options.refill_per_second ?? DEFAULT_TURN_RATE_LIMIT_REFILL_PER_SECOND;
    this.idle_ttl_ms = options.idle_ttl_ms ?? DEFAULT_TURN_RATE_LIMIT_IDLE_TTL_MS;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new TypeError('turn rate limiter capacity must be a positive integer');
    }
    if (!Number.isFinite(this.refill_per_second) || this.refill_per_second < 0) {
      throw new TypeError('turn rate limiter refill_per_second must be a non-negative finite number');
    }
    if (!Number.isSafeInteger(this.idle_ttl_ms) || this.idle_ttl_ms < 1) {
      throw new TypeError('turn rate limiter idle_ttl_ms must be a positive integer');
    }
  }

  async consume(tenant_id: string, session_id: string): Promise<boolean> {
    const key = `agentos:care-turn:${encodeURIComponent(tenant_id)}:${encodeURIComponent(session_id)}`;
    const result = await this.redis.eval(
      REDIS_TURN_RATE_LIMIT_SCRIPT,
      1,
      key,
      this.capacity,
      this.refill_per_second,
      this.idle_ttl_ms,
    );
    return result === 1 || result === '1';
  }
}
function wireStatusOf(state: TaskStoredState): TaskWireStatus {
  return state === 'queued' ? 'accepted' : state;
}

function acceptedFromReceipt(
  receipt: Record<string, unknown>,
  conversation_id: string,
): CareTurnAcceptedResponse {
  const status = receipt['status'];
  const correlation_id = receipt['correlation_id'];
  if (typeof correlation_id !== 'string') {
    fail('INTERNAL_ERROR', 'the receipt stored for this idempotency key is incomplete and cannot be returned');
  }
  if (status === 'HUMAN_OWNED') {
    return { conversation_id, status, correlation_id };
  }

  const task_id = receipt['task_id'];
  const task_version = receipt['task_version'];
  if (typeof task_id !== 'string' || typeof task_version !== 'number') {
    fail('INTERNAL_ERROR', 'the receipt stored for this idempotency key is incomplete and cannot be returned');
  }

  return {
    task_id,
    conversation_id,
    status: status === 'accepted' || status === 'running' || status === 'waiting'
      || status === 'awaiting_human' || status === 'completed' || status === 'stopped' || status === 'failed'
      ? status
      : 'accepted',
    task_version,
    correlation_id,
  };
}

export interface CareTurnAdmission {
  readonly accepted: CareTurnAcceptedResponse;
  /** Complete canonical replay receipt, including `request_fingerprint`. */
  readonly receipt: Record<string, unknown>;
  readonly admission: RunAdmission;
  readonly replayed: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTurnReceipt(input: {
  readonly runtime: GatewayRuntime;
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly request_fingerprint: string;
}): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < RECEIPT_WAIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(RECEIPT_WAIT_INTERVAL_MS);
    const receipt = await input.runtime.receipts.receiptFor(input.tenant_id, input.effect_key);
    if (receipt === null) continue;
    if (receipt['request_fingerprint'] !== input.request_fingerprint) {
      fail('IDEMPOTENCY_CONFLICT', 'this idempotency key was already claimed for a different payload');
    }
    return receipt;
  }
  fail('RUN_LEASE_HELD', 'another delivery still owns this turn; retry after its durable receipt is settled');
}

import { salesOrderRequestFor, salesRequirementsFor, shouldUseSalesAdvisor } from './turn-classifier.js';
import type { TurnIntentPort, TurnIntentProposal } from '../../runtime/bindings/turn-intent.js';

/**
 * Provider failures raised while proposing a Care intent, mapped onto the gateway's own vocabulary.
 * The proposal is a live provider call, so its failure is reported as what it is — an upstream
 * refusal or timeout — instead of a generic server fault the caller cannot act on.
 */
const PROVIDER_FAILURE_CODES: Record<string, {
  readonly code: 'CAPABILITY_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'PROVIDER_TIMEOUT' | 'RATE_LIMITED';
  readonly message: string;
}> = {
  LLM_NOT_CONFIGURED: { code: 'CAPABILITY_UNAVAILABLE', message: 'no LLM provider is configured for this turn' },
  LLM_AUTH_FAILED: { code: 'PROVIDER_REJECTED', message: 'the intent provider rejected the platform credential' },
  LLM_INVALID_RESPONSE: { code: 'PROVIDER_REJECTED', message: 'the intent provider returned an unusable response' },
  LLM_RATE_LIMITED: { code: 'RATE_LIMITED', message: 'the intent provider rate-limited this turn' },
  LLM_TIMEOUT: { code: 'PROVIDER_TIMEOUT', message: 'the intent provider did not answer before the deadline' },
  LLM_TOKEN_BUDGET_EXHAUSTED: { code: 'RATE_LIMITED', message: 'the tenant LLM token budget is exhausted, so no provider call was made' },
  LLM_TOKEN_BUDGET_UNAVAILABLE: { code: 'PROVIDER_TIMEOUT', message: 'the tenant LLM token usage could not be read, so no provider call was made' },
  LLM_CANCELLED: { code: 'PROVIDER_TIMEOUT', message: 'the intent provider call was cancelled' },
  LLM_UNAVAILABLE: { code: 'PROVIDER_TIMEOUT', message: 'the intent provider is currently unreachable' },
};

type TurnIntentProposalOutcome =
  | { readonly kind: 'PROPOSED'; readonly proposal: TurnIntentProposal }
  | { readonly kind: 'REFUSED'; readonly code: 'LLM_INVALID_RESPONSE' };

/** Proposes the Care intent, refusing truthfully when the provider cannot answer. */
async function proposeCareIntent(
  proposer: TurnIntentPort,
  message: string,
  correlation_id: string,
  scope: { readonly tenant_id: string; readonly run_id: string },
): Promise<TurnIntentProposalOutcome> {
  try {
    return {
      kind: 'PROPOSED',
      proposal: await proposer.propose({ message, correlation_id, tenant_id: scope.tenant_id, run_id: scope.run_id }),
    };
  } catch (error) {
    let code: unknown;
    if (typeof error === 'object' && error !== null && 'code' in error) code = error.code;
    if (code === 'LLM_INVALID_RESPONSE') return { kind: 'REFUSED', code };
    const mapped = typeof code === 'string' ? PROVIDER_FAILURE_CODES[code] : undefined;
    if (mapped === undefined) throw error;
    return fail(mapped.code, `${mapped.message}; the turn is refused rather than answered from an unvalidated classification`);
  }
}

/** Lets Care's deterministic parser handle an incomplete model order proposal. */
function careProposalForTurn(proposal: TurnIntentProposal | undefined): TurnIntentProposal | undefined {
  if (
    proposal !== undefined
    && (proposal.intent === 'order_status' || proposal.intent === 'order_lookup')
    && proposal.requirements.order_reference === undefined
  ) {
    return undefined;
  }
  return proposal;
}



export async function admitCareTurn(input: {
  readonly runtime: GatewayRuntime;
  readonly principal: GatewayPrincipal;
  readonly conversation: ConversationRecord;
  readonly correlation_id: string;
  readonly request_id: string;
  readonly message: string;
  readonly module: AgentModule;
  readonly event_type?: string;
  readonly attachments?: readonly string[];
  readonly operation: string;
  readonly intentProposer?: TurnIntentPort;
  readonly rateLimiter?: TurnRateLimiter;
}): Promise<CareTurnAdmission> {
  const { runtime, principal, conversation } = input;
  const tenant_id = principal.tenant_id;
  const conversation_id = conversation.conversation_id;

  const effect_key = runtime.effects.computeEffectKey({
    tenant_id,
    skill_id: CONVERSATION_TURN_SKILL,
    step_index: 0,
    action_revision: 0,
    request_id: input.request_id,
  });
  const request_fingerprint = runtime.effects.computeRequestFingerprint({
    message: input.message,
    conversation_id,
    module: input.module,
    attachments: input.attachments ?? null,
  });

  let customerTakeover =
    conversation.state === 'paused_takeover' &&
    (principal.kind === 'CHANNEL_SESSION' || principal.kind === 'WIDGET_SESSION');
  const customerPrincipal = principal.kind === 'CHANNEL_SESSION' || principal.kind === 'WIDGET_SESSION';
  const takeoverActive = conversation.state === 'paused_takeover';
  // The live lease is consulted only while the durable marker says a human holds the conversation;
  // an open conversation has no lease to honour, and deployments without the takeover store stay usable.
  const lease = takeoverActive
    ? await runtime.takeover.holder(tenant_id, conversation_id)
    : null;

  if (customerPrincipal) {
    if (takeoverActive) {
      // An absent key is an expired lease, so a stale paused marker cannot keep AI blocked forever.
      customerTakeover = lease !== null;
    }
  } else if (takeoverActive && (lease === null || lease.operator_id !== principal.operator_id)) {
    fail(
      'CONVERSATION_LOCKED',
      'another operator holds the takeover lease for this conversation, so no new agent turn may start',
    );
  }

  // A settled replay must be answered before consuming limiter tokens or calling the LLM.
  const stored = await runtime.receipts.receiptFor(tenant_id, effect_key);
  if (stored !== null) {
    if (stored['request_fingerprint'] !== request_fingerprint) {
      fail(
        'IDEMPOTENCY_CONFLICT',
        'this idempotency key was already claimed for a different payload; the turn is not started again',
      );
    }
    await runtime.audit.record({
      tenant_id,
      correlation_id: input.correlation_id,
      operation: input.operation,
      principal_kind: principal.kind,
      ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
      outcome: 'ACCEPTED',
      detail: { replay: true, effect_key, conversation_id, status: stored['status'] },
    });
    return {
      accepted: acceptedFromReceipt(stored, conversation_id),
      receipt: stored,
      admission: 'REPLAY',
      replayed: true,
    };
  }

  const session_id = principal.session_id ?? conversation.external_thread_id;
  if (input.rateLimiter !== undefined && !(await input.rateLimiter.consume(tenant_id, session_id))) {
    fail('RATE_LIMITED', 'too many conversational turns for this session; retry after the rate window');
  }

  // Claim before intent classification. Concurrent deliveries wait for the first receipt and never
  // spend another provider call on the same idempotency key.
  const reserved_run_id = runtime.ids();
  const reservation = typeof runtime.effects.reserve === 'function'
    ? await runtime.effects.reserve({
        tenant_id,
        run_id: reserved_run_id,
        request_id: input.request_id,
        effect_key,
        request_fingerprint,
        skill_id: CONVERSATION_TURN_SKILL,
        step_index: 0,
        action_revision: 0,
      })
    : { kind: 'RESERVED' as const };

  if (reservation.kind === 'CONFLICT') {
    fail('IDEMPOTENCY_CONFLICT', 'this idempotency key was already claimed for a different payload');
  }
  if (reservation.kind === 'REPLAY') {
    const replayReceipt = reservation.receipt;
    if (typeof replayReceipt !== 'object' || replayReceipt === null || Array.isArray(replayReceipt)) {
      fail('INTERNAL_ERROR', 'the durable replay has no stored receipt and cannot be returned');
    }
    const receipt = replayReceipt as Record<string, unknown>;
    return {
      accepted: acceptedFromReceipt(receipt, conversation_id),
      receipt,
      admission: 'REPLAY',
      replayed: true,
    };
  }
  if (reservation.kind === 'IN_FLIGHT') {
    const receipt = await waitForTurnReceipt({
      runtime,
      tenant_id,
      effect_key,
      request_fingerprint,
    });
    return {
      accepted: acceptedFromReceipt(receipt, conversation_id),
      receipt,
      admission: 'IN_FLIGHT',
      replayed: true,
    };
  }
  if (reservation.kind === 'RECONCILE_REQUIRED') {
    fail(
      'RUN_NOT_RECONCILABLE',
      customerTakeover
        ? 'the human-owned message reservation requires reconciliation before retrying'
        : 'the turn reservation requires reconciliation before retrying',
    );
  }

  if (customerTakeover) {
    await runtime.conversations.appendMessage({
      tenant_id,
      conversation_id,
      sender_type: 'customer',
      sender_id: session_id,
      content: input.message,
      request_id: input.request_id,
    });
    const receipt: Record<string, unknown> = {
      conversation_id,
      status: 'HUMAN_OWNED',
      correlation_id: input.correlation_id,
      request_fingerprint,
    };
    await runtime.receipts.storeReceipt(tenant_id, effect_key, receipt);
    await runtime.audit.record({
      tenant_id,
      correlation_id: input.correlation_id,
      operation: input.operation,
      principal_kind: principal.kind,
      detail: { effect_key, conversation_id, status: 'HUMAN_OWNED' },
      outcome: 'ACCEPTED',
    });
    return {
      accepted: { conversation_id, status: 'HUMAN_OWNED', correlation_id: input.correlation_id },
      receipt,
      admission: 'ADMITTED',
      replayed: false,
    };
  }

  const salesOrderRequest = input.module === 'sales' ? salesOrderRequestFor(input.message) : undefined;
  let intentProposal: TurnIntentProposal | undefined;
  let intentProposalFailure: 'LLM_INVALID_RESPONSE' | undefined;
  try {
    const intentOutcome = input.module !== 'marketing'
      && !(input.module === 'sales' && salesOrderRequest !== undefined)
      && input.intentProposer !== undefined
      ? await proposeCareIntent(input.intentProposer, input.message, input.correlation_id, {
          tenant_id,
          run_id: reserved_run_id,
        })
      : undefined;
    if (intentOutcome?.kind === 'PROPOSED') {
      intentProposal = intentOutcome.proposal;
    } else if (intentOutcome?.kind === 'REFUSED') {
      if (input.module !== 'sales') {
        const mapped = PROVIDER_FAILURE_CODES[intentOutcome.code] ?? {
          code: 'PROVIDER_REJECTED',
          message: 'the intent provider returned an unusable response',
        };
        fail(mapped.code, `${mapped.message}; the turn is refused rather than answered from an unvalidated classification`);
      }
      intentProposalFailure = intentOutcome.code;
    }
  } catch (error) {
    await runtime.effects.resolve({ tenant_id, effect_key, status: 'FAILED' });
    throw error;
  }
  const careProposal = input.module === 'support' ? careProposalForTurn(intentProposal) : undefined;
  const parsedSalesRequirements = input.module === 'sales'
    && intentProposalFailure === undefined
    && salesOrderRequest === undefined
    ? salesRequirementsFor(input.message, intentProposal?.sales_requirements)
    : undefined;
  const salesRequirements = intentProposalFailure === undefined
    && shouldUseSalesAdvisor(input.message, parsedSalesRequirements)
    ? parsedSalesRequirements
    : undefined;


  const started = await runtime.runs.start({
    tenant_id,
    correlation_id: input.correlation_id,
    request_id: input.request_id,
    source_channel: conversation.channel,
    event_type: input.event_type ?? DEFAULT_ADMISSION_EVENT_TYPE,
    session_id,
    channel_type: conversation.channel,
    channel_identifier: conversation.external_thread_id,
    ...(conversation.customer_id === null ? {} : { verified_customer_id: conversation.customer_id }),
    payload: {
      message: input.message,
      conversation_id,
      module: input.module,
      ...(input.attachments === undefined ? {} : { attachments: [...input.attachments] }),
      ...(careProposal === undefined ? {} : {
        care_intent: careProposal.intent,
        care_requirements: careProposal.requirements,
        ...(careProposal.metadata === undefined ? {} : { care_intent_metadata: careProposal.metadata }),
      }),
      ...(salesOrderRequest === undefined ? {} : {
        sales_proposal_source: 'API_GATEWAY',
        sales_intent: 'purchase',
        sales_order_request: salesOrderRequest,
      }),
      ...(salesRequirements === undefined ? {} : {
        sales_proposal_source: 'API_GATEWAY',
        sales_intent: 'advisor',
        sales_requirements: salesRequirements,
      }),
      ...(intentProposalFailure === undefined ? {} : {
        sales_proposal_source: 'API_GATEWAY',
        sales_intent_failure: intentProposalFailure,
      }),


      ...(input.module === 'sales' && intentProposal?.metadata !== undefined
        ? { sales_intent_metadata: intentProposal.metadata }
        : {}),
    },
    ...(reservation.kind === 'RESERVED'
      ? {
          admission_reservation: {
            run_id: reserved_run_id,
            effect_key,
            request_fingerprint,
            customer_message: {
              conversation_id,
              sender_id: session_id,
              content: input.message,
              request_id: input.request_id,
            },
          },
        }
      : {}),
  });
  if (
    (started.admission === undefined || started.admission === 'ADMITTED')
    && intentProposal?.metadata !== undefined
    && runtime.providerCalls !== undefined
  ) {
    const metadata = intentProposal.metadata;
    try {
      await runtime.providerCalls.appendProviderCall({
        tenant_id,
        run_id: started.run_id,
        step_index: 0,
        stage: 'HYPOTHESIS',
        call_index: 0,
        provider: metadata.provider,
        model: metadata.model,
        observed_status: 'SUCCESS',
        latency_ms: metadata.latency_ms,
        ...(metadata.usage === undefined ? {} : {
          prompt_tokens: metadata.usage.prompt_tokens,
          completion_tokens: metadata.usage.completion_tokens,
        }),
      });
    } catch {
      // Telemetry must never turn an already-admitted customer turn into a second failure. The
      // request remains truthful because the ledger is explicitly absent, not reported as success.
      try {
        await runtime.audit.record({
          tenant_id,
          correlation_id: input.correlation_id,
          operation: `${input.operation}.provider_ledger`,
          principal_kind: principal.kind,
          ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
          outcome: 'ACCEPTED',
          detail: { provider_ledger: 'UNAVAILABLE' },
        });
      } catch {
        // The primary admission and its receipt are already durable.
      }
    }
  }


  const admission = started.admission ?? 'ADMITTED';

  if (admission === 'REPLAY') {
    if (started.receipt === undefined) {
      fail('INTERNAL_ERROR', 'the durable replay has no stored receipt and cannot be returned');
    }
    return {
      accepted: acceptedFromReceipt(started.receipt, conversation_id),
      receipt: started.receipt,
      admission,
      replayed: true,
    };
  }

  if (admission === 'IN_FLIGHT') {
    const receipt = await waitForTurnReceipt({
      runtime,
      tenant_id,
      effect_key,
      request_fingerprint,
    });
    return {
      accepted: acceptedFromReceipt(receipt, conversation_id),
      receipt,
      admission,
      replayed: true,
    };
  }

  const receipt: Record<string, unknown> = {
    task_id: started.run_id,
    conversation_id,
    status: wireStatusOf(started.lifecycle_state),
    task_version: started.task_version,
    correlation_id: started.correlation_id,
    request_fingerprint,
  };

  await runtime.receipts.storeReceipt(tenant_id, effect_key, receipt);

  await runtime.audit.record({
    tenant_id,
    correlation_id: input.correlation_id,
    operation: input.operation,
    principal_kind: principal.kind,
    ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
    outcome: 'ACCEPTED',
    detail: {
      run_id: started.run_id,
      effect_key,
      conversation_id,
      ...(careProposal?.metadata === undefined && intentProposal?.metadata === undefined
        ? {}
        : { intent_provider: careProposal?.metadata ?? intentProposal?.metadata }),
    },
  });

  return {
    accepted: acceptedFromReceipt(receipt, conversation_id),
    receipt,
    admission,
    replayed: false,
  };
}

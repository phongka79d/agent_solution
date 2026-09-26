/**
 * @file The composition root: the one place where ports meet implementations (implement/02 §2,
 * `06` §10.1).
 *
 * Every binding is explicit. An absent implementation throws `UnboundPortError` and is named
 * at composition time; no request receives a value the platform never observed. Reservation,
 * approval and evidence rules remain with their owning repositories. The composed path currently
 * reaches durable projections, identity lookup, Redis takeover leases, and PostgreSQL handoff assignment/completion.
 * Agent planning, policy evaluation and skill dispatch require a production orchestrator graph and remain unbound.
 */

import { ConnectorRegistry, type EventAliasNormalizer, type HmacSha256Hex } from '@agentos/adapters';
import {
  createRuntimeRedisClient,
  type RuntimeRedisClient,
} from '@agentos/core-engine';
import {
  ApprovalRepository,
  AuditRepository,
  CareHandoffRepository,
  ConversationRepository,
  CustomerEventRepository,
  DurableWorkflowRepository,
  EffectReservationRepository,
  EvidenceRepository,
  type RedisInjectedClient,
} from '@agentos/database';

import type {
  ApprovalPort,
  GatewayAuditPort,
  GatewayRuntime,
  IdentityPort,
  KpiPort,
  RunPort,
  StreamPort,
  TakeoverLeasePort,
} from '../gateway/ports.js';
import { parseEnabledAgentModules, parseMarketingSignalEventTypes, parseSalesSignalEventTypes } from '../routes/v1/care-turn.js';
import { createCredentialStore, type CredentialStore } from '../gateway/principal.js';
import {
  createCanonicalEventNormalizer,
  createWebhookVerificationPort,
  nodeHmacSha256Hex,
  type ChannelSecretStore,
} from './adapters.js';
import {
  createApprovalDecisionPort,
  createApprovalReadPort,
  createCareHandoffPort,
  createConversationPort,
  createDurableRunPort,
  createEffectGuard,
  createStartRunPort,
  createEventPort,
  createIdentityPort,
  createReceiptPort,
  createTakeoverLeasePort,
  systemClock,
  systemIdentifiers,
} from './bindings.js';

/**
 * A capability this build does not bind.
 *
 * Raised before the missing operation mutates durable state. No value is returned and no
 * reservation is created on these paths; the gateway reports a typed refusal.
 */
export class UnboundPortError extends Error {
  constructor(readonly port: string, readonly capability: string) {
    super(
      `PORT_UNBOUND: ${port} has no implementation in this build (${capability}); the operation is refused rather than answered with an unobserved value`,
    );
    this.name = 'UnboundPortError';
  }
}

/** The gateway code a route reports for a capability this build does not provide. */
function unbound(port: string, capability: string): never {
  throw new UnboundPortError(port, capability);
}

/** Environment the composition root reads. Nothing else is consulted, and no secret is logged. */
export interface GatewayEnv {
  readonly APP_ENV?: string;
  readonly SESSION_SECRET?: string;
  readonly PLATFORM_SECRET?: string;
  /** The deployment's identity/session signing key; the session binding falls back to it. */
  readonly JWT_SECRET?: string;
  /** The deployment's ingress HMAC secret; the platform ingress signature falls back to it. */
  readonly WEBHOOK_HMAC_SECRET?: string;
  readonly READINESS_ATTEMPTS?: string;
  readonly REDIS_HOST?: string;
  readonly REDIS_PORT?: string;
  readonly REDIS_PASSWORD?: string;
  readonly REDIS_DB?: string;
  readonly ENABLED_AGENT_MODULES?: string;
  readonly SALES_SIGNAL_EVENT_TYPES?: string;
  readonly MARKETING_SIGNAL_EVENT_TYPES?: string;
}

/** The assembled gateway: the routes' runtime, the credential store and the derivation binding. */
export interface GatewayComposition {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly normalizer: EventAliasNormalizer;
  /** Capabilities this build does not bind, named for the boot log and the report. */
  readonly unbound: readonly string[];
  readonly enabledModules: readonly string[];
  readonly salesSignalEventTypes: readonly string[];
  readonly marketingSignalEventTypes: readonly string[];
  readonly close: () => Promise<void>;
}

/** Reads a required secret without ever publishing its value. */
function requireSecret(value: string | undefined, name: 'SESSION_SECRET' | 'PLATFORM_SECRET'): string {
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error(
      `${name}: the gateway refuses to start without a signing secret of at least 16 characters; a missing secret would issue unsigned session tokens or verify nothing`,
    );
  }
  return value;
}

/**
 * Resolves the gateway's signing material from the deployment's validated secrets.
 *
 * The gateway needs two secrets: the one that signs a conversation-session binding, and the one the
 * platform presents as its own ingress signature. The deployment already defines exactly those two
 * purposes (`JWT_SECRET`, the identity/session signing key, and `WEBHOOK_HMAC_SECRET`, the ingress
 * HMAC secret), and both are validated at boot, so this reuses them instead of introducing a third
 * and fourth key that a managed profile would have to learn. A dedicated `SESSION_SECRET` or
 * `PLATFORM_SECRET` overrides its binding when a deployment wants the gateway on its own material.
 *
 * @param env Process environment.
 * @returns The two secrets the composition binds.
 * @throws Error when neither the dedicated key nor its deployment counterpart is present.
 */
function resolveSecrets(env: GatewayEnv): {
  readonly session_secret: string;
  readonly platform_secret: string;
} {
  return {
    session_secret: requireSecret(env.SESSION_SECRET ?? env.JWT_SECRET, 'SESSION_SECRET'),
    platform_secret: requireSecret(env.PLATFORM_SECRET ?? env.WEBHOOK_HMAC_SECRET, 'PLATFORM_SECRET'),
  };
}

/** Redis configuration is optional only when no Redis field is present (unit-test composition). */
function redisConfiguration(env: GatewayEnv): {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly db: number;
} | null {
  const configured =
    env.REDIS_HOST !== undefined ||
    env.REDIS_PORT !== undefined ||
    env.REDIS_PASSWORD !== undefined ||
    env.REDIS_DB !== undefined;
  if (!configured) return null;

  const host = env.REDIS_HOST ?? '';
  const password = env.REDIS_PASSWORD ?? '';
  const port = Number.parseInt(env.REDIS_PORT ?? '6379', 10);
  const db = Number.parseInt(env.REDIS_DB ?? '0', 10);
  return { host, port, password, db };
}

/**
 * Assembles the durable gateway over the repositories that already own their tables.
 *
 * @param env The process environment; only the fields of {@link GatewayEnv} are read.
 * @param options.credentials Optional credential store override, used by tests.
 * @param options.channelSecrets Optional channel/platform secret store override.
 * @param options.hmac Optional HMAC primitive override.
 * @param options.connectors Optional connector registry; an empty registry dispatches nothing.
 * @returns The composition, with the unbound capabilities named.
 */
export function createGatewayComposition(
  env: GatewayEnv,
  options?: {
    readonly credentials?: CredentialStore;
    readonly channelSecrets?: ChannelSecretStore;
    readonly hmac?: HmacSha256Hex;
    readonly connectors?: ConnectorRegistry;
    /** Injected takeover store. The composition closes only clients it constructed itself. */
    readonly redis?: RedisInjectedClient;
  },
): GatewayComposition {
  const enabledModules = parseEnabledAgentModules(env.ENABLED_AGENT_MODULES);
  const salesSignalEventTypes = parseSalesSignalEventTypes(env.SALES_SIGNAL_EVENT_TYPES);
  const marketingSignalEventTypes = parseMarketingSignalEventTypes(env.MARKETING_SIGNAL_EVENT_TYPES);
  const { session_secret, platform_secret } = resolveSecrets(env);
  const hmac = options?.hmac ?? nodeHmacSha256Hex;

  const conversationsRepository = new ConversationRepository();
  const careHandoffsRepository = new CareHandoffRepository();
  const eventsRepository = new CustomerEventRepository();
  const reservationsRepository = new EffectReservationRepository();
  const workflowsRepository = new DurableWorkflowRepository();
  const approvalsRepository = new ApprovalRepository();
  const evidenceRepository = new EvidenceRepository();
  const auditRepository = new AuditRepository();

  const effectGuard = createEffectGuard(reservationsRepository);
  const durableRuns = createDurableRunPort(
    workflowsRepository,
    evidenceRepository,
    reservationsRepository,
    workflowsRepository,
  );
  const approvalReads = createApprovalReadPort(approvalsRepository);
  const handoffs = createCareHandoffPort(careHandoffsRepository);

  let ownedRedis: RuntimeRedisClient | null = null;
  const redisConfig = options?.redis === undefined ? redisConfiguration(env) : null;
  if (options?.redis === undefined && redisConfig !== null) {
    ownedRedis = createRuntimeRedisClient(redisConfig);
  }
  const redis = options?.redis ?? ownedRedis;

  const unbound_ports: string[] = [];

  const startRunPort = createStartRunPort({
    guard: effectGuard,
    workflows: workflowsRepository,
    ids: systemIdentifiers,
    clock: systemClock,
  });

  const runs: RunPort = {
    ...startRunPort,
    ...durableRuns,
  };

  const approvals: ApprovalPort = {
    ...approvalReads,
    ...createApprovalDecisionPort(approvalsRepository),
  };

  const takeover: TakeoverLeasePort =
    redis === null
      ? {
          acquire: async () => unbound('takeover.acquire', 'no Redis lease store is configured'),
          renew: async () => unbound('takeover.renew', 'no Redis lease store is configured'),
          release: async () => unbound('takeover.release', 'no Redis lease store is configured'),
          holder: async () => unbound('takeover.holder', 'no Redis lease store is configured'),
        }
      : createTakeoverLeasePort(redis, systemClock);
  if (redis === null) {
    unbound_ports.push('takeover.acquire/renew/release/holder');
  }

  /**
   * The telemetry stream. Nothing is instrumented in this build, so the subscription ends
   * immediately rather than emitting invented frames: an empty stream is the truthful projection of
   * a source that has produced nothing (`06` §8.1.2 R09).
   */
  const streams: StreamPort = {
    subscribe: (input) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<never> {
        // The signal is observed so a closed socket cannot keep a generator alive.
        if (input.signal.aborted) return;
        await Promise.resolve();
      },
    }),
  };

  /** SCR-001 metrics with no upstream source are reported `NOT_INSTRUMENTED` (`06` §8.1.3 R17). */
  const kpi: KpiPort = {
    snapshot: async (input) => ({
      window: input.window ?? '24h',
      timezone: input.timezone ?? 'UTC',
      observed_at: systemClock().toISOString(),
      // No metric source is instrumented in this build, so the snapshot is truthful and empty
      // rather than populated with plausible numbers, and the cursor is absent for the same reason.
      metrics: [],
      cursor: null,
    }),
  };

  const identity: IdentityPort = createIdentityPort();

  const audit: GatewayAuditPort = {
    record: async (input) => {
      // The gateway's per-operation row joins the same chained table the engine writes, so a tenant
      // has one process-event chain rather than two (`08` §4.1).
      //
      // Vocabulary note, recorded as an unresolved dependency rather than papered over: the stored
      // row is typed with an agent identity and an authority level, and neither vocabulary has a
      // member that means "the platform produced this row". `HUMAN_HANDOFF` is the only
      // non-agent member of `PlatformAgentId`, and `AUTH-0` is the lowest clearance, so a gateway
      // operation is recorded with those two and its true principal is carried in `context`. A
      // dedicated platform identity in `04`'s vocabulary would remove the approximation.
      await auditRepository.append({
        run_id: input.correlation_id,
        tenant_id: input.tenant_id,
        agent_id: 'HUMAN_HANDOFF',
        customer_or_entity_id: input.operator_id ?? input.principal_kind,
        trigger: 'gateway',
        context: {
          principal_kind: input.principal_kind,
          operation: input.operation,
          ...(input.operator_id === undefined ? {} : { operator_id: input.operator_id }),
        },
        skill: input.operation,
        tool: 'gateway',
        decision: { outcome: input.outcome, error_code: input.error_code ?? null },
        authority: 'AUTH-0',
        approval: null,
        action: null,
        execution_status: input.outcome === 'ACCEPTED' ? 'success' : 'denied',
        evidence: null,
        outcome: input.detail ?? null,
        latency_ms: 0,
        cost: null,
        error: input.error_code === undefined ? null : { code: input.error_code },
      });
    },
  };

  const runtime: GatewayRuntime = {
    conversations: createConversationPort(conversationsRepository, { session_secret }),
    takeover,
    handoffs,
    runs,
    approvals,
    events: createEventPort(eventsRepository),
    timeline: createEventPort(eventsRepository),
    streams,
    kpi,
    identity,
    webhooks: createWebhookVerificationPort({
      channelSecrets:
        options?.channelSecrets ??
        ({
          resolve: async () => null,
          resolvePlatform: async () => platform_secret,
        } satisfies ChannelSecretStore),
      hmac,
    }),
    audit,
    receipts: createReceiptPort(effectGuard),
    effects: effectGuard,
    clock: systemClock,
    ids: systemIdentifiers,
  };

  return {
    runtime,
    credentials: options?.credentials ?? createCredentialStore({ operators: [], sessions: [], widgets: [] }),
    normalizer: createCanonicalEventNormalizer(),
    unbound: unbound_ports,
    enabledModules,
    salesSignalEventTypes,
    marketingSignalEventTypes,
    close: async () => {
      if (ownedRedis !== null) {
        await ownedRedis.quit();
      }
    },
  };
}

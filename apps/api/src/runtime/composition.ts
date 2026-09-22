/**
 * @file The composition root: the one place where ports meet implementations (implement/02 §2,
 * `06` §10.1).
 *
 * Every binding is explicit, and a binding that does not exist is **not** substituted. A port with
 * no implementation in this build answers a typed `*_UNAVAILABLE` refusal at request time and is
 * named loudly at composition time, so an operator learns which capability is missing instead of
 * receiving a plausible-looking value the platform never observed. Nothing here decides business
 * policy: the reservation protocol, the approval compare-and-set, the evidence chain and the
 * process-event chain all remain with the repository that owns their table.
 *
 * The real runtime path this assembles is:
 *
 *     route -> authenticate -> port -> { orchestrator -> PEP -> skill registry -> adapter }
 *                                     -> durable repository -> connector registry
 */

import { ConnectorRegistry, type EventAliasNormalizer, type HmacSha256Hex } from '@agentos/adapters';
import {
  AuditRepository,
  ConversationRepository,
  CustomerEventRepository,
  EffectReservationRepository,
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
import { createCredentialStore, type CredentialStore } from '../gateway/principal.js';
import {
  createCanonicalEventNormalizer,
  createWebhookVerificationPort,
  nodeHmacSha256Hex,
  type ChannelSecretStore,
} from './adapters.js';
import {
  createConversationPort,
  createEffectGuard,
  createEventPort,
  createReceiptPort,
  systemClock,
  systemIdentifiers,
} from './bindings.js';

/**
 * A capability this build does not bind.
 *
 * Raised when a route reaches a port whose implementation is absent — after planning, after policy
 * and after any reservation, so the refusal never leaves a half-applied effect behind. It is not a
 * fallback: no value is returned, nothing is cached, and the operator sees exactly which
 * capability is missing.
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
}

/** The assembled gateway: the routes' runtime, the credential store and the derivation binding. */
export interface GatewayComposition {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly normalizer: EventAliasNormalizer;
  /** Capabilities this build does not bind, named for the boot log and the report. */
  readonly unbound: readonly string[];
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
  },
): GatewayComposition {
  const { session_secret, platform_secret } = resolveSecrets(env);
  const hmac = options?.hmac ?? nodeHmacSha256Hex;

  const conversationsRepository = new ConversationRepository();
  const eventsRepository = new CustomerEventRepository();
  const reservationsRepository = new EffectReservationRepository();
  const auditRepository = new AuditRepository();

  const effectGuard = createEffectGuard(reservationsRepository);

  const unbound_ports: string[] = [];

  /**
   * The run port. `start` and the read side require the orchestrator's signal path, which this
   * build does not assemble (no agent runtime, no context aggregator, no policy binding is
   * composed), so every method refuses with the capability name instead of returning a fabricated
   * run.
   */
  const runs: RunPort = {
    start: async () => unbound('runs.start', 'the orchestrator signal path is not composed'),
    read: async () => unbound('runs.read', 'the durable task projection is not composed'),
    classifyRetry: async () => unbound('runs.classifyRetry', 'failure classification is not composed'),
    retry: async () => unbound('runs.retry', 'the re-queue path is not composed'),
    reconcile: async () => unbound('runs.reconcile', 'the reconciliation settlement is not composed'),
    list: async () => unbound('runs.list', 'the run read model is not composed'),
  };
  unbound_ports.push('runs.start/read/classifyRetry/retry/reconcile/list');

  /**
   * The approval port. The decision path is `claimApprovalAndResume` on the repository, but it
   * needs the stored action draft that only an approval read can supply, and this build composes no
   * approval read model — so the decision is refused rather than reconstructed from a guess.
   */
  const approvals: ApprovalPort = {
    list: async () => unbound('approvals.list', 'the approval queue projection is not composed'),
    detail: async () => unbound('approvals.detail', 'the approval detail read is not composed'),
    decide: async () => unbound('approvals.decide', 'the approval decision read model is not composed'),
  };
  unbound_ports.push('approvals.list/detail/decide');

  const takeover: TakeoverLeasePort = {
    acquire: async () => unbound('takeover.acquire', 'no lease store is bound in this build'),
    renew: async () => unbound('takeover.renew', 'no lease store is bound in this build'),
    release: async () => unbound('takeover.release', 'no lease store is bound in this build'),
    holder: async () => unbound('takeover.holder', 'no lease store is bound in this build'),
  };
  unbound_ports.push('takeover.acquire/renew/release/holder');

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

  const identity: IdentityPort = {
    resolveCustomer: async () => unbound('identity.resolveCustomer', 'identity resolution is not composed'),
  };
  unbound_ports.push('identity.resolveCustomer');

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
    close: async () => {
      await Promise.resolve();
    },
  };
}

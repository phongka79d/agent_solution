/**
 * @file Cross-domain handoff broker (implement/04 §8, plans/customer-lifecycle.md §3).
 *
 * Invariants:
 *  * The broker reads the durable lifecycle cursor before deriving a package and never trusts a
 *    caller-supplied version, hop count or visited-domain history.
 *  * Every target run is admitted through the database reservation and durable-task admission; this
 *    module does not create a queue, orchestrator or effect subsystem of its own.
 *  * Admission refusals are fail-closed. CONFLICT and RECONCILE_REQUIRED never become fabricated
 *    success responses, and guard errors retain their HANDOFF_* code.
 *  * The Customer 360 timeline append is best effort after ADMITTED only. Its source-event key is
 *    the handoff idempotency key, so an append failure cannot turn an admitted handoff into a
 *    failure and a later replay never appends a second timeline event.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  EFFECT_RESERVATION_TTL_MS,
  JOURNEY_DOMAIN_MODULES,
  OrchestratorError,
  assertHandoffAdmissible,
  createCrossDomainHandoffPackage,
  isJourneyDomain,
  type CrossDomainHandoffDraft,
  type CrossDomainHandoffPackage,
  type HandoffLifecycleRef,
  type ICrossDomainHandoffBroker,
  type JourneyDomain,
  type JourneyLifecycleState,
} from '@agentos/core-engine';
import { canonicalizeJson } from '@agentos/core-engine';
import {
  admitCrossDomainHandoff,
  readCrossDomainLifecycle,
  type AdmitCrossDomainHandoffInput,
  type AppendCustomerEventInput,
  type CrossDomainLifecycleRecord,
} from '@agentos/database';

type CustomerEventAppendInput = AppendCustomerEventInput;

type HandoffRepository = {
  readonly readCrossDomainLifecycle: typeof readCrossDomainLifecycle;
};

type EventRepository = {
  append(input: CustomerEventAppendInput): Promise<{
    readonly inserted: boolean;
    readonly event_id: string | null;
  }>;
};

export interface CrossDomainHandoffBrokerOptions {
  readonly handoffRepository: HandoffRepository;
  readonly admit?: typeof admitCrossDomainHandoff;
  readonly readLifecycle?: typeof readCrossDomainLifecycle;
  readonly eventRepository?: EventRepository;
  readonly reservation_ttl_ms?: number;
  readonly now?: () => Date;
}

const LIFECYCLE_STATES: readonly JourneyLifecycleState[] = Object.freeze([
  'ENTERED',
  'IN_PROGRESS',
  'HANDED_OFF',
  'COMPLETED',
]);

function lifecycleState(value: string): JourneyLifecycleState {
  if ((LIFECYCLE_STATES as readonly string[]).includes(value)) {
    return value as JourneyLifecycleState;
  }
  throw new OrchestratorError(
    'HANDOFF_LIFECYCLE_INVALID',
    `Durable lifecycle state '${value}' is not a known journey state (implement/04 §8).`,
  );
}

interface DurableJourneyFacts {
  readonly lifecycle: HandoffLifecycleRef | null;
  readonly visited_domains: readonly JourneyDomain[];
  readonly previous_hop_count: number;
}

function readDurableJourneyFacts(record: CrossDomainLifecycleRecord | null): DurableJourneyFacts {
  if (record === null) {
    return { lifecycle: null, visited_domains: [], previous_hop_count: 0 };
  }

  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new OrchestratorError(
      'HANDOFF_LIFECYCLE_INVALID',
      `Durable lifecycle version '${String(record.version)}' is not a positive integer `
        + '(implement/04 §8).',
    );
  }
  if (!Number.isInteger(record.hop_count) || record.hop_count < 0) {
    throw new OrchestratorError(
      'HANDOFF_LIFECYCLE_INVALID',
      `Durable lifecycle hop_count '${String(record.hop_count)}' is not a non-negative integer `
        + '(implement/04 §8).',
    );
  }

  const visited_domains: JourneyDomain[] = [];
  for (const domain of record.domains) {
    if (!isJourneyDomain(domain)) {
      throw new OrchestratorError(
        'HANDOFF_LIFECYCLE_INVALID',
        `Durable lifecycle history contains unknown journey domain '${domain}' (implement/04 §8).`,
      );
    }
    visited_domains.push(domain);
  }

  return {
    lifecycle: { version: record.version, state: lifecycleState(record.state) },
    visited_domains,
    previous_hop_count: record.hop_count,
  };
}

function requestFingerprint(draft: CrossDomainHandoffDraft, pkg: CrossDomainHandoffPackage): string {
  return createHash('sha256')
    .update(
      canonicalizeJson({
        tenant_id: draft.tenant_id,
        customer_id: draft.customer_id,
        source_run_id: draft.source_run_id,
        source_domain: draft.source_domain,
        target_domain: draft.target_domain,
        target_agent: draft.target_agent,
        lifecycle_version: pkg.lifecycle.version,
        reason: draft.reason,
      }),
    )
    .digest('hex');
}

/**
 * Builds the target run's ORCHESTRATOR_HANDOFF signal without side effects or generated identity.
 */
export function buildCrossDomainHandoffSignal(
  pkg: CrossDomainHandoffPackage,
  session_id: string,
  signal_id: string,
): Record<string, unknown> {
  return {
    signal_id,
    tenant_id: pkg.tenant_id,
    correlation_id: pkg.correlation_id,
    source_channel: 'ORCHESTRATOR_HANDOFF',
    event_type: `handoff.${pkg.source_domain}_to_${pkg.target_domain}`,
    payload: {
      module: JOURNEY_DOMAIN_MODULES[pkg.target_domain],
      handoff: pkg,
      handoff_reason: pkg.reason,
    },
    subject: {
      session_id,
      channel_type: 'orchestrator',
      verified_customer_id: pkg.customer_id,
    },
    timestamp: pkg.occurred_at,
  };
}

function timelineEvent(pkg: CrossDomainHandoffPackage, session_id: string): CustomerEventAppendInput {
  return {
    tenant_id: pkg.tenant_id,
    source_event_id: pkg.idempotency_key,
    event_name: 'ext.lifecycle.handoff',
    session_id,
    customer_id: pkg.customer_id,
    occurred_at: pkg.occurred_at,
    channel: 'orchestrator',
    payload: {
      classification: pkg.classification,
      classification_authority: 'SERVER',
      evidence_reference: pkg.handoff_id,
      domain: pkg.target_domain,
      stage: 'HANDOFF',
      summary: pkg.reason,
      source_domain: pkg.source_domain,
      target_domain: pkg.target_domain,
      lifecycle_version: pkg.lifecycle.version,
    },
  };
}

/** Creates the durable, fail-closed broker for one worker composition root. */
export function createCrossDomainHandoffBroker(
  options: CrossDomainHandoffBrokerOptions,
): ICrossDomainHandoffBroker {
  const admit = options.admit ?? admitCrossDomainHandoff;
  const readLifecycle = options.readLifecycle ?? options.handoffRepository.readCrossDomainLifecycle;
  const reservation_ttl_ms = options.reservation_ttl_ms ?? EFFECT_RESERVATION_TTL_MS;
  const now = options.now ?? (() => new Date());

  return {
    async admit(draft): Promise<ReturnType<ICrossDomainHandoffBroker['admit']> extends Promise<infer T> ? T : never> {
      const durable = readDurableJourneyFacts(await readLifecycle(draft.tenant_id, draft.customer_id));
      const pkg = createCrossDomainHandoffPackage({
        ...draft,
        previous_lifecycle: durable.lifecycle,
        previous_hop_count: durable.previous_hop_count,
        visited_domains: durable.visited_domains,
      });

      assertHandoffAdmissible(pkg, {
        tenant_id: draft.tenant_id,
        customer_id: draft.customer_id,
        lifecycle: durable.lifecycle,
        visited_domains: durable.visited_domains,
        previous_hop_count: durable.previous_hop_count,
        source_authority: draft.source_authority,
      });

      const session_id = draft.source_run_id;
      const input: AdmitCrossDomainHandoffInput = {
        tenant_id: draft.tenant_id,
        customer_id: draft.customer_id,
        correlation_id: draft.correlation_id,
        idempotency_key: pkg.idempotency_key,
        request_fingerprint: requestFingerprint(draft, pkg),
        source_domain: pkg.source_domain,
        source_agent: pkg.source_agent,
        source_run_id: pkg.source_run_id,
        target_domain: pkg.target_domain,
        target_agent: pkg.target_agent,
        target_module: JOURNEY_DOMAIN_MODULES[pkg.target_domain],
        reason: pkg.reason,
        classification: pkg.classification,
        evidence: pkg.evidence,
        lifecycle_state: pkg.lifecycle.state,
        lifecycle_version: pkg.lifecycle.version,
        hop_count: pkg.hop_count,
        visited_domains: pkg.visited_domains,
        occurred_at: pkg.occurred_at,
        run_id: randomUUID(),
        signal: buildCrossDomainHandoffSignal(pkg, session_id, randomUUID()),
        reservation_ttl_ms,
        now,
      };
      const admission = await admit(input);

      if (admission.kind === 'CONFLICT' || admission.kind === 'RECONCILE_REQUIRED') {
        throw new OrchestratorError(
          'HANDOFF_ADMISSION_UNRESOLVED',
          `Durable handoff admission returned ${admission.kind}; refusing fabricated success `
            + '(implement/04 §8).',
        );
      }

      const result = {
        handoff_id: admission.handoff_id,
        target_run_id: admission.run_id,
        admitted: admission.kind === 'ADMITTED',
        lifecycle: pkg.lifecycle,
      };

      if (admission.kind === 'ADMITTED' && options.eventRepository !== undefined) {
        try {
          await options.eventRepository.append(timelineEvent(pkg, session_id));
        } catch {
          // The handoff is already durable. The source-event id makes a later explicit append safe.
        }
      }

      return result;
    },
  };
}

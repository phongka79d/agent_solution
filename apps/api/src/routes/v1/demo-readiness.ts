/**
 * Local/CI demo capability readiness and tenant-scoped run trace projections.
 *
 * The route owns authentication, DEMO_MODE gating and redaction. Composition owns the facts: it
 * must inject a tenant-scoped readiness projection and the durable run-stage repository adapter.
 * There is deliberately no environment fallback here; an absent or unbound adapter cannot become a
 * green status by guessing from process variables.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  ProviderCallLedgerRecord,
  RunStageEventRecord,
} from '@agentos/database';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requirePrincipal, requireOperator } from '../../gateway/principal.js';
import type { GatewayPrincipal } from '../../gateway/contracts.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';

/** Probe states are source observations; the route never converts an absent probe into PASS. */
export const READINESS_PROBE_STATES = ['PASS', 'FAILED', 'NOT_RUN', 'UNBOUND'] as const;
export type ReadinessProbeState = (typeof READINESS_PROBE_STATES)[number];

/** Connector classes deliberately distinguish a local synthetic source from a live one. */
export const CONNECTOR_CLASSES = ['DEMO_MOCK', 'UNBOUND', 'LIVE'] as const;
export type ConnectorClass = (typeof CONNECTOR_CLASSES)[number];

export interface DemoProviderReadiness {
  readonly provider: string | null;
  readonly configured: boolean;
  readonly probe: ReadinessProbeState;
  readonly models: readonly {
    readonly model: string;
    readonly configured: boolean;
    readonly probe: ReadinessProbeState;
  }[];
}

export interface DemoConnectorReadiness {
  readonly class: ConnectorClass;
  readonly probe: ReadinessProbeState;
}

export interface DemoLedgerReadiness {
  readonly status: 'OBSERVED' | 'UNAVAILABLE';
  readonly stage_event_count: number | null;
  readonly provider_call_count: number | null;
}

/**
 * A sanitized source projection. Implementations must derive this from actual configured/probed
 * state and tenant-scoped database observations; raw env values, URLs and secrets do not belong in
 * this contract.
 */
export interface DemoReadinessSnapshot {
  readonly observed_at: string;
  readonly provider: DemoProviderReadiness;
  readonly connectors: {
    readonly erp: DemoConnectorReadiness;
    readonly events: DemoConnectorReadiness;
  };
  readonly ledger: DemoLedgerReadiness;
}

export interface DemoReadinessPort {
  snapshot(input: { readonly tenant_id: string }): Promise<DemoReadinessSnapshot>;
}

/** The read-only methods implemented by the database RunStageEventsRepository adapter. */
export interface RunTracePort {
  listStageEvents(
    tenant_id: string,
    run_id: string,
  ): Promise<readonly RunStageEventRecord[]>;
  listProviderCalls(
    tenant_id: string,
    run_id: string,
  ): Promise<readonly ProviderCallLedgerRecord[]>;
}

export interface DemoReadinessRouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /** Set by composition from validated APP_ENV/DEMO_MODE; no route-level env fallback exists. */
  readonly demoMode: boolean;
  readonly readiness: DemoReadinessPort;
  readonly trace: RunTracePort;
}

/** Authorizes a platform-scope platform admin or `run:read` operator. */
function requireTraceOperator(request: FastifyRequest): GatewayPrincipal {
  const principal = requirePrincipal(request);
  const canReadTrace =
    principal.scope === 'platform' &&
    principal.kind === 'OPERATOR' &&
    (principal.permissions.includes('platform:admin') || principal.permissions.includes('run:read'));
  if (!canReadTrace) {
    fail(
      'INSUFFICIENT_AUTHORITY',
      'the authenticated platform-scope operator must hold platform:admin or run:read for a run trace',
    );
  }
  return principal;
}

function assertReadinessState(value: unknown): asserts value is ReadinessProbeState {
  if (typeof value !== 'string' || !(READINESS_PROBE_STATES as readonly string[]).includes(value)) {
    fail('INTERNAL_ERROR', 'the readiness source returned an unsupported probe state');
  }
}

function assertConnectorClass(value: unknown): asserts value is ConnectorClass {
  if (typeof value !== 'string' || !(CONNECTOR_CLASSES as readonly string[]).includes(value)) {
    fail('INTERNAL_ERROR', 'the readiness source returned an unsupported connector class');
  }
}

function assertObservedCount(value: unknown, field: string): asserts value is number | null {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('INTERNAL_ERROR', `the readiness source returned an invalid ${field}`);
  }
}

function projectReadiness(snapshot: DemoReadinessSnapshot): Record<string, unknown> {
  assertReadinessState(snapshot.provider.probe);
  if (typeof snapshot.provider.configured !== 'boolean') {
    fail('INTERNAL_ERROR', 'the readiness source returned an invalid provider configuration state');
  }
  if (snapshot.provider.provider !== null && typeof snapshot.provider.provider !== 'string') {
    fail('INTERNAL_ERROR', 'the readiness source returned an invalid provider identifier');
  }

  const models = snapshot.provider.models.map((model) => {
    if (typeof model.model !== 'string' || model.model.length === 0 || model.model.length > 256) {
      fail('INTERNAL_ERROR', 'the readiness source returned an invalid model identifier');
    }
    if (typeof model.configured !== 'boolean') {
      fail('INTERNAL_ERROR', 'the readiness source returned an invalid model configuration state');
    }
    assertReadinessState(model.probe);
    return {
      model: model.model,
      configured: model.configured,
      probe: model.probe,
    };
  });

  const connectors = [snapshot.connectors.erp, snapshot.connectors.events];
  for (const connector of connectors) {
    assertConnectorClass(connector.class);
    assertReadinessState(connector.probe);
  }

  if (snapshot.ledger.status !== 'OBSERVED' && snapshot.ledger.status !== 'UNAVAILABLE') {
    fail('INTERNAL_ERROR', 'the readiness source returned an invalid ledger state');
  }
  assertObservedCount(snapshot.ledger.stage_event_count, 'stage event count');
  assertObservedCount(snapshot.ledger.provider_call_count, 'provider call count');

  const ledger =
    snapshot.ledger.status === 'OBSERVED'
      ? {
          status: snapshot.ledger.status,
          stage_event_count: snapshot.ledger.stage_event_count,
          provider_call_count: snapshot.ledger.provider_call_count,
        }
      : {
          status: snapshot.ledger.status,
          stage_event_count: null,
          provider_call_count: null,
        };

  // Explicit field selection is the redaction boundary: no URL, key, raw probe error, or other
  // source-owned fields can be copied into a response accidentally.
  return {
    demo_mode: true,
    observed_at: snapshot.observed_at,
    provider: {
      provider: snapshot.provider.provider,
      configured: snapshot.provider.configured,
      probe: snapshot.provider.probe,
      models,
    },
    connectors: {
      erp: { class: snapshot.connectors.erp.class, probe: snapshot.connectors.erp.probe },
      events: { class: snapshot.connectors.events.class, probe: snapshot.connectors.events.probe },
    },
    ledger,
  };
}

function evidenceRefCount(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length : null;
}

function projectStages(events: readonly RunStageEventRecord[]): readonly Record<string, unknown>[] {
  return events.map((event) => ({
    attempt_ordinal: event.attempt_ordinal,
    step_index: event.step_index,
    stage: event.stage,
    entered_at: event.entered_at,
    evidence_ref_count: evidenceRefCount(event.evidence_refs),
  }));
}

function projectProviderCalls(calls: readonly ProviderCallLedgerRecord[]): readonly Record<string, unknown>[] {
  return calls.map((call) => ({
    step_index: call.step_index,
    stage: call.stage,
    call_index: call.call_index,
    provider: call.provider,
    model: call.model,
    status: call.observed_status,
    latency_ms: call.latency_ms,
    prompt_tokens: call.prompt_tokens,
    completion_tokens: call.completion_tokens,
    cached_tokens: call.cached_tokens,
    recorded_at: call.recorded_at,
  }));
}

function runIdOf(request: FastifyRequest<{ Params: { run_id: string } }>): string {
  const run_id = request.params.run_id;
  if (typeof run_id !== 'string' || run_id.trim().length === 0 || run_id.length > 64) {
    fail('VALIDATION_FAILED', 'run_id must be a non-empty bounded identifier');
  }
  return run_id;
}

/** Registers local demo readiness and the redacted tenant-scoped run trace projection. */
export function registerDemoReadinessRoutes(
  app: FastifyInstance,
  deps: DemoReadinessRouteDependencies,
): void {
  const preHandler = authenticate(deps);

  app.get('/demo/readiness', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'platform:admin');
      if (principal.scope !== 'platform') {
        fail('INSUFFICIENT_AUTHORITY', 'the authenticated operator must have platform scope for demo readiness');
      }
      if (!deps.demoMode) {
        fail('CAPABILITY_NOT_ENABLED', 'demo readiness is available only when DEMO_MODE is enabled');
      }
      const snapshot = await deps.readiness.snapshot({ tenant_id: principal.tenant_id });
      const projection = projectReadiness(snapshot);

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'demo.readiness',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: {
          ledger_status: snapshot.ledger.status,
          stage_event_count: snapshot.ledger.stage_event_count,
          provider_call_count: snapshot.ledger.provider_call_count,
        },
      });

      return reply.code(200).send(projection);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.get<{ Params: { run_id: string } }>('/demo/readiness/runs/:run_id/trace', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireTraceOperator(request);
      const run_id = runIdOf(request);

      // The durable run projection is the first tenant fence. A missing row is deliberately the same
      // response for a wrong-tenant identifier; no trace repository call is made in that case.
      const run = await runtime.runs.read({ tenant_id: principal.tenant_id, run_id });
      if (run === null) fail('TASK_NOT_FOUND', 'this tenant holds no durable task with that identifier');

      const [stageEvents, providerCalls] = await Promise.all([
        deps.trace.listStageEvents(principal.tenant_id, run_id),
        deps.trace.listProviderCalls(principal.tenant_id, run_id),
      ]);
      const stages = projectStages(stageEvents);
      const calls = projectProviderCalls(providerCalls);
      const response = {
        run_id,
        lifecycle_state: run.lifecycle_state,
        stages,
        provider_calls: calls,
        observed_counts: {
          stage_events: stages.length,
          provider_calls: calls.length,
        },
      };

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'runs.trace',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: response.observed_counts,
      });

      return reply.code(200).send(response);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

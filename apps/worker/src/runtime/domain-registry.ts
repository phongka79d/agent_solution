/**
 * @file Domain runtime registry and signal contracts.
 *
 * Provides a domain-neutral registry for signal acceptance and orchestrator factory resolution.
 */

import type { RevenueOrchestrator } from '@agentos/core-engine';

export interface DomainSignalContract {
  readonly module: string;
  readonly source_channels: readonly string[];
  readonly event_types: readonly string[];
  readonly signal_invalid_code: string;
}

export interface DomainRuntimeBinding {
  readonly contract: DomainSignalContract;
  readonly createOrchestrator: (
    tenant_id: string,
  ) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
}

export interface DomainRuntimeRegistry {
  resolve(module: string): DomainRuntimeBinding | null;
  accepts(
    signal: unknown,
    context?: { readonly tenant_id?: string; readonly correlation_id?: string },
  ): DomainRuntimeBinding | null;
  modules(): readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Creates a domain runtime registry from the provided bindings.
 * Unknown modules return null; it must never throw for an unknown module.
 */
export function createDomainRuntimeRegistry(
  bindings: readonly DomainRuntimeBinding[],
): DomainRuntimeRegistry {
  const bindingMap = new Map<string, DomainRuntimeBinding>();
  for (const b of bindings) {
    bindingMap.set(b.contract.module, b);
  }

  return {
    resolve(module: string): DomainRuntimeBinding | null {
      return bindingMap.get(module) ?? null;
    },

    accepts(
      signal: unknown,
      context?: { readonly tenant_id?: string; readonly correlation_id?: string },
    ): DomainRuntimeBinding | null {
      const signalRecord = asRecord(signal);
      if (!signalRecord) return null;

      const tenantId = signalRecord['tenant_id'];
      if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
      if (context?.tenant_id !== undefined && tenantId !== context.tenant_id) return null;

      const correlationId = signalRecord['correlation_id'];
      if (typeof correlationId !== 'string' || correlationId.length === 0) return null;
      if (context?.correlation_id !== undefined && correlationId !== context.correlation_id) return null;

      const signalId = signalRecord['signal_id'];
      if (typeof signalId !== 'string' || signalId.length === 0) return null;

      const sourceChannel = signalRecord['source_channel'];
      if (typeof sourceChannel !== 'string') return null;

      const eventType = signalRecord['event_type'];
      if (typeof eventType !== 'string') return null;

      const payload = asRecord(signalRecord['payload']);
      if (!payload) return null;

      const mod = payload['module'];
      if (typeof mod !== 'string') return null;

      const binding = bindingMap.get(mod);
      if (!binding) return null;

      if (!binding.contract.source_channels.includes(sourceChannel)) return null;
      if (!binding.contract.event_types.includes(eventType)) return null;

      // A channel and an event type are declared independently, so the pair is constrained here: a
      // brokered handoff travels ONLY on the internal channel, and that channel carries ONLY
      // handoff events. Without this, a delivery naming `handoff.<leg>` on a customer-facing channel
      // would resolve to a domain binding and be treated as an orchestrator-brokered leg.
      const isHandoffEvent = eventType.startsWith('handoff.');
      const isHandoffChannel = sourceChannel === 'ORCHESTRATOR_HANDOFF';
      if (isHandoffEvent !== isHandoffChannel) return null;

      return binding;
    },

    modules(): readonly string[] {
      return Object.freeze(Array.from(bindingMap.keys()));
    },
  };
}

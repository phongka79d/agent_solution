import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

/**
 * Resource class a connector occupies. The taxonomy is closed because the composition root binds
 * exactly three ingress shapes: a system of record (read/write truth), an event stream (append-only
 * observations) and a communication channel (outbound/inbound messages).
 */
export type ConnectorKind = 'SYSTEM_OF_RECORD' | 'EVENT_STREAM' | 'COMMUNICATION';

/**
 * Static, auditable identity of one connector. It is deliberately data, not behavior: an operator can
 * read a descriptor to learn what the platform may reach without executing any provider code.
 *
 * `provider` names remain illustrative **provider choices that are `[UNCONFIRMED][ASM-001]`** until the
 * connector audit closes (06 §2); the registry never infers a provider from a connector id.
 */
export interface ConnectorDescriptor {
  /** Stable connector identifier, e.g. `'API-001'` — the `adapter_target` a `PlannedStep` names. */
  readonly connector_id: string;
  readonly kind: ConnectorKind;
  /** Vendor/product behind the connector; `[UNCONFIRMED][ASM-001]` until audited. */
  readonly provider: string;
  /** Read resource groups this connector serves; empty means dispatch-only. */
  readonly read_resources: readonly string[];
}

/**
 * One provider-observed read, shaped so the caller can persist it as evidence without parsing a
 * vendor payload. `observed_at` is the **provider's** observation time, never a local clock reading:
 * a value whose observation time is unknown must be refused, because a timestamp fabricated here
 * would date a fact the platform never saw.
 */
export interface ConnectorReadResult {
  readonly resource: string;
  readonly value: Record<string, unknown>;
  /** Provider-reported observation time (ISO 8601), copied verbatim from the provider envelope. */
  readonly observed_at: string;
  /** Tenant the read was scoped to, echoed so a stored result can never drift out of its tenant. */
  readonly tenant_id: string;
}

/**
 * Everything the platform is allowed to do with one registered connector. `read` is optional because
 * a channel or payment connector may legitimately expose dispatch only; an absent `read` is reported
 * as "unsupported" by the caller, never emulated.
 */
export interface RegisteredConnector {
  readonly descriptor: ConnectorDescriptor;
  readonly dispatch: (draft: ActionDraft) => Promise<ExecutionReceipt>;
  readonly read?: (input: {
    readonly tenant_id: string;
    readonly resource: string;
    readonly key?: string;
  }) => Promise<ConnectorReadResult>;
}

/**
 * Thrown by `resolve` for an id that was never registered. An unknown connector is a refusal: the
 * platform fails closed rather than falling back to a default transport, because a default transport
 * would send an authorized action to a provider the operator never approved.
 */
export class UnknownConnectorError extends Error {
  /** The id that failed to resolve, kept on the error so audit rows can record it verbatim. */
  readonly connector_id: string;

  constructor(connector_id: string) {
    super(`no connector registered for '${connector_id}'`);
    this.name = 'UnknownConnectorError';
    this.connector_id = connector_id;
  }
}

/**
 * Thrown by `register` when a `connector_id` is claimed twice. Two behaviors behind one id would make
 * the target of an authorized action depend on registration order, so the collision is a programming
 * error surfaced at composition time instead of being silently overwritten.
 */
export class DuplicateConnectorError extends Error {
  /** The id claimed twice. */
  readonly connector_id: string;

  constructor(connector_id: string) {
    super(`connector '${connector_id}' is already registered`);
    this.name = 'DuplicateConnectorError';
    this.connector_id = connector_id;
  }
}

/**
 * The single binding table from `adapter_target` to transport behavior.
 *
 * The composition root constructs it and populates it explicitly; the registry NEVER reads the
 * environment, a file or a built-in default list, so what the platform can reach is exactly what the
 * root registered and nothing else. An empty registry resolves nothing — there is no fallback
 * connector and no default `dispatch`.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, RegisteredConnector>();

  /**
   * Binds one connector.
   *
   * @param connector Descriptor plus behavior; `descriptor.connector_id` is the resolution key.
   * @throws DuplicateConnectorError when the id is already bound (see the class doc for why).
   */
  register(connector: RegisteredConnector): void {
    const { connector_id } = connector.descriptor;
    if (this.connectors.has(connector_id)) {
      throw new DuplicateConnectorError(connector_id);
    }
    this.connectors.set(connector_id, connector);
  }

  /**
   * Resolves the connector bound to an id.
   *
   * @throws UnknownConnectorError when the id is unregistered — fail closed, never a default port.
   */
  resolve(connector_id: string): RegisteredConnector {
    const connector = this.connectors.get(connector_id);
    if (connector === undefined) {
      throw new UnknownConnectorError(connector_id);
    }
    return connector;
  }

  /** Whether an id is bound; lets a caller report an unsupported target without catching. */
  has(connector_id: string): boolean {
    return this.connectors.has(connector_id);
  }

  /** Bound ids in registration order, so diagnostics are stable across runs. */
  ids(): readonly string[] {
    return [...this.connectors.keys()];
  }
}

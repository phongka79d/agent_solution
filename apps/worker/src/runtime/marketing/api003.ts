/**
 * @file Marketing-specific API-003 outbound connector binding.
 *
 * Provides explicit injected provider transport, credential, and tenant binding for API-003
 * communication dispatch (SRS §15 / API-003, implement/06 §4.0-§4.2, implement/05 §4.1).
 *
 * Architectural invariants:
 * 1. Fail-closed: Absent credentials, provider, or tenant binding exposes an unbound/refusal state,
 *    never a fake success. Unregistered connector targets are refused before transport.
 * 2. Strict tenant isolation: The connector binds to exactly one tenant; any dispatch or reconcile
 *    attempt with a mismatched or missing tenant_id is refused before contacting transport.
 * 3. Exact payload preservation: action_id, action_revision, effect_key, tenant_id, and the exact
 *    payload are validated and preserved without mutation or data loss.
 * 4. Grounded receipts: Provider receipts are returned ONLY when transport confirms them.
 *    Timeouts and unconfirmed outcomes are classified as TIMEOUT/UNKNOWN for downstream reconciliation;
 *    never reported as success.
 * 5. Single connector identity: Exactly one connector ID is registered per binding. No aliases
 *    or fallback routes that could make an unapproved target reachable.
 */

import type {
  ActionDraft,
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import {
  type AdapterPort,
  type ChannelId,
  ConnectorRegistry,
  createAdapterDispatcher,
  DuplicateConnectorError,
} from '@agentos/adapters';

/** Fixed, non-overridable canonical Marketing row API-003 communication connector target identifier. */
export const API003_CONNECTOR_ID = 'API-003.CommunicationConnector';
export const DEFAULT_API003_CONNECTOR_ID = API003_CONNECTOR_ID;

/**
 * Baseline and extension channels supported by API-003 (implement/06 §4.0).
 * Baseline: WEB_CHAT, APP_CHAT, MESSENGER, TIKTOK, ZALO, EMAIL, SMS.
 * Extension (ASM-001 gated): LINE, WHATSAPP, INSTAGRAM.
 */
export const SUPPORTED_API003_CHANNELS: readonly ChannelId[] = Object.freeze([
  'WEB_CHAT',
  'APP_CHAT',
  'MESSENGER',
  'INSTAGRAM',
  'TIKTOK',
  'ZALO',
  'EMAIL',
  'SMS',
  'LINE',
  'WHATSAPP',
]);

/**
 * Opaque provider credentials injected from host configuration/secret manager.
 * The connector treats credentials as opaque and never defaults, inspects, or logs them.
 */
export type Api003Credentials = unknown;

/** Normalized outbound request passed to the injected transport. */
export interface Api003OutboundDispatchInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly action_id: string;
  readonly action_revision: number;
  readonly channel: ChannelId;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provider: string;
  readonly credentials: Api003Credentials;
}

/** Result returned by the injected transport. */
export type Api003TransportDispatchResult =
  | {
      readonly ok: true;
      /** Provider-confirmed ExecutionReceipt directly from the transport. */
      readonly receipt: ExecutionReceipt;
    }
  | {
      readonly ok: false;
      /**
       * 'TIMEOUT' when transport timed out.
       * 'UNKNOWN' when dispatch outcome is unknown / possible dispatch.
       * 'REJECTED' when provider explicitly returned an error / rejected request.
       */
      readonly failure_class: 'TIMEOUT' | 'UNKNOWN' | 'REJECTED';
      readonly error_message: string;
      readonly provider_status?: number | string | null;
      readonly response_payload?: Record<string, unknown>;
      readonly latency_ms?: number;
    };

/** Input to the injected transport reconcile method. */
export interface Api003ReconcileInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly action_id?: string;
  readonly provider: string;
  readonly credentials: Api003Credentials;
}

/** Result returned by the injected transport reconcile method. */
export type Api003ReconcileResult =
  | {
      readonly outcome: 'SUCCEEDED';
      /** Provider-confirmed ExecutionReceipt directly from the transport reconcile. */
      readonly receipt: ExecutionReceipt;
    }
  | {
      readonly outcome: 'FAILED';
      readonly response_payload?: Record<string, unknown>;
    }
  | {
      readonly outcome: 'INDETERMINATE';
      readonly error_message?: string;
      readonly response_payload?: Record<string, unknown>;
    };

/** Injected host transport for API-003 communication provider. */
export interface Api003OutboundTransport {
  dispatch(input: Api003OutboundDispatchInput): Promise<Api003TransportDispatchResult>;
  reconcile?(input: Api003ReconcileInput): Promise<Api003ReconcileResult>;
}

/** Explicit configuration required to bind an API-003 connector. */
export interface MarketingApi003Config {
  /** The tenant this connector binding is scoped to. */
  readonly tenant_id: string;
  /** Injected provider identity from host configuration. Required; never chosen, invented, or defaulted. */
  readonly provider: string;
  /** Injected provider credentials. Must be present (non-null and non-undefined). */
  readonly credentials: Api003Credentials;
  /** Injected provider transport. */
  readonly transport: Api003OutboundTransport;
}

/** Reason codes for API-003 connector refusals. */
export type Api003RefusalCode =
  | 'CONNECTOR_UNCONFIGURED'
  | 'CREDENTIALS_ABSENT'
  | 'PROVIDER_ABSENT'
  | 'TRANSPORT_ABSENT'
  | 'TENANT_MISMATCH'
  | 'TENANT_UNSCOPED'
  | 'ADAPTER_TARGET_MISMATCH'
  | 'INVALID_CHANNEL'
  | 'CHANNEL_ABSENT'
  | 'PAYLOAD_MALFORMED'
  | 'PAYLOAD_IDENTITY_MISMATCH'
  | 'EFFECT_KEY_MISSING'
  | 'ACTION_ID_MISSING';

/** Typed refusal error for fail-closed connector rejections. */
export class Api003RefusalError extends Error {
  readonly code: Api003RefusalCode;
  readonly connector_id: string;

  constructor(code: Api003RefusalCode, connector_id: string, message: string) {
    super(`${connector_id} [${code}]: ${message}`);
    this.name = 'Api003RefusalError';
    this.code = code;
    this.connector_id = connector_id;
  }
}

/** Checks whether credentials are provided (non-null and non-undefined). */
export function hasCredentials(credentials: unknown): boolean {
  return credentials !== undefined && credentials !== null;
}

/**
 * Marketing-specific API-003 outbound connector implementing AdapterPort.
 * Bound to an explicit tenant, provider, credentials, and transport.
 * Handles only the fixed 'API-003.CommunicationConnector' communication connector identity.
 */
export class MarketingApi003Connector implements AdapterPort {
  readonly adapterId = API003_CONNECTOR_ID;
  readonly isConfigured: boolean;
  readonly provider: string;
  readonly boundTenantId: string;
  private readonly credentials: Api003Credentials;
  private readonly transport: Api003OutboundTransport | undefined;

  constructor(config?: Partial<MarketingApi003Config> | null) {
    const hasTenant = typeof config?.tenant_id === 'string' && config.tenant_id.trim().length > 0;
    const hasProv = typeof config?.provider === 'string' && config.provider.trim().length > 0;
    const hasCreds = hasCredentials(config?.credentials);
    const hasTrans = Boolean(config?.transport && typeof config.transport.dispatch === 'function');

    this.isConfigured = Boolean(hasTenant && hasProv && hasCreds && hasTrans);
    this.boundTenantId = hasTenant ? (config!.tenant_id as string).trim() : '';
    this.provider = hasProv ? (config!.provider as string).trim() : '';
    this.credentials = hasCreds ? config!.credentials : undefined;
    this.transport = hasTrans ? (config!.transport as Api003OutboundTransport) : undefined;
  }

  /**
   * Dispatches an action draft to the injected provider transport.
   * Fails closed before transport if unconfigured, tenant mismatches, or payload is invalid.
   */
  async dispatch(draft: ActionDraft): Promise<ExecutionReceipt> {
    if (!this.isConfigured || !this.transport) {
      if (!this.boundTenantId) {
        throw new Api003RefusalError(
          'TENANT_UNSCOPED',
          this.adapterId,
          'Cannot dispatch: API-003 connector is not configured (tenant binding absent)',
        );
      }
      if (!this.provider) {
        throw new Api003RefusalError(
          'PROVIDER_ABSENT',
          this.adapterId,
          'Cannot dispatch: API-003 connector is not configured (provider absent)',
        );
      }
      if (!hasCredentials(this.credentials)) {
        throw new Api003RefusalError(
          'CREDENTIALS_ABSENT',
          this.adapterId,
          'Cannot dispatch: API-003 connector is not configured (credentials absent)',
        );
      }
      throw new Api003RefusalError(
        'CONNECTOR_UNCONFIGURED',
        this.adapterId,
        'Cannot dispatch: API-003 connector is not configured (transport absent)',
      );
    }
    if (draft.adapter_target !== this.adapterId) {
      throw new Api003RefusalError(
        'ADAPTER_TARGET_MISMATCH',
        this.adapterId,
        `Target mismatch: this connector handles '${this.adapterId}', but action requested '${draft.adapter_target}'`,
      );
    }

    const tenant_id = draft.tenant_id;
    if (!tenant_id || tenant_id.trim().length === 0) {
      throw new Api003RefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        'ActionDraft requires a non-empty tenant_id',
      );
    }

    if (tenant_id !== this.boundTenantId) {
      throw new Api003RefusalError(
        'TENANT_MISMATCH',
        this.adapterId,
        `Tenant mismatch: connector is bound to tenant '${this.boundTenantId}', but action specifies tenant '${tenant_id}'`,
      );
    }

    if (!draft.action_id || draft.action_id.trim().length === 0) {
      throw new Api003RefusalError(
        'ACTION_ID_MISSING',
        this.adapterId,
        'ActionDraft requires a non-empty action_id',
      );
    }

    if (!draft.effect_key || draft.effect_key.trim().length === 0) {
      throw new Api003RefusalError(
        'EFFECT_KEY_MISSING',
        this.adapterId,
        'ActionDraft requires a non-empty effect_key',
      );
    }

    if (!draft.payload || typeof draft.payload !== 'object' || Array.isArray(draft.payload)) {
      throw new Api003RefusalError(
        'PAYLOAD_MALFORMED',
        this.adapterId,
        'ActionDraft payload must be a non-null object',
      );
    }

    // Extract and validate channel
    const rawChannel =
      (draft.payload as Record<string, unknown>).channel ??
      (draft.payload as Record<string, unknown>).channel_id;

    if (!rawChannel || typeof rawChannel !== 'string' || rawChannel.trim().length === 0) {
      throw new Api003RefusalError(
        'CHANNEL_ABSENT',
        this.adapterId,
        'ActionDraft payload must specify a communication channel (payload.channel)',
      );
    }

    const normalizedChannel = rawChannel.trim().toUpperCase() as ChannelId;
    if (!SUPPORTED_API003_CHANNELS.includes(normalizedChannel)) {
      throw new Api003RefusalError(
        'INVALID_CHANNEL',
        this.adapterId,
        `Channel '${rawChannel}' is not a recognized API-003 channel. Expected one of: ${SUPPORTED_API003_CHANNELS.join(', ')}`,
      );
    }

    // Validate payload identity consistency
    const p = draft.payload as Record<string, unknown>;
    if (p.tenant_id !== undefined && p.tenant_id !== draft.tenant_id) {
      throw new Api003RefusalError(
        'PAYLOAD_IDENTITY_MISMATCH',
        this.adapterId,
        `Payload tenant_id '${String(p.tenant_id)}' does not match draft tenant_id '${draft.tenant_id}'`,
      );
    }
    if (p.action_id !== undefined && p.action_id !== draft.action_id) {
      throw new Api003RefusalError(
        'PAYLOAD_IDENTITY_MISMATCH',
        this.adapterId,
        `Payload action_id '${String(p.action_id)}' does not match draft action_id '${draft.action_id}'`,
      );
    }
    if (p.effect_key !== undefined && p.effect_key !== draft.effect_key) {
      throw new Api003RefusalError(
        'PAYLOAD_IDENTITY_MISMATCH',
        this.adapterId,
        `Payload effect_key '${String(p.effect_key)}' does not match draft effect_key '${draft.effect_key}'`,
      );
    }

    const dispatchInput: Api003OutboundDispatchInput = {
      tenant_id: draft.tenant_id,
      effect_key: draft.effect_key,
      action_id: draft.action_id,
      action_revision: draft.action_revision,
      channel: normalizedChannel,
      payload: draft.payload,
      provider: this.provider,
      credentials: this.credentials,
    };

    let result: Api003TransportDispatchResult;
    const startTime = Date.now();
    try {
      result = await this.transport.dispatch(dispatchInput);
    } catch (err: unknown) {
      const latency_ms = Date.now() - startTime;
      const error_message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|timed out|abort|deadline/i.test(error_message);
      result = {
        ok: false,
        failure_class: isTimeout ? 'TIMEOUT' : 'UNKNOWN',
        error_message,
        latency_ms,
      };
    }

    const execution_id = `${this.adapterId}:${draft.action_id}:${draft.action_revision}`;

    if (!result.ok) {
      const failure_class = result.failure_class;
      const adapter_status: 'TIMEOUT' | 'ERROR' =
        failure_class === 'REJECTED' ? 'ERROR' : 'TIMEOUT';

      return {
        execution_id,
        adapter_status,
        provider_reference: null,
        response_payload: {
          // Untrusted provider envelope first:
          ...(result.response_payload ?? {}),
          provider_envelope: result.response_payload ?? null,
          // Platform-owned classification fields written LAST so provider data cannot overwrite:
          failure_class,
          error_message: result.error_message,
          provider_status: result.provider_status ?? null,
          provider: this.provider,
          channel: normalizedChannel,
          reconciliation_required: failure_class === 'TIMEOUT' || failure_class === 'UNKNOWN',
          effect_key: draft.effect_key,
          action_id: draft.action_id,
        },
        latency_ms: result.latency_ms ?? (Date.now() - startTime),
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    }

    // Confirmed receipt pass-through:
    // If transport claimed confirmed success but receipt lacks non-empty provider_reference or has non-SUCCESS status,
    // classify as UNKNOWN for reconciliation rather than returning a fake success.
    if (
      !result.receipt.provider_reference ||
      result.receipt.provider_reference.trim().length === 0 ||
      result.receipt.adapter_status !== 'SUCCESS'
    ) {
      return {
        execution_id,
        adapter_status: 'TIMEOUT',
        provider_reference: null,
        response_payload: {
          // Untrusted provider data first:
          ...(result.receipt.response_payload ?? {}),
          provider_envelope: result.receipt.response_payload ?? null,
          // Platform-owned classification fields written LAST:
          failure_class: 'UNKNOWN',
          error_message: 'Transport reported success but returned unconfirmed receipt (missing provider_reference or non-SUCCESS status); classified as UNKNOWN',
          provider: this.provider,
          channel: normalizedChannel,
          reconciliation_required: true,
          effect_key: draft.effect_key,
          action_id: draft.action_id,
        },
        latency_ms: result.receipt.latency_ms ?? (Date.now() - startTime),
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    }

    // Pass through the exact confirmed ExecutionReceipt from transport!
    return result.receipt;
  }

  /**
   * Reconciles an effect outcome by effect_key and action_id against the provider.
   */
  async reconcile(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }): Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt;
  }> {
    if (!this.isConfigured || !this.transport) {
      throw new Api003RefusalError(
        'CONNECTOR_UNCONFIGURED',
        this.adapterId,
        'Cannot reconcile: API-003 connector is not configured',
      );
    }

    if (!input.tenant_id || input.tenant_id.trim().length === 0) {
      throw new Api003RefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        'Reconcile requires a non-empty tenant_id',
      );
    }

    if (input.tenant_id !== this.boundTenantId) {
      throw new Api003RefusalError(
        'TENANT_MISMATCH',
        this.adapterId,
        `Tenant mismatch: connector is bound to tenant '${this.boundTenantId}', but reconcile requested tenant '${input.tenant_id}'`,
      );
    }

    if (!input.effect_key || input.effect_key.trim().length === 0) {
      throw new Api003RefusalError(
        'EFFECT_KEY_MISSING',
        this.adapterId,
        'Reconcile requires a non-empty effect_key',
      );
    }

    if (!this.transport.reconcile) {
      return { outcome: 'INDETERMINATE' };
    }

    let reconcileResult: Api003ReconcileResult;
    try {
      reconcileResult = await this.transport.reconcile({
        tenant_id: input.tenant_id,
        effect_key: input.effect_key,
        provider: this.provider,
        credentials: this.credentials,
        ...(input.action_id !== undefined ? { action_id: input.action_id } : {}),
      });
    } catch {
      return { outcome: 'INDETERMINATE' };
    }

    if (reconcileResult.outcome === 'SUCCEEDED') {
      // Grounded-receipt guard: only a validated confirmed SUCCESS receipt may pass through
      if (!reconcileResult.receipt || reconcileResult.receipt.adapter_status !== 'SUCCESS') {
        return { outcome: 'INDETERMINATE' };
      }
      return {
        outcome: 'SUCCEEDED',
        receipt: reconcileResult.receipt,
      };
    }

    if (reconcileResult.outcome === 'FAILED') {
      return { outcome: 'FAILED' };
    }

    return { outcome: 'INDETERMINATE' };
  }
}

/** Result of the connector registration factory. */
export interface MarketingApi003RegistrationResult {
  readonly bound: boolean;
  readonly status: 'BOUND' | 'UNBOUND';
  readonly connector: MarketingApi003Connector | null;
  readonly connector_id: string | null;
  readonly reason?: string;
}

/**
 * Registers ONLY a configured API-003 connector into the provided registry under exactly one ID.
 * Absent credentials or provider leaves the registry clean (unbound), failing closed.
 */
export function registerMarketingApi003Connector(
  registry: ConnectorRegistry,
  config?: Partial<MarketingApi003Config> | null,
): MarketingApi003RegistrationResult {
  if (!config) {
    return {
      bound: false,
      status: 'UNBOUND',
      connector: null,
      connector_id: null,
      reason: 'No configuration provided: API-003 requires explicit transport, credentials, and tenant binding',
    };
  }

  const connector = new MarketingApi003Connector(config);
  if (!connector.isConfigured) {
    return {
      bound: false,
      status: 'UNBOUND',
      connector,
      connector_id: null,
      reason: 'Configuration incomplete: missing provider, transport, credentials, or tenant_id',
    };
  }

  if (registry.has(API003_CONNECTOR_ID)) {
    throw new DuplicateConnectorError(API003_CONNECTOR_ID);
  }

  registry.register({
    descriptor: {
      connector_id: API003_CONNECTOR_ID,
      kind: 'COMMUNICATION',
      provider: connector.provider,
      read_resources: [],
    },
    dispatch: (draft) => connector.dispatch(draft),
    reconcile: (input) => connector.reconcile(input),
  });

  return {
    bound: true,
    status: 'BOUND',
    connector,
    connector_id: API003_CONNECTOR_ID,
  };
}

/** Composition result providing registry, engine-facing dispatcher, and binding status. */
export interface MarketingApi003Binding {
  readonly registry: ConnectorRegistry;
  readonly dispatcher: IAdapterDispatcher;
  readonly connector: MarketingApi003Connector | null;
  readonly isBound: boolean;
  readonly status: 'BOUND' | 'UNBOUND';
  readonly connector_id: string | null;
  readonly unboundReason?: string;
}

/**
 * Factory creating an isolated API-003 connector binding with its dispatcher.
 * Unconfigured options leave the connector unregistered, causing any dispatch to fail closed.
 */
export function createMarketingApi003Binding(
  config?: Partial<MarketingApi003Config> | null,
): MarketingApi003Binding {
  const registry = new ConnectorRegistry();
  const registration = registerMarketingApi003Connector(registry, config);

  const rawDispatcher = createAdapterDispatcher({
    registry,
    refuseUnknownTarget: (connector_id) =>
      new OrchestratorError(
        'CONNECTOR_NOT_FOUND',
        `no connector is registered for adapter_target '${connector_id}'; the action is not dispatched`,
      ),
  });

  // Wrap dispatcher to default omitted adapter_target to API003_CONNECTOR_ID ('API-003.CommunicationConnector')
  // so { tenant_id, effect_key, action_id } reaches API-003.CommunicationConnector instead of leaking the generic API-001 default
  const dispatcher: IAdapterDispatcher = {
    dispatch: (action, options) => rawDispatcher.dispatch(action, options),
    reconcile: (input) =>
      rawDispatcher.reconcile!({
        ...input,
        adapter_target: input.adapter_target ?? API003_CONNECTOR_ID,
      }),
  };

  return {
    registry,
    dispatcher,
    connector: registration.connector,
    isBound: registration.bound,
    status: registration.status,
    connector_id: registration.connector_id,
    ...(registration.reason === undefined ? {} : { unboundReason: registration.reason }),
  };
}

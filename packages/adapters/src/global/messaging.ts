/**
 * ADPT-GL-001 global messaging seam.
 * Provider identities, window rules and credentials remain [UNCONFIRMED][ASM-001].
 * This module accepts only injected transports and fails closed for every missing guard.
 */

import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import { hexDigestsMatch } from '../channels/api-003-channels.js';
import type { ConnectorRegistry, RegisteredConnector } from '../base/registry.js';
import type { HmacSha256Hex } from '../base/signature.js';

export const GLOBAL_MESSAGING_CONNECTOR_ID = 'ADPT-GL-001';

export class MessagingRefusalError extends Error {
  constructor(
    readonly refusal_code:
      | 'TENANT_UNSCOPED'
      | 'PROVIDER_UNBOUND'
      | 'REQUEST_INVALID'
      | 'RESPONSE_INVALID'
      | 'SIGNATURE_MISSING'
      | 'SIGNATURE_INVALID'
      | 'SECRET_UNAVAILABLE'
      | 'CONSENT_REQUIRED'
      | 'SUPPRESSED'
      | 'TAKEOVER_ACTIVE'
      | 'SESSION_HOLD_ACTIVE'
      | 'WINDOW_RESTRICTION'
      | 'IDEMPOTENCY_CONFLICT'
      | 'UNKNOWN_OUTCOME',
    detail: string,
  ) {
    super(`MESSAGING_${refusal_code}: ${detail}`);
    this.name = 'MessagingRefusalError';
  }
}

export interface MessagingConsent {
  readonly granted: boolean;
  readonly captured_at: string;
}

export interface MessagingSuppression {
  readonly suppressed: boolean;
  readonly evaluated_at: string;
}

export interface MessagingWindowDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type MessagingPayload =
  | { readonly mode: 'FREE_FORM'; readonly text: string }
  | { readonly mode: 'TEMPLATE'; readonly template_id: string; readonly parameters: Readonly<Record<string, string>> };

/**
 * Outbound messaging facts are deliberately absent from this request. Consent, suppression,
 * takeover and the session window are authoritative platform state, not caller assertions.
 */
export interface MessagingRequest {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly provider_id: string;
  readonly recipient: string;
  readonly payload: MessagingPayload;
  readonly effect_key: string;
  readonly idempotency_key: string;
}

/**
 * The host binds these reads to its tenant-scoped, server-verified customer/session stores.
 * Implementations MUST NOT derive any result from an outbound payload.
 */
export interface MessagingAuthority {
  readonly consent: (input: {
    readonly tenant_id: string;
    readonly recipient: string;
    readonly session_id: string;
  }) => Promise<MessagingConsent | null> | MessagingConsent | null;
  readonly suppression: (input: {
    readonly tenant_id: string;
    readonly recipient: string;
    readonly session_id: string;
  }) => Promise<MessagingSuppression | null> | MessagingSuppression | null;
  readonly takeover: (input: {
    readonly tenant_id: string;
    readonly recipient: string;
    readonly session_id: string;
  }) => Promise<boolean> | boolean;
  readonly sessionHold: (input: {
    readonly tenant_id: string;
    readonly recipient: string;
    readonly session_id: string;
  }) => Promise<boolean> | boolean;
  readonly window: (input: {
    readonly tenant_id: string;
    readonly recipient: string;
    readonly session_id: string;
    readonly payload: MessagingPayload;
  }) => Promise<MessagingWindowDecision> | MessagingWindowDecision;
}

export interface MessagingProviderResponse {
  readonly outcome: 'SENT' | 'REJECTED' | 'TIMEOUT' | 'UNKNOWN';
  readonly provider_reference?: string | null;
  readonly status_code?: number;
  readonly response_payload?: Record<string, unknown>;
}

export interface MessagingProvider {
  readonly provider_id: string;
  send(request: MessagingRequest): Promise<MessagingProviderResponse>;
}

export interface MessagingReceipt {
  readonly outcome: 'SENT' | 'REJECTED' | 'UNKNOWN';
  readonly effect_key: string;
  readonly provider_reference: string | null;
  readonly response_payload: Record<string, unknown>;
  readonly requires_reconciliation: boolean;
}

export interface MessagingIdempotencyStore {
  begin(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly effect_key: string;
  }): Promise<{ readonly state: 'NEW' | 'REPLAY' | 'CONFLICT'; readonly receipt?: MessagingReceipt }> | {
    readonly state: 'NEW' | 'REPLAY' | 'CONFLICT';
    readonly receipt?: MessagingReceipt;
  };
  complete(input: {
    readonly tenant_id: string;
    readonly idempotency_key: string;
    readonly effect_key: string;
    readonly receipt: MessagingReceipt;
  }): Promise<void> | void;
}

export interface MessagingSecretResolver {
  resolve(secret_ref: string): Promise<string | null> | string | null;
}

function assertTenant(tenant_id: string): void {
  if (tenant_id.trim().length === 0) {
    throw new MessagingRefusalError('TENANT_UNSCOPED', 'tenant identity must come from the authenticated principal');
  }
}

function assertRequest(request: MessagingRequest): void {
  assertTenant(request.tenant_id);
  if (request.session_id.trim().length === 0 || request.provider_id.trim().length === 0
    || request.recipient.trim().length === 0 || request.effect_key.trim().length === 0
    || request.idempotency_key.trim().length === 0) {
    throw new MessagingRefusalError(
      'REQUEST_INVALID',
      'session, provider, recipient, effect_key and idempotency_key are required',
    );
  }
  if (request.payload.mode === 'FREE_FORM' && request.payload.text.trim().length === 0) {
    throw new MessagingRefusalError('REQUEST_INVALID', 'free-form text cannot be empty');
  }
  if (request.payload.mode === 'TEMPLATE' && request.payload.template_id.trim().length === 0) {
    throw new MessagingRefusalError('REQUEST_INVALID', 'template id is required');
  }
  // Reject legacy caller-supplied authority fields rather than silently accepting a forged claim.
  const candidate = request as unknown as Record<string, unknown>;
  for (const field of ['consent', 'suppression', 'takeover_active', 'session_hold_active', 'window_policy']) {
    if (field in candidate) {
      throw new MessagingRefusalError('REQUEST_INVALID', `${field} is an authoritative lookup, not a payload field`);
    }
  }
}

function validateProviderResponse(response: MessagingProviderResponse): MessagingReceipt['outcome'] {
  if (!['SENT', 'REJECTED', 'TIMEOUT', 'UNKNOWN'].includes(response.outcome)) {
    throw new MessagingRefusalError('RESPONSE_INVALID', 'provider returned an unknown outcome');
  }
  if (response.outcome === 'SENT'
    && (typeof response.provider_reference !== 'string' || response.provider_reference.length === 0)) {
    throw new MessagingRefusalError('RESPONSE_INVALID', 'a send success requires provider proof');
  }
  // TIMEOUT is an indeterminate provider result, never a public success/failure state.
  return response.outcome === 'TIMEOUT' ? 'UNKNOWN' : response.outcome;
}

/** Provider registry is explicit; there is no fallback provider or default outbound route. */
export class MessagingProviderRegistry {
  private readonly providers = new Map<string, MessagingProvider>();

  register(provider: MessagingProvider): void {
    if (provider.provider_id.trim().length === 0 || this.providers.has(provider.provider_id)) {
      throw new MessagingRefusalError('PROVIDER_UNBOUND', 'provider registration is missing or duplicated');
    }
    this.providers.set(provider.provider_id, provider);
  }

  resolve(provider_id: string): MessagingProvider {
    const provider = this.providers.get(provider_id);
    if (provider === undefined) {
      throw new MessagingRefusalError('PROVIDER_UNBOUND', 'requested messaging provider is not registered');
    }
    return provider;
  }

  has(provider_id: string): boolean {
    return this.providers.has(provider_id);
  }
}

export class GlobalMessagingAdapter {
  constructor(
    private readonly deps: {
      readonly providers: MessagingProviderRegistry;
      readonly idempotency: MessagingIdempotencyStore;
      readonly authority: MessagingAuthority;
    },
  ) {}

  async send(request: MessagingRequest): Promise<MessagingReceipt> {
    assertRequest(request);

    // Resolve the provider before reserving idempotency. An unbound provider must leave no dangling
    // reservation that can make a later, valid request appear to be a replay.
    const provider = this.deps.providers.resolve(request.provider_id);
    const scope = {
      tenant_id: request.tenant_id,
      recipient: request.recipient,
      session_id: request.session_id,
    };
    let consent: MessagingConsent | null;
    let suppression: MessagingSuppression | null;
    let takeover_active: boolean;
    let session_hold_active: boolean;
    let window: MessagingWindowDecision;
    try {
      [consent, suppression, takeover_active, session_hold_active, window] = await Promise.all([
        this.deps.authority.consent(scope),
        this.deps.authority.suppression(scope),
        this.deps.authority.takeover(scope),
        this.deps.authority.sessionHold(scope),
        this.deps.authority.window({ ...scope, payload: request.payload }),
      ]);
    } catch {
      throw new MessagingRefusalError('RESPONSE_INVALID', 'authoritative messaging state is unavailable');
    }
    if (consent === null || consent.granted !== true || consent.captured_at.length === 0) {
      throw new MessagingRefusalError('CONSENT_REQUIRED', 'authoritative consent is required immediately before send');
    }
    if (suppression === null || suppression.suppressed === true || suppression.evaluated_at.length === 0) {
      throw new MessagingRefusalError('SUPPRESSED', 'authoritative suppression state blocks this outbound request');
    }
    if (takeover_active) throw new MessagingRefusalError('TAKEOVER_ACTIVE', 'human takeover refuses outbound messaging');
    if (session_hold_active) throw new MessagingRefusalError('SESSION_HOLD_ACTIVE', 'session hold refuses outbound messaging');
    if (!window.allowed) {
      throw new MessagingRefusalError('WINDOW_RESTRICTION', window.reason ?? 'template or session window policy refused');
    }

    const prior = await this.deps.idempotency.begin({
      tenant_id: request.tenant_id,
      idempotency_key: request.idempotency_key,
      effect_key: request.effect_key,
    });
    if (prior.state === 'CONFLICT') {
      throw new MessagingRefusalError('IDEMPOTENCY_CONFLICT', 'idempotency key was reused with a different effect');
    }
    if (prior.state === 'REPLAY') {
      if (prior.receipt === undefined) {
        return {
          outcome: 'UNKNOWN',
          effect_key: request.effect_key,
          provider_reference: null,
          response_payload: {},
          requires_reconciliation: true,
        };
      }
      return prior.receipt;
    }

    let response: MessagingProviderResponse;
    try {
      response = await provider.send(request);
    } catch {
      response = { outcome: 'UNKNOWN' };
    }
    const outcome = validateProviderResponse(response);
    const receipt: MessagingReceipt = {
      outcome,
      effect_key: request.effect_key,
      provider_reference: response.provider_reference ?? null,
      response_payload: response.response_payload ?? {},
      requires_reconciliation: outcome === 'UNKNOWN' || response.outcome === 'TIMEOUT',
    };
    await this.deps.idempotency.complete({
      tenant_id: request.tenant_id,
      idempotency_key: request.idempotency_key,
      effect_key: request.effect_key,
      receipt,
    });
    return receipt;
  }
}

function signatureMatches(expected: string, provided: string): boolean {
  if (expected.length === provided.length && hexDigestsMatch(expected, provided)) return true;
  let difference = expected.length === provided.length ? 0 : 1;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ (provided.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyMessagingWebhook(input: {
  readonly secret_ref: string;
  readonly secret_resolver: MessagingSecretResolver;
  readonly raw_body: string;
  readonly provided_signature: string | null;
  readonly hmac: HmacSha256Hex;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: MessagingRefusalError['refusal_code'] }> {
  if (input.provided_signature === null || input.provided_signature.length === 0) {
    return { ok: false, reason: 'SIGNATURE_MISSING' };
  }
  let secret: string | null;
  try {
    secret = await input.secret_resolver.resolve(input.secret_ref);
  } catch {
    return { ok: false, reason: 'SECRET_UNAVAILABLE' };
  }
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'SECRET_UNAVAILABLE' };
  let expected: string;
  try {
    expected = input.hmac(secret, input.raw_body);
  } catch {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }
  return signatureMatches(expected, input.provided_signature)
    ? { ok: true }
    : { ok: false, reason: 'SIGNATURE_INVALID' };
}

function actionToMessage(action: ActionDraft): MessagingRequest {
  const payload = action.payload as Partial<MessagingRequest> & Record<string, unknown>;
  if (payload.tenant_id !== action.tenant_id) {
    throw new MessagingRefusalError('TENANT_UNSCOPED', 'action tenant does not match authenticated tenant');
  }
  for (const field of ['consent', 'suppression', 'takeover_active', 'session_hold_active', 'window_policy']) {
    if (field in payload) {
      throw new MessagingRefusalError('REQUEST_INVALID', `${field} cannot be supplied by an action payload`);
    }
  }
  return payload as MessagingRequest;
}

function receiptToExecution(receipt: MessagingReceipt): ExecutionReceipt {
  return {
    execution_id: `messaging:${receipt.effect_key}`,
    adapter_status: receipt.outcome === 'SENT' ? 'SUCCESS' : receipt.outcome === 'UNKNOWN' ? 'TIMEOUT' : 'ERROR',
    provider_reference: receipt.provider_reference,
    response_payload: receipt.response_payload,
    latency_ms: 0,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
  };
}

export function createGlobalMessagingConnector(input: {
  readonly adapter: GlobalMessagingAdapter;
}): RegisteredConnector {
  return {
    descriptor: {
      connector_id: GLOBAL_MESSAGING_CONNECTOR_ID,
      kind: 'COMMUNICATION',
      provider: 'Global messaging provider [UNCONFIRMED][ASM-001]',
      read_resources: [],
    },
    dispatch: async (action) => receiptToExecution(await input.adapter.send(actionToMessage(action))),
  };
}

export function registerGlobalMessagingConnector(
  registry: ConnectorRegistry,
  input: { readonly adapter: GlobalMessagingAdapter },
): RegisteredConnector {
  const connector = createGlobalMessagingConnector(input);
  registry.register(connector);
  return connector;
}

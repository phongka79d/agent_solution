/**
 * @file R04 — `POST /api/v1/events`, the platform event ingress (implement/06 §8.1.1 R04, §9.3).
 *
 * This is the one route a provider or a tenant-side relay reaches without an operator session, so
 * its order of operations is the whole security story:
 *
 *   1. **Verify the signature over the bytes that arrived**, before anything is derived, stored or
 *      routed. A forged or replayed delivery is refused `401` and no agent is invoked (`TC-CON-004`).
 *      The digest is computed over the preserved raw body, never over a re-serialised payload.
 *   2. **Bind the tenant from the credential**, never from the body. `authenticate()` has already
 *      refused a delivery whose asserted tenant disagrees with the resolved principal.
 *   3. **Derive the canonical name through the connector layer** and append through the durable
 *      event port, whose `(tenant, source_event_id)` uniqueness is what deduplicates a retry.
 *
 * A redelivery of an identical envelope is answered from the same stored event; a redelivery whose
 * payload differs under the same `event_id` is `409 IDEMPOTENCY_CONFLICT`, because the identity that
 * was already claimed cannot silently mean different bytes.
 */

import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { EventIngestionResponse, PlatformEventEnvelope } from '../../gateway/contracts.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import { requireRawBody } from '../../gateway/raw-body.js';

/** The canonical-event derivation the gateway consumes but does not own (`06` §3.0). */
export interface EventRouteNormalizer {
  canonicalEventOf(event_type: string): {
    readonly canonical_event: string | null;
    readonly stored_event_name: string;
    readonly alias_table_version: number;
  };
}

/** Everything R04 needs beyond the runtime bundle. */
export interface EventRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /** Absent means no derivation is bound: the delivery is stored under its raw name, uncanonicalised. */
  readonly normalizer?: EventRouteNormalizer;
}

/** Digest of the canonical envelope bytes, used to detect a changed payload under a claimed id. */
function envelopeDigest(envelope: PlatformEventEnvelope): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        event_id: envelope.event_id,
        event_type: envelope.event_type,
        source: envelope.source,
        occurred_at: envelope.occurred_at,
        payload: envelope.payload,
      }),
      'utf8',
    )
    .digest('hex');
}

/** Rejects an envelope that is not a well-formed `PlatformEventEnvelope`. */
function requireEnvelope(body: unknown): PlatformEventEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('VALIDATION_FAILED', 'the request body must be a JSON object');
  }

  const candidate = body as Record<string, unknown>;
  const event_id = candidate['event_id'];
  const event_type = candidate['event_type'];
  const source = candidate['source'];
  const occurred_at = candidate['occurred_at'];
  const payload = candidate['payload'];

  if (typeof event_id !== 'string' || event_id.length === 0) {
    fail('VALIDATION_FAILED', 'event_id is required and must be a non-empty string');
  }
  if (typeof event_type !== 'string' || event_type.length === 0) {
    fail('VALIDATION_FAILED', 'event_type is required and must be a non-empty string');
  }
  if (typeof source !== 'string' || source.length === 0) {
    fail('VALIDATION_FAILED', 'source is required and must be a non-empty string');
  }
  if (typeof occurred_at !== 'string' || Number.isNaN(Date.parse(occurred_at))) {
    fail('VALIDATION_FAILED', 'occurred_at is required and must be an ISO-8601 instant');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('VALIDATION_FAILED', 'payload is required and must be a JSON object');
  }

  return {
    event_id,
    event_type,
    source,
    occurred_at,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * Registers R04 on the `/api/v1` prefix.
 *
 * @param app The Fastify instance.
 * @param deps The runtime bundle, the credential store and the connector-layer derivation.
 */
export function registerEventRoutes(app: FastifyInstance, deps: EventRouteDeps): void {
  const preHandler = authenticate(deps);

  app.post('/events', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requirePrincipal(request);

      // Verification runs first and over the delivered bytes. A delivery with no preserved body
      // cannot be verified and is refused rather than trusted.
      const raw_body = requireRawBody(request);
      const verdict = await runtime.webhooks.verify({
        tenant_id: principal.tenant_id,
        channel: null,
        raw_body,
        headers: request.headers as Readonly<Record<string, string | undefined>>,
      });

      if (!verdict.ok) {
        // The refusal is recorded with its verdict, so the audit trail shows the delivery that was
        // rejected as well as the ones that were accepted.
        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'events.ingest',
          principal_kind: principal.kind,
          outcome: 'REFUSED',
          error_code: verdict.error_code,
        });
        fail(verdict.error_code, 'the delivery signature did not verify against the tenant platform secret');
      }

      const envelope = requireEnvelope(request.body);

      // The canonical name is derived by the connector layer, never here. Without the binding the
      // delivery keeps its granular name and is marked as such in the stored payload.
      const derivation =
        deps.normalizer === undefined
          ? { canonical_event: null, stored_event_name: envelope.event_type, alias_table_version: 0 }
          : deps.normalizer.canonicalEventOf(envelope.event_type);

      const digest = envelopeDigest(envelope);
      const session_id =
        typeof envelope.payload['session_id'] === 'string' ? envelope.payload['session_id'] : envelope.event_id;

      // A redelivery is decided before the append: the stored receipt carries the digest of the
      // bytes the platform accepted, so an identical retry is acknowledged as already recorded and a
      // delivery whose bytes changed under the same `event_id` is the one conflict there is.
      const prior = await runtime.events.receipt(principal.tenant_id, envelope.event_id);
      if (prior !== null && prior.payload_sha256 !== null && prior.payload_sha256 !== digest) {
        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id,
          operation: 'events.ingest',
          principal_kind: principal.kind,
          outcome: 'REFUSED',
          error_code: 'IDEMPOTENCY_CONFLICT',
          detail: { event_id: envelope.event_id },
        });
        fail(
          'IDEMPOTENCY_CONFLICT',
          'this event_id was already accepted with different bytes; the delivery is not recorded a second time',
        );
      }

      const appended = await runtime.events.append({
        tenant_id: principal.tenant_id,
        source_event_id: envelope.event_id,
        event_name: derivation.stored_event_name,
        session_id,
        channel: typeof envelope.payload['channel'] === 'string' ? envelope.payload['channel'] : 'PLATFORM',
        customer_id: null,
        occurred_at: envelope.occurred_at,
        payload: {
          // The granular value and the table version are retained beside the canonical name, so a
          // later alias-table revision cannot rewrite what this row meant when it was stored.
          event_type: envelope.event_type,
          source: envelope.source,
          canonical_event: derivation.canonical_event,
          alias_table_version: derivation.alias_table_version,
          payload_sha256: digest,
          payload: envelope.payload,
        },
      });

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'events.ingest',
        principal_kind: principal.kind,
        outcome: 'ACCEPTED',
        detail: {
          event_id: envelope.event_id,
          event_type: envelope.event_type,
          canonical_event: derivation.canonical_event,
          signature: 'verified',
          deduplicated: !appended.inserted,
        },
      });

      const response: EventIngestionResponse = {
        event_id: envelope.event_id,
        correlation_id,
        // `IGNORED` is the truthful status of a delivery whose row already existed: the platform
        // acknowledged it and derived nothing new from it (`06` §3.0 canonical contract).
        status: appended.inserted ? 'QUEUED' : 'IGNORED',
      };

      return reply.code(202).send(response);
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}

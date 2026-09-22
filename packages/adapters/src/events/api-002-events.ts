/**
 * @file API-002 event-stream connector: canonical derivation and the versioned alias table
 * (implement/06 §3.0, §8.1.2 R12).
 *
 * SRS API-002 fixes exactly seven canonical events. The stream keeps granular `event_type` values
 * because analytics and the C360 timeline need them, but every stored event also carries the
 * derived canonical name, so the timeline, the signal triggers and the ERP boundaries can all rely
 * on one baseline vocabulary.
 *
 * Two rules decide the shape of this module:
 *
 * 1. **The mapping is data, not a branch.** A granular alias is resolved through a versioned table
 *    and the version that produced a stored name is retained beside it, so a later table change can
 *    never silently re-point a name that history already means something else by (§3.0).
 * 2. **`source_event_id` is the only dedupe key.** Derivation is pure and repeatable; the durable
 *    append and its uniqueness constraint own deduplication (`03` §1 Entity 4), so a redelivery
 *    normalises identically and is then dropped by the store rather than by this module.
 *
 * The module holds no clock, no transport and no `node:` import: the host supplies the instant and
 * performs the write, which keeps the derivation deterministic under test.
 */

/** The seven baseline canonical events that SRS API-002 fixes (`06` §3.0). */
export const CANONICAL_EVENTS = [
  'session',
  'product_view',
  'search',
  'click',
  'add_to_cart',
  'checkout',
  'purchase',
] as const;

export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

/**
 * Version of the alias table below. Stored beside every derived event so a future re-pointing is
 * visible in the record rather than retroactive.
 */
export const BASELINE_ALIAS_TABLE_VERSION = 1;

/**
 * The baseline granular-to-canonical mapping of `06` §3.0.
 *
 * `cart.remove` is deliberately absent: it is an extension event for analytics only, is never a
 * purchase or abandonment trigger on its own, and therefore carries `canonical_event: null`.
 */
export const BASELINE_EVENT_ALIASES: Readonly<Record<string, CanonicalEvent>> = Object.freeze({
  'session.start': 'session',
  'session.end': 'session',
  'product.view': 'product_view',
  'search.query': 'search',
  'element.click': 'click',
  'cart.add': 'add_to_cart',
  'checkout.start': 'checkout',
  'order.placed': 'purchase',
});

/** Granular types this blueprint emits that have no baseline canonical parent. */
export const EXTENSION_EVENT_TYPES: readonly string[] = Object.freeze(['cart.remove']);

/** One normalised event, ready for the durable append. */
export interface NormalizedEvent {
  /** The dedupe key (`03` §1 Entity 4 `uq_customer_events_source`). */
  readonly source_event_id: string;
  /** The granular value exactly as delivered; retained for analytics. */
  readonly event_type: string;
  /** The baseline parent, or `null` for extension telemetry. */
  readonly canonical_event: CanonicalEvent | null;
  /** What `customer_events.event_name` stores: the canonical name, or the extension identity. */
  readonly stored_event_name: string;
  /** The alias-table version that produced `stored_event_name`. */
  readonly alias_table_version: number;
  readonly occurred_at: string;
  readonly session_id: string;
  readonly channel: string;
  readonly customer_id: string | null;
}

/** The derivation result for one granular type. */
export interface CanonicalDerivation {
  readonly canonical_event: CanonicalEvent | null;
  readonly stored_event_name: string;
  readonly alias_table_version: number;
}

/** Derives the canonical parent and the stored name for one granular event type. */
export interface EventAliasNormalizer {
  readonly version: number;
  /**
   * @param event_type The granular value the widget or app emitted.
   * @returns The baseline parent (or `null`), the stored name, and the table version used.
   */
  canonicalEventOf(event_type: string): CanonicalDerivation;
  /** Extracts the dedupe key and derives the canonical identity of one delivery. */
  normalize(input: {
    event_id: string;
    event_type: string;
    session_id: string;
    channel: string;
    customer_id: string | null;
    occurred_at: string;
  }): NormalizedEvent;
}

/** Every extension event gets a namespaced identity so it can never collide with a canonical name. */
function extensionNameOf(eventType: string): string {
  const separator = eventType.indexOf('.');
  if (separator <= 0 || separator === eventType.length - 1) {
    return `ext.unknown.${eventType}`;
  }
  return `ext.${eventType}`;
}

/**
 * Builds the normalizer over the baseline table plus a tenant-approved alias extension.
 *
 * @param options.version The table version to stamp on derived events; defaults to
 *   {@link BASELINE_ALIAS_TABLE_VERSION}.
 * @param options.extra_aliases Additional granular aliases accepted for this deployment. An entry
 *   that would re-point a baseline alias at a different canonical event is refused rather than
 *   applied, because §3.0 forbids silently re-pointing an alias the stored history already relies
 *   on.
 * @throws {Error} `EVENT_ALIAS_CONFLICT` when an extension collides with the baseline table.
 */
export function createEventAliasNormalizer(options?: {
  readonly version?: number;
  readonly extra_aliases?: Readonly<Record<string, CanonicalEvent>>;
}): EventAliasNormalizer {
  const version = options?.version ?? BASELINE_ALIAS_TABLE_VERSION;
  const extension = options?.extra_aliases ?? {};

  for (const [alias, canonical] of Object.entries(extension)) {
    const baseline = BASELINE_EVENT_ALIASES[alias];
    if (baseline !== undefined && baseline !== canonical) {
      throw new Error(
        `EVENT_ALIAS_CONFLICT: alias ${alias} already maps to ${baseline} in the baseline table and may not be re-pointed at ${canonical}`,
      );
    }
    if (!CANONICAL_EVENTS.includes(canonical)) {
      throw new Error(`EVENT_ALIAS_CONFLICT: ${canonical} is not a baseline canonical event`);
    }
  }

  const table: Readonly<Record<string, CanonicalEvent>> = Object.freeze({
    ...BASELINE_EVENT_ALIASES,
    ...extension,
  });

  const canonicalEventOf = (eventType: string): CanonicalDerivation => {
    const canonical = table[eventType];

    if (canonical === undefined) {
      // No baseline parent: extension telemetry, never guessed into a canonical bucket.
      return {
        canonical_event: null,
        stored_event_name: extensionNameOf(eventType),
        alias_table_version: version,
      };
    }

    return { canonical_event: canonical, stored_event_name: canonical, alias_table_version: version };
  };

  return {
    version,
    canonicalEventOf,
    normalize: (input) => {
      const derivation = canonicalEventOf(input.event_type);
      return {
        source_event_id: input.event_id,
        event_type: input.event_type,
        canonical_event: derivation.canonical_event,
        stored_event_name: derivation.stored_event_name,
        alias_table_version: derivation.alias_table_version,
        occurred_at: input.occurred_at,
        session_id: input.session_id,
        channel: input.channel,
        customer_id: input.customer_id,
      };
    },
  };
}

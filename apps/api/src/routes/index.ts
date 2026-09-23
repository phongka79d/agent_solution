import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../gateway/principal.js';
import type { GatewayRuntime } from '../gateway/ports.js';
import { registerAnalyticsRoutes } from './v1/analytics.js';
import { registerApprovalRoutes } from './v1/approvals.js';
import { registerCampaignRoutes } from './v1/campaigns.js';
import { registerChatRoutes } from './v1/chat.js';
import { registerConversationRoutes } from './v1/conversations.js';
import { registerEventRoutes } from './v1/events.js';
import { registerOperationRoutes } from './v1/operations.js';
import { registerStorefrontRoutes } from './v1/storefront.js';
import { registerTelemetryRoutes } from './v1/telemetry.js';
import { registerWebhookRoutes } from './v1/webhooks.js';

/** The one base path the gateway serves (`06` §8.0). It is a literal, not configuration. */
export const API_PREFIX = '/api/v1';

/** Everything a route group is allowed to reach. Injected once, at composition time. */
export interface RouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /**
   * The API-002 canonical derivation (`06` §3.0). The gateway never derives a canonical event
   * itself, so the normaliser is injected and its absence is a refusal rather than a guess.
   */
  readonly normalizer?: {
    canonicalEventOf(event_type: string): {
      readonly canonical_event: string | null;
      readonly stored_event_name: string;
      readonly alias_table_version: number;
    };
  };
  /** Releases resources owned by this composition. Test doubles may omit it. */
  readonly close?: () => Promise<void>;
}

/**
 * Registers every `/api/v1` route group of `06` §8.
 *
 * The base path is `/api/v1` and only `/api/v1`: there is no unprefixed and no `/v1`-only variant
 * in the implementation contract (`06` §8.0). The prefix is applied here, in one encapsulation
 * scope, so no group can be mounted at the root by forgetting its own prefix; each group applies
 * the authentication hook itself, so a group cannot be registered without its requests being
 * authenticated first.
 *
 * @param app The Fastify instance the groups are registered on.
 * @param deps The injected runtime, credential store and canonical-event normaliser.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  void app.register(
    (scope, _options, done) => {
      registerConversationRoutes(scope, deps);
      registerChatRoutes(scope);
      registerEventRoutes(scope, deps);
      registerApprovalRoutes(scope, deps);
      registerOperationRoutes(scope, deps);
      registerTelemetryRoutes(scope, deps);
      registerAnalyticsRoutes(scope, deps);
      registerStorefrontRoutes(scope, deps);
      registerCampaignRoutes(scope);
      registerWebhookRoutes(scope);
      done();
    },
    { prefix: API_PREFIX },
  );
}

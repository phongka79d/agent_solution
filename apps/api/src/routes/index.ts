import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../gateway/principal.js';
import type { GatewayRuntime, CompanyProjectionPort, PlatformDirectoryPort, PlatformProvidersPort } from '../gateway/ports.js';
import type { DemoCredentialStore } from '../runtime/demo-auth.js';
import type { TurnIntentPort } from '../runtime/bindings/turn-intent.js';
import { InMemoryTurnRateLimiter, type TurnRateLimiter } from './v1/care-turn.js';
import { registerAnalyticsRoutes } from './v1/analytics.js';
import { registerCustomerRoutes } from './v1/customers.js';
import { registerApprovalRoutes } from './v1/approvals.js';
import { registerCompanySettingsRoutes } from './v1/company-settings.js';
import { registerCampaignRoutes } from './v1/campaigns.js';
import { registerChatRoutes } from './v1/chat.js';
import { registerConversationRoutes } from './v1/conversations.js';
import { registerOperatorConversationRoutes } from './v1/operator-conversations.js';
import { registerDemoWidgetRoutes } from './v1/demo-widget.js';
import { registerDemoAuthRoutes } from './v1/demo-auth.js';
import { registerEventRoutes } from './v1/events.js';
import { registerAutonomyAdminRoutes, type AutonomyAdminPort } from './v1/autonomy-admin.js';
import { registerOperationRoutes } from './v1/operations.js';
import { registerProvisioningRoutes, type ProvisioningRoutePort } from './v1/provisioning.js';
import { registerDemoReadinessRoutes, type DemoReadinessPort, type RunTracePort } from './v1/demo-readiness.js';
import { registerStorefrontRoutes } from './v1/storefront.js';
import { registerTelemetryRoutes } from './v1/telemetry.js';
import { registerWebhookRoutes } from './v1/webhooks.js';
import { registerPlatformRoutes } from './v1/platform.js';
import { registerCompanyRoutes } from './v1/company.js';

/** The one base path the gateway serves (`06` §8.0). It is a literal, not configuration. */
export const API_PREFIX = '/api/v1';

/** Everything a route group is allowed to reach. Injected once, at composition time. */
export interface RouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /** Present only for a local/CI DEMO_MODE composition. */
  readonly demoAuth?: DemoCredentialStore;
  /** Request-time environment accessor for routes whose capability gate may change in-process. */
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  readonly intentProposer?: TurnIntentPort;
  readonly turnRateLimiter?: TurnRateLimiter;
  readonly demoMode?: boolean;
  readonly readiness?: DemoReadinessPort;
  readonly trace?: RunTracePort;
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
  readonly enabledModules?: readonly string[];
  readonly salesSignalEventTypes?: readonly string[];
  readonly marketingSignalEventTypes?: readonly string[];
  /** Optional P5 route groups; omitted dependencies leave existing composition unchanged. */
  readonly provisioning?: ProvisioningRoutePort;
  readonly autonomyAdmin?: AutonomyAdminPort;
  readonly platform?: PlatformDirectoryPort;
  readonly providers?: PlatformProvidersPort;
  readonly companyProjections?: CompanyProjectionPort;
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
  const turnRateLimiter = deps.turnRateLimiter ?? new InMemoryTurnRateLimiter({
    clock: deps.runtime.clock,
  });
  const admissionDeps: RouteDependencies = { ...deps, turnRateLimiter };
  void app.register(
    (scope, _options, done) => {
      if (deps.demoAuth !== undefined) {
        registerDemoAuthRoutes(scope, {
          demoAuth: deps.demoAuth,
          runtime: deps.runtime,
        });
        registerDemoWidgetRoutes(scope, {
          demoAuth: deps.demoAuth,
          runtime: deps.runtime,
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
      }
      registerConversationRoutes(scope, admissionDeps);
      registerOperatorConversationRoutes(scope, deps);
      registerChatRoutes(scope);
      registerEventRoutes(scope, deps);
      registerApprovalRoutes(scope, deps);
      registerCompanySettingsRoutes(scope, deps);
      registerOperationRoutes(scope, deps);
      registerTelemetryRoutes(scope, deps);
      registerCustomerRoutes(scope, deps);
      registerAnalyticsRoutes(scope, deps);
      registerStorefrontRoutes(scope, admissionDeps);
      registerCampaignRoutes(scope, deps);
      if (deps.demoMode !== undefined && deps.readiness !== undefined && deps.trace !== undefined) {
        registerDemoReadinessRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          demoMode: deps.demoMode,
          readiness: deps.readiness,
          trace: deps.trace,
        });
      }
      registerWebhookRoutes(scope);
      if (deps.provisioning !== undefined) {
        registerProvisioningRoutes(scope, {
          provisioning: deps.provisioning,
          credentials: deps.credentials,
          runtime: deps.runtime,
          ...(deps.autonomyAdmin === undefined ? {} : { autonomyAdmin: deps.autonomyAdmin }),
        });
      }
      if (deps.autonomyAdmin !== undefined) {
        registerAutonomyAdminRoutes(scope, {
          autonomyAdmin: deps.autonomyAdmin,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.platform !== undefined && deps.providers !== undefined) {
        registerPlatformRoutes(scope, {
          platform: deps.platform,
          providers: deps.providers,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      const companyProjections = deps.companyProjections ?? deps.runtime.companyProjections;
      if (companyProjections !== undefined) {
        registerCompanyRoutes(scope, {
          projections: companyProjections,
          credentials: deps.credentials,
          runtime: deps.runtime,
          ...(deps.readiness === undefined ? {} : { readiness: deps.readiness }),
          ...(deps.provisioning === undefined ? {} : { provisioning: deps.provisioning }),
          ...(deps.providers === undefined ? {} : { providers: deps.providers }),
          ...(deps.enabledModules === undefined ? {} : { enabledModules: deps.enabledModules }),
        });
      }
      done();
    },
    { prefix: API_PREFIX },
  );
}

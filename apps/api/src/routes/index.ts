import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../gateway/principal.js';
import type {
  GatewayRuntime,
  CompanyProjectionPort,
  CompanyUserAdminPort,
  InvitationAcceptPort,
  PlatformAdminsPort,
  PlatformCompanyCommandsPort,
  PlatformDirectoryPort,
  PlatformProvidersPort,
} from '../gateway/ports.js';
import type { DemoCredentialStore } from '../runtime/demo-auth.js';
import type { DatabaseAuthStore } from '../runtime/db-auth.js';
import type { TurnIntentPort } from '../runtime/bindings/turn-intent.js';
import type { LlmConfigurationPort } from './v1/company-llm.js';
import type { KnowledgeRepository } from '@agentos/database';
import type { TestCustomersRepository } from '@agentos/database';
import { registerTestingRoutes, type TestWidgetSessionIssuer } from './v1/testing.js';
import { registerCompanyLlmRoutes } from './v1/company-llm.js';
import { registerPlatformProviderRoutes } from './v1/platform-providers.js';
import { InMemoryTurnRateLimiter, type TurnRateLimiter } from './v1/care-turn.js';
import { registerAnalyticsRoutes } from './v1/analytics.js';
import { registerCompanyAnalyticsRoutes } from './v1/company-analytics.js';
import { registerCustomerRoutes } from './v1/customers.js';
import { registerApprovalRoutes } from './v1/approvals.js';
import { registerCompanySettingsRoutes } from './v1/company-settings.js';
import { registerCompanyProfileRoutes } from './v1/company-profile.js';
import { registerAuditRoutes } from './v1/audit.js';
import { registerCampaignRoutes } from './v1/campaigns.js';
import { registerConversationRoutes } from './v1/conversations.js';
import { registerOperatorConversationRoutes } from './v1/operator-conversations.js';
import { registerDemoWidgetRoutes } from './v1/demo-widget.js';
import type { DemoWidgetSessionIssuer } from './v1/demo-widget.js';
import { registerDemoAuthRoutes } from './v1/demo-auth.js';
import { registerAuthRoutes } from './v1/auth.js';
import { registerEventRoutes } from './v1/events.js';
import { registerAutonomyAdminRoutes, type AutonomyAdminPort } from './v1/autonomy-admin.js';
import { registerOperationRoutes } from './v1/operations.js';
import { registerProvisioningRoutes, type ProvisioningRoutePort } from './v1/provisioning.js';
import { registerCompanyOwnerInputsRoutes } from './v1/company-owner-inputs.js';
import { registerDemoReadinessRoutes, type DemoReadinessPort, type RunTracePort } from './v1/demo-readiness.js';
import { registerStorefrontRoutes } from './v1/storefront.js';
import { registerPlatformRoutes } from './v1/platform.js';
import { registerPlatformRunsRoutes } from './v1/platform-runs.js';
import { registerPlatformCompaniesRoutes } from './v1/platform-companies.js';
import { registerPlatformInvitationRoutes } from './v1/platform-invitations.js';
import { registerPlatformAdminRoutes } from './v1/platform-admins.js';
import { registerCompanyUserRoutes } from './v1/company-users.js';
import { registerInvitationRoutes } from './v1/invitations.js';
import { registerPlatformHealthRoutes } from './v1/platform-health.js';
import { registerCompanyRoutes } from './v1/company.js';
import { registerCompanyAiTeamRoutes } from './v1/company-ai-team.js';
import { registerCompanyIntegrationsRoutes } from './v1/company-integrations.js';
import { registerKnowledgeRoutes } from './v1/knowledge.js';
import { registerSkillRoutes, type SkillsPort } from './v1/skills.js';
import { registerPlatformSkillsRoutes, type PlatformSkillsPort } from './v1/platform-skills.js';
import { errorEnvelopeResponse } from './v1/openapi-schemas.js';

/** The one base path the gateway serves (`06` §8.0). It is a literal, not configuration. */
export const API_PREFIX = '/api/v1';

/** Everything a route group is allowed to reach. Injected once, at composition time. */
export interface RouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /** Present only for a local/CI DEMO_MODE composition. */
  readonly demoAuth?: DemoCredentialStore;
  readonly demoWidgetSessions?: DemoWidgetSessionIssuer;
  /** Present only when `AUTH_PROVIDER=db`: the durable account store (T9.2). */
  readonly auth?: DatabaseAuthStore;
  /** Request-time environment accessor for routes whose capability gate may change in-process. */
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  readonly intentProposer?: TurnIntentPort;
  readonly turnRateLimiter?: TurnRateLimiter;
  readonly demoMode?: boolean;
  /**
   * Contract emit only: attach the refusal envelope as the 4xx/5xx response schema of every
   * operation. Never set at runtime — response schemas also drive serialization, and a strict
   * envelope would strip or reject route-specific refusal bodies.
   */
  readonly documentRefusals?: boolean;
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
  readonly companyCommands?: PlatformCompanyCommandsPort;
  /** Company user administration (T9.3); omitted leaves the invite/manage routes unmounted. */
  readonly userAdmin?: CompanyUserAdminPort;
  /** Public invitation redemption (T9.3); omitted leaves the accept routes unmounted. */
  readonly invitationAccept?: InvitationAcceptPort;
  readonly platformAdmins?: PlatformAdminsPort;
  readonly providers?: PlatformProvidersPort;
  readonly llmConfiguration?: LlmConfigurationPort;
  readonly knowledge?: KnowledgeRepository;
  /** Company skill management (T4.4); omitted leaves the route group unmounted. */
  readonly skills?: SkillsPort;
  /** Platform skill catalog + entitlement toggle (T4.4); omitted leaves the route group unmounted. */
  readonly platformSkills?: PlatformSkillsPort;
  /** Test Customer Lab repository (T7.2); omitted leaves the route group unmounted. */
  readonly testCustomers?: TestCustomersRepository;
  readonly widgetSessions?: TestWidgetSessionIssuer;
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

  // Every `/api/v1` operation answers the refusal envelope (`06` §1 `ErrorResponse`) on 4xx/5xx.
  // The contract emit adds it here, before the group plugin loads and therefore before
  // `@fastify/swagger` attaches its own `onRoute` collector, so no operation reaches the emitted
  // contract without a refusal schema. Groups that already document the exact status keep theirs.
  if (deps.documentRefusals === true) app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(API_PREFIX)) return;
    const existing = route.schema?.response;
    const response: Record<string, unknown> =
      existing !== null && typeof existing === 'object' ? { ...existing } : {};
    if (!('default' in response)) {
      if (!('4xx' in response)) response['4xx'] = errorEnvelopeResponse;
      if (!('5xx' in response)) response['5xx'] = errorEnvelopeResponse;
    }
    route.schema = { ...route.schema, response };
  });

  void app.register(
    (scope, _options, done) => {
      if (deps.auth !== undefined) {
        registerAuthRoutes(scope, {
          auth: deps.auth,
          runtime: deps.runtime,
        });
      }
      if (deps.demoAuth !== undefined) {
        registerDemoAuthRoutes(scope, {
          demoAuth: deps.demoAuth,
          runtime: deps.runtime,
        });
      }
      if (deps.demoWidgetSessions !== undefined) {
        registerDemoWidgetRoutes(scope, {
          credentials: deps.credentials,
          widgetSessions: deps.demoWidgetSessions,
          runtime: deps.runtime,
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
      }
      registerConversationRoutes(scope, admissionDeps);
      registerOperatorConversationRoutes(scope, deps);
      registerEventRoutes(scope, deps);
      registerApprovalRoutes(scope, deps);
      registerCompanySettingsRoutes(scope, deps);
      registerCompanyProfileRoutes(scope, deps);
      registerAuditRoutes(scope, deps);
      registerOperationRoutes(scope, deps);
      registerCustomerRoutes(scope, deps);
      registerAnalyticsRoutes(scope, deps);
      registerCompanyAnalyticsRoutes(scope, deps);
      registerCompanyAiTeamRoutes(scope, {
        runtime: deps.runtime,
        credentials: deps.credentials,
        ...(deps.knowledge === undefined ? {} : { knowledge: deps.knowledge }),
      });
      registerCompanyIntegrationsRoutes(scope, { runtime: deps.runtime, credentials: deps.credentials });
      registerStorefrontRoutes(scope, admissionDeps);
      registerCampaignRoutes(scope, deps);
      if (deps.knowledge !== undefined) {
        registerKnowledgeRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          knowledge: deps.knowledge,
        });
      }
      if (deps.skills !== undefined) {
        registerSkillRoutes(scope, {
          skills: deps.skills,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.platformSkills !== undefined) {
        registerPlatformSkillsRoutes(scope, {
          platformSkills: deps.platformSkills,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.testCustomers !== undefined) {
        registerTestingRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          testCustomers: deps.testCustomers,
          ...(deps.widgetSessions === undefined ? {} : { widgetSessions: deps.widgetSessions }),
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
      }
      if (deps.demoMode !== undefined && deps.readiness !== undefined && deps.trace !== undefined) {
        registerDemoReadinessRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          demoMode: deps.demoMode,
          readiness: deps.readiness,
          trace: deps.trace,
        });
      }
      if (deps.provisioning !== undefined) {
        registerProvisioningRoutes(scope, {
          provisioning: deps.provisioning,
          credentials: deps.credentials,
          runtime: deps.runtime,
          ...(deps.autonomyAdmin === undefined ? {} : { autonomyAdmin: deps.autonomyAdmin }),
        });
        registerCompanyOwnerInputsRoutes(scope, {
          ownerInputs: deps.provisioning,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.autonomyAdmin !== undefined) {
        registerAutonomyAdminRoutes(scope, {
          autonomyAdmin: deps.autonomyAdmin,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      registerPlatformHealthRoutes(scope, {
        runtime: deps.runtime,
        credentials: deps.credentials,
      });
      if (deps.platform !== undefined && deps.providers !== undefined && deps.llmConfiguration !== undefined) {
        registerPlatformRoutes(scope, {
          platform: deps.platform,
          providers: deps.providers,
          llmConfiguration: deps.llmConfiguration,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.platform !== undefined) {
        registerPlatformRunsRoutes(scope, {
          platform: deps.platform,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.platform !== undefined && deps.companyCommands !== undefined && deps.autonomyAdmin !== undefined) {
        registerPlatformCompaniesRoutes(scope, {
          platform: deps.platform,
          companyCommands: deps.companyCommands,
          autonomyAdmin: deps.autonomyAdmin,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.userAdmin !== undefined) {
        registerCompanyUserRoutes(scope, {
          userAdmin: deps.userAdmin,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
        registerPlatformInvitationRoutes(scope, {
          userAdmin: deps.userAdmin,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.platformAdmins !== undefined) {
        registerPlatformAdminRoutes(scope, {
          platformAdmins: deps.platformAdmins,
          credentials: deps.credentials,
          runtime: deps.runtime,
        });
      }
      if (deps.invitationAccept !== undefined) {
        registerInvitationRoutes(scope, {
          invitationAccept: deps.invitationAccept,
          runtime: deps.runtime,
        });
      }
      if (deps.llmConfiguration !== undefined) {
        registerCompanyLlmRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          llmConfiguration: deps.llmConfiguration,
          ...(deps.env === undefined ? {} : { env: deps.env }),
        });
        registerPlatformProviderRoutes(scope, {
          runtime: deps.runtime,
          credentials: deps.credentials,
          llmConfiguration: deps.llmConfiguration,
          ...(deps.env === undefined ? {} : { env: deps.env }),
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

/**
 * @file The composition root: the one place where ports meet implementations (implement/02 §2,
 * `06` §10.1).
 *
 * Every binding is explicit. An absent implementation throws `UnboundPortError` and is named
 * at composition time; no request receives a value the platform never observed. Reservation,
 * approval and evidence rules remain with their owning repositories. The composed path currently
 * reaches durable projections, identity lookup, Redis takeover leases, and PostgreSQL handoff assignment/completion.
 * Agent planning, policy evaluation and skill dispatch require a production orchestrator graph and remain unbound.
 */

import { ConnectorRegistry, type EventAliasNormalizer, type HmacSha256Hex } from '@agentos/adapters';
import {
  LlmCallRecorder,
  LlmConfigResolver,
  LlmUsageRecorder,
  SecretResolver,
  createSecretCipher,
  createRuntimeRedisClient,
  type RuntimeRedisClient,
} from '@agentos/core-engine';
import {
  LlmConfigRepository,
  AgentActivationRepository,
  SecretRepository,
  ApprovalRepository,
  AuditRepository,
  CareHandoffRepository,
  ConversationRepository,
  CustomerEventRepository,
  CompanyCrmProjectionRepository,
  CompanyProjectionRepository,
  ConnectorBindingRepository,
  PlatformCompanyRepository,
  PlatformDirectoryRepository,
  PlatformAuditRepository,
  P5AutonomyRepository,
  DurableWorkflowRepository,
  EffectReservationRepository,
  EvidenceRepository,
  IdentityRepository,
  KnowledgeRepository,
  RunResponseRepository,
  RunStageEventsRepository,
  SkillCatalogRepository,
  PlatformSkillFleetHealthRepository,
  TenantProfileRepository,
  TenantGovernanceRepository,
  TestCustomersRepository,
  withTenantContext,
  type RedisInjectedClient,
  type PlatformTransactionRunner,
  type TenantTransactionRunner,
} from '@agentos/database';
import { createDatabaseAuthStore, type DatabaseAuthStore } from './db-auth.js';
import { createFileEmailSender, createLogOnlyEmailSender } from './email.js';
import { createCompanyUserAdminPort, createInvitationAcceptPort, createPlatformAdminsPort } from './user-admin.js';
import { createSkillsPort, createPlatformSkillsPort, type SkillReadDispatcher } from './skills-port.js';
import type { SkillsPort } from '../routes/v1/skills.js';
import type { PlatformSkillsPort } from '../routes/v1/platform-skills.js';
import { PLATFORM_SKILL_ROWS } from '@agentos/skills';

import type {
  ApprovalPort,
  CompanyIntegrationsPort,
  CompanyProjectionPort,
  CompanyUserAdminPort,
  EmailSenderPort,
  GatewayAuditPort,
  InvitationAcceptPort,
  PlatformAdminsPort,
  PlatformCompanyCommandsPort,
  PlatformDirectoryPort,
  PlatformProvidersPort,
  GatewayRuntime,
  IdentityPort,
  RunPort,
  TakeoverLeasePort,
} from '../gateway/ports.js';
import {
  RedisTurnRateLimiter,
  parseEnabledAgentModules,
  parseMarketingSignalEventTypes,
  parseSalesSignalEventTypes,
  type TurnRateLimiter,
} from '../routes/v1/care-turn.js';
import { createCredentialStore, type CredentialStore } from '../gateway/principal.js';
import {
  createCanonicalEventNormalizer,
  createWebhookVerificationPort,
  nodeHmacSha256Hex,
  type ChannelSecretStore,
} from './adapters.js';
import {
  createApprovalDecisionPort,
  createApprovalReadPort,
  createCareHandoffPort,
  createCompanyCrmPort,
  createCompanyProjectionPort,
  createConversationPort,
  createDurableRunPort,
  createEffectGuard,
  createGovernancePort,
  createPlatformDirectoryPort,
  createStartRunPort,
  createEventPort,
  createIdentityPort,
  createReceiptPort,
  createTakeoverLeasePort,
  systemClock,
  systemIdentifiers,
} from './bindings.js';
import {
  createDemoCredentialStore,
  type DemoCredentialStore,
} from './demo-auth.js';
import { createWidgetSessionRegistry } from './widget-sessions.js';
import { createP5Ports, type P5Ports } from './p5-ports.js';
import type { DemoReadinessPort, RunTracePort } from '../routes/v1/demo-readiness.js';
import type { TestWidgetSessionIssuer } from '../routes/v1/testing.js';
import type { DemoWidgetSessionIssuer } from '../routes/v1/demo-widget.js';
import { createTurnIntentPort, type TurnIntentPort } from './bindings/turn-intent.js';
import { createTestCustomerArtifactPurger } from './test-customer-artifacts.js';
import { createLlmConfigurationPort } from './bindings/llm-configuration.js';
import type { LlmConfigurationPort } from '../routes/v1/company-llm.js';

/**
 * A capability this build does not bind.
 *
 * Raised before the missing operation mutates durable state. No value is returned and no
 * reservation is created on these paths; the gateway reports a typed refusal.
 */
export class UnboundPortError extends Error {
  constructor(readonly port: string, readonly capability: string) {
    super(
      `PORT_UNBOUND: ${port} has no implementation in this build (${capability}); the operation is refused rather than answered with an unobserved value`,
    );
    this.name = 'UnboundPortError';
  }
}

/** The gateway code a route reports for a capability this build does not provide. */
function unbound(port: string, capability: string): never {
  throw new UnboundPortError(port, capability);
}

/** Environment the composition root reads. Nothing else is consulted, and no secret is logged. */
export interface GatewayEnv {
  readonly APP_ENV?: string;
  /** Node runtime mode does not select the deployment profile; APP_ENV owns production guards. */
  readonly NODE_ENV?: string;
  readonly AUTH_PROVIDER?: string;
  readonly DEMO_MODE?: string;
  readonly DEMO_COMPANY_ADMIN_EMAIL?: string;
  readonly DEMO_COMPANY_ADMIN_PASSWORD?: string;
  readonly DEMO_PLATFORM_ADMIN_EMAIL?: string;
  readonly DEMO_PLATFORM_ADMIN_PASSWORD?: string;
  /** Display name for the demo company session (seeded profile name); defaults to "Demo". */
  readonly DEMO_TENANT_NAME?: string;
  /** Legacy names remain readable only to produce an explicit migration error. */
  readonly DEMO_TENANT_OPERATOR_PASSWORD?: string;
  readonly DEMO_MARKETING_APPROVER_PASSWORD?: string;
  /** Local/CI demo switch that disables provider calls while retaining boot-time schema checks. */
  readonly DEMO_PROVIDER_MODE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly PRIMARY_REASONING_MODEL?: string;
  /** The classifier model: the gateway's bounded intent proposal and other latency-sensitive calls. */
  readonly FAST_COMPLETION_MODEL?: string;
  readonly LLM_REQUEST_TIMEOUT_MS?: string;
  readonly LLM_MAX_OUTPUT_TOKENS_PER_CALL?: string;
  readonly MAX_TOKENS_PER_RUN?: string;
  /** Tenant-wide LLM token ceiling checked against persisted token_cost_records; omitted = no limit. */
  readonly LLM_TENANT_TOKEN_BUDGET?: string;
  readonly OPENAI_STRUCTURED_OUTPUT_MODE?: string;
  readonly ENCRYPTION_KEY_AES256?: string;
  readonly ENCRYPTION_KEY_AES256_PREVIOUS?: string;
  readonly MOCK_ERP_ENABLED?: string;
  readonly ERP_API_BASE_URL?: string;
  readonly MOCK_SECRET_KEY?: string;
  readonly KNOWLEDGE_ROOT?: string;
  readonly KNOWLEDGE_TENANT_IDS?: string;
  readonly EVENT_INGESTION_BASE_URL?: string;
  readonly SESSION_SECRET?: string;
  /** Invitation delivery backend; `file` stores single-use links only in a local/CI outbox. */
  readonly EMAIL_TRANSPORT?: string;
  readonly EMAIL_OUTBOX_DIR?: string;
  readonly PLATFORM_SECRET?: string;
  /** JWT signing key for API tokens; it is never used as a session-signing fallback. */
  readonly JWT_SECRET?: string;
  /** Generic callback signature secret; it is never reused for platform webhook or session signing. */
  readonly WEBHOOK_HMAC_SECRET?: string;
  /** Presence of a non-empty URL enables database-backed P5 route ports. */
  readonly DATABASE_URL?: string;
  /** Tenant console origin used to build invitation accept links (T9.3). */
  readonly WEB_BASE_URL?: string;
  /** Platform console origin used for platform administrator invitation links. */
  readonly PLATFORM_ADMIN_BASE_URL?: string;
  readonly READINESS_ATTEMPTS?: string;
  readonly REDIS_HOST?: string;
  readonly REDIS_PORT?: string;
  readonly REDIS_PASSWORD?: string;
  readonly REDIS_DB?: string;
  readonly QDRANT_URL?: string;
  readonly QDRANT_API_KEY?: string;
  readonly ENABLED_AGENT_MODULES?: string;
  readonly SALES_SIGNAL_EVENT_TYPES?: string;
  readonly MARKETING_SIGNAL_EVENT_TYPES?: string;
}

/** The assembled gateway runtime, credentials, optional shared limiter and route bindings. */
export interface GatewayComposition {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly demoAuth?: DemoCredentialStore;
  readonly demoWidgetSessions?: DemoWidgetSessionIssuer;
  /** Present when `AUTH_PROVIDER=db`: durable sessions for both consoles (T9.2). */
  readonly auth?: DatabaseAuthStore;
  readonly turnRateLimiter?: TurnRateLimiter;
  readonly intentProposer?: TurnIntentPort;
  readonly llmConfiguration: LlmConfigurationPort;
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  readonly demoMode: boolean;
  readonly readiness: DemoReadinessPort;
  readonly trace: RunTracePort;
  readonly normalizer: EventAliasNormalizer;
  readonly companyProjections: CompanyProjectionPort;
  readonly platform?: PlatformDirectoryPort;
  readonly companyCommands: PlatformCompanyCommandsPort;
  /** Company user administration and invitation redemption (T9.3); present with durable identity. */
  readonly userAdmin?: CompanyUserAdminPort;
  readonly invitationAccept?: InvitationAcceptPort;
  readonly platformAdmins?: PlatformAdminsPort;
  /** Outbound email seam; the local/CI binding is log-only. */
  readonly email?: EmailSenderPort;
  /** Test Customer Lab (T7.2); present only when this composition has a database binding. */
  readonly testCustomers?: TestCustomersRepository;
  readonly widgetSessions?: TestWidgetSessionIssuer;
  readonly providers: PlatformProvidersPort;
  /** Tenant knowledge lifecycle; present only when this composition has a database binding. */
  readonly knowledge?: KnowledgeRepository;
  /** Skill management (T4.4); present only when this composition has a database binding. */
  readonly skills?: SkillsPort;
  readonly platformSkills?: PlatformSkillsPort;
  /** P5 ports are present only when this composition has a database binding. */
  readonly provisioning?: P5Ports['provisioning'];
  readonly autonomyAdmin?: P5Ports['autonomyAdmin'];
  /** Capabilities this build does not bind, named for the boot log and the report. */
  readonly unbound: readonly string[];
  readonly enabledModules: readonly string[];
  readonly salesSignalEventTypes: readonly string[];
  readonly marketingSignalEventTypes: readonly string[];
  readonly close: () => Promise<void>;
}

/** Reads a required secret without ever publishing its value. */
function requireSecret(value: string | undefined, name: 'SESSION_SECRET' | 'PLATFORM_SECRET'): string {
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error(
      `${name}: the gateway refuses to start without a signing secret of at least 16 characters; a missing secret would issue unsigned session tokens or verify nothing`,
    );
  }
  return value;
}

/**
 * Resolves the gateway's signing material from the deployment's validated secrets.
 *
 * Session signing requires its dedicated SESSION_SECRET. The platform webhook secret is optional
 * at composition time: production verification resolves tenant/source secrets from the injected
 * server-side store, and no other purpose-specific secret is used as a fallback.
 */
function resolveSecrets(env: GatewayEnv): {
  readonly session_secret: string;
  readonly platform_secret?: string;
} {
  const platform_secret = env.PLATFORM_SECRET;
  return {
    session_secret: requireSecret(env.SESSION_SECRET, 'SESSION_SECRET'),
    ...(platform_secret === undefined
      ? {}
      : { platform_secret: requireSecret(platform_secret, 'PLATFORM_SECRET') }),
  };
}


/** Redis configuration is optional only when no Redis field is present (unit-test composition). */
function redisConfiguration(env: GatewayEnv): {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly db: number;
} | null {
  const configured =
    env.REDIS_HOST !== undefined ||
    env.REDIS_PORT !== undefined ||
    env.REDIS_PASSWORD !== undefined ||
    env.REDIS_DB !== undefined;
  if (!configured) return null;

  const host = env.REDIS_HOST ?? '';
  const password = env.REDIS_PASSWORD ?? '';
  const port = Number.parseInt(env.REDIS_PORT ?? '6379', 10);
  const db = Number.parseInt(env.REDIS_DB ?? '0', 10);
  return { host, port, password, db };
}

function demoModeEnabled(env: GatewayEnv): boolean {
  if (env.DEMO_MODE !== 'true') return false;
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    throw new Error('DEMO_MODE requires APP_ENV=local or APP_ENV=ci');
  }
  return true;
}

function demoCredentialStore(env: GatewayEnv): DemoCredentialStore {
  const required = [
    env.DEMO_COMPANY_ADMIN_EMAIL,
    env.DEMO_COMPANY_ADMIN_PASSWORD,
    env.DEMO_PLATFORM_ADMIN_EMAIL,
    env.DEMO_PLATFORM_ADMIN_PASSWORD,
  ];
  const missing = required.some((value) => typeof value !== 'string' || value.length === 0);
  if (missing && (env.DEMO_TENANT_OPERATOR_PASSWORD !== undefined || env.DEMO_MARKETING_APPROVER_PASSWORD !== undefined)) {
    throw new Error(
      'DEMO_AUTH_ENV_MIGRATION_REQUIRED: DEMO_COMPANY_ADMIN_EMAIL, DEMO_COMPANY_ADMIN_PASSWORD, DEMO_PLATFORM_ADMIN_EMAIL, DEMO_PLATFORM_ADMIN_PASSWORD',
    );
  }
  if (missing) {
    throw new Error(
      'DEMO_MODE requires DEMO_COMPANY_ADMIN_EMAIL, DEMO_COMPANY_ADMIN_PASSWORD, DEMO_PLATFORM_ADMIN_EMAIL, and DEMO_PLATFORM_ADMIN_PASSWORD',
    );
  }
  return createDemoCredentialStore({
    companyAdminEmail: env.DEMO_COMPANY_ADMIN_EMAIL as string,
    companyAdminPassword: env.DEMO_COMPANY_ADMIN_PASSWORD as string,
    platformAdminEmail: env.DEMO_PLATFORM_ADMIN_EMAIL as string,
    platformAdminPassword: env.DEMO_PLATFORM_ADMIN_PASSWORD as string,
    ...(env.DEMO_TENANT_NAME === undefined ? {} : { tenantName: env.DEMO_TENANT_NAME }),
  });
}

/**
 * Tenant budgets are unlimited when omitted; the per-run ceiling defaults to 4096 tokens. Malformed
 * values refuse composition instead of silently disabling the guard.
 */
export function parseLlmBudgetConfig(env: GatewayEnv): { token_budget?: number; per_run_token_budget: number } {
  const parse = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer token count`);
    }
    return value;
  };
  const token_budget = parse('LLM_TENANT_TOKEN_BUDGET', env.LLM_TENANT_TOKEN_BUDGET);
  const per_run_token_budget = parse('MAX_TOKENS_PER_RUN', env.MAX_TOKENS_PER_RUN) ?? 4096;
  return {
    ...(token_budget === undefined ? {} : { token_budget }),
    per_run_token_budget,
  };
}

/**
 * Assembles the durable gateway over the repositories that already own their tables.
 *
 * @param env The process environment; only the fields of {@link GatewayEnv} are read.
 * @param options.credentials Optional credential store override, used by tests.
 * @param options.channelSecrets Optional channel/platform secret store override.
 * @param options.hmac Optional HMAC primitive override.
 * @param options.connectors Optional connector registry; an empty registry dispatches nothing.
 * @returns The composition, with the unbound capabilities named.
 */
export function createGatewayComposition(
  env: GatewayEnv,
  options?: {
    readonly credentials?: CredentialStore;
    readonly channelSecrets?: ChannelSecretStore;
    readonly hmac?: HmacSha256Hex;
    readonly connectors?: ConnectorRegistry;
    /** Injected takeover store. The composition closes only clients it constructed itself. */
    readonly redis?: RedisInjectedClient;
    /** Injected tenant transaction runner for database-backed P5 ports. */
    readonly databaseRunner?: TenantTransactionRunner;
    /** Injected platform transaction runner for directory and audit projections. */
    readonly platformDatabaseRunner?: PlatformTransactionRunner;
    /** Injected READ dispatch seam for skill tests; absent leaves READ tests refused. */
    readonly readDispatcher?: SkillReadDispatcher;
  },
): GatewayComposition {
  const enabledModules = parseEnabledAgentModules(env.ENABLED_AGENT_MODULES);
  const salesSignalEventTypes = parseSalesSignalEventTypes(env.SALES_SIGNAL_EVENT_TYPES);
  const marketingSignalEventTypes = parseMarketingSignalEventTypes(env.MARKETING_SIGNAL_EVENT_TYPES);
  // The account store is chosen before anything is built from it: `AUTH_PROVIDER=db` replaces the
  // demo store rather than sitting beside it, so a DEMO tenant cannot authenticate twice over.
  const authProvider = (env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  if (authProvider !== 'db' && authProvider !== 'demo') {
    throw new Error('AUTH_PROVIDER: accepted values are `db` and `demo`');
  }
  if (env.APP_ENV === 'production' && authProvider !== 'db') {
    throw new Error('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB: production requires AUTH_PROVIDER=db');
  }
  const demo_enabled = demoModeEnabled(env);
  const demoAuth = demo_enabled && authProvider === 'demo' ? demoCredentialStore(env) : undefined;
  const hasDatabase = options?.databaseRunner !== undefined
    || (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim().length > 0);
  const tokenCosts = hasDatabase ? new P5AutonomyRepository(options?.databaseRunner) : undefined;
  const usageRecorder = tokenCosts === undefined
    ? undefined
    : new LlmUsageRecorder({
        sink: tokenCosts,
        reservationStore: tokenCosts,
        reader: { totalTokensForTenant: (tenant_id) => tokenCosts.totalTokenUsage(tenant_id) },
        budgetConfig: parseLlmBudgetConfig(env),
      });
  const callRecorder = usageRecorder === undefined
    ? undefined
    : new LlmCallRecorder({
        usage: usageRecorder,
        providerCalls: new RunStageEventsRepository(options?.databaseRunner),
      });
  const llmConfigRepository = new LlmConfigRepository({
    ...(options?.databaseRunner === undefined ? {} : { tenantTransaction: options.databaseRunner }),
    ...(options?.platformDatabaseRunner === undefined ? {} : { platformTransaction: options.platformDatabaseRunner }),
  });
  const configReader = {
    async getTenantOverride(tenant_id: string) {
      if (!hasDatabase) return null;
      const config = await llmConfigRepository.getTenantOverride(tenant_id);
      if (config === null) return null;
      return {
        mode: config.mode,
        provider_id: config.provider_id,
        base_url: config.base_url ?? null,
        reasoning_model: config.reasoning_model ?? null,
        fast_model: config.fast_model ?? null,
        timeout_ms: config.timeout_ms ?? null,
        structured_mode: config.structured_mode ?? null,
        secret_id: config.secret_id ?? null,
        config_version: config.config_version,
      };
    },
    getPlatformDefault: () => hasDatabase
      ? llmConfigRepository.getPlatformDefault()
      : Promise.resolve(null),
  };
  const resolverEnv = env as Readonly<Record<string, string | undefined>>;
  const secretCipher = env.ENCRYPTION_KEY_AES256 === undefined
    ? null
    : createSecretCipher(resolverEnv);
  const secretRepository = new SecretRepository(
    secretCipher ?? { encrypt: () => { throw new Error('SECRET_ENCRYPTION_KEY_INVALID'); } },
    options?.databaseRunner,
    options?.platformDatabaseRunner,
  );
  const secretResolver = new SecretResolver(
    secretRepository,
    secretCipher ?? { decrypt: () => { throw new Error('SECRET_ENCRYPTION_KEY_INVALID'); } },
  );
  const llmConfiguration = createLlmConfigurationPort({
    configurations: llmConfigRepository,
    secrets: secretRepository,
    secretResolver,
  });
  const llmConfigResolver = new LlmConfigResolver(configReader, secretResolver, resolverEnv);
  const intentProposer = createTurnIntentPort(
    env as NodeJS.ProcessEnv,
    {
      ...(callRecorder === undefined ? {} : { callRecorder }),
      configResolver: llmConfigResolver,
    },
  );
  const { session_secret, platform_secret } = resolveSecrets(env);
  const useGlobalWebhookFallback = env.APP_ENV === 'local' || env.APP_ENV === 'ci';
  // Production requires `AUTH_PROVIDER=db` and a database; the in-memory demo store stays available
  // only for non-production DEMO tenants in local/CI.
  if (authProvider === 'db' && !hasDatabase) {
    throw new Error('AUTH_PROVIDER: durable identity requires DATABASE_URL; the API did not start');
  }
  const identityRepository = new IdentityRepository();
  const tenantProfileRepository = new TenantProfileRepository(options?.databaseRunner);
  const dbAuth = authProvider === 'db'
    ? createDatabaseAuthStore({
        identity: identityRepository,
        session_secret,
        describeTenant: (tenant_id) => tenantProfileRepository.getDisplayName(tenant_id),
      })
    : undefined;
  const emailTransport = env.EMAIL_TRANSPORT ?? 'log';
  if (emailTransport !== 'log' && emailTransport !== 'file') {
    throw new Error('EMAIL_TRANSPORT: accepted values are `log` and `file`');
  }
  if (emailTransport === 'file') {
    if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
      throw new Error('EMAIL_TRANSPORT=file is available only when APP_ENV is local or ci');
    }
    if (typeof env.EMAIL_OUTBOX_DIR !== 'string' || env.EMAIL_OUTBOX_DIR.trim().length === 0) {
      throw new Error('EMAIL_OUTBOX_DIR is required for the file email transport');
    }
  }
  // Invitation routes require both durable identity and a local/CI transport. In every other
  // profile they remain unbound rather than pretending that a message was delivered.
  const emailSender = authProvider === 'db' && (env.APP_ENV === 'local' || env.APP_ENV === 'ci')
    ? emailTransport === 'file'
      ? createFileEmailSender({ appEnv: env.APP_ENV, outboxDir: env.EMAIL_OUTBOX_DIR ?? '' })
      : createLogOnlyEmailSender()
    : undefined;
  const userAdmin = emailSender === undefined
    ? undefined
    : createCompanyUserAdminPort({
        identity: identityRepository,
        email: emailSender,
        console_base_url: env.WEB_BASE_URL ?? 'http://localhost:3000',
      });
  const platformAdmins = emailSender === undefined
    ? undefined
    : createPlatformAdminsPort({
        identity: identityRepository,
        email: emailSender,
        console_base_url: env.PLATFORM_ADMIN_BASE_URL ?? 'http://localhost:3001',
      });
  const invitationAccept = dbAuth === undefined
    ? undefined
    : createInvitationAcceptPort({ identity: identityRepository });
  const baseCredentials = options?.credentials ?? dbAuth ?? demoAuth ?? createCredentialStore({
    operators: [],
    sessions: [],
    widgets: [],
    session_secret,
  });
  const dbWidgetSessions = dbAuth === undefined ? undefined : createWidgetSessionRegistry();
  const credentials: CredentialStore = dbWidgetSessions === undefined
    ? baseCredentials
    : {
        resolveOperator: (token) => baseCredentials.resolveOperator(token),
        ...(baseCredentials.resolveOperatorAsync === undefined
          ? {}
          : { resolveOperatorAsync: baseCredentials.resolveOperatorAsync.bind(baseCredentials) }),
        resolveConversationSession: (token) => baseCredentials.resolveConversationSession(token),
        resolveWidgetSession: (token) =>
          dbWidgetSessions.resolve(token) ?? baseCredentials.resolveWidgetSession(token),
      };
  const widgetSessions: TestWidgetSessionIssuer | undefined = demoAuth !== undefined
    ? {
        issue: async ({ tenant_id, session_id, origin }) =>
          demoAuth.issueWidget(session_id, origin, tenant_id),
      }
    : dbWidgetSessions === undefined
      ? undefined
      : {
          issue: async (input) => {
            if (input.data_class !== 'TEST') throw new Error('TEST_CUSTOMER_NOT_TEST_DATA');
            return dbWidgetSessions.issue({
              tenant_id: input.tenant_id,
              customer_id: input.customer_id,
              session_id: input.session_id,
              origin: input.origin,
            });
          },
        };
  const hmac = options?.hmac ?? nodeHmacSha256Hex;

  const p5: P5Ports | undefined = hasDatabase
    ? createP5Ports(options?.databaseRunner === undefined ? {} : { databaseRunner: options.databaseRunner })
    : undefined;

  const conversationsRepository = new ConversationRepository();
  const careHandoffsRepository = new CareHandoffRepository();
  const eventsRepository = new CustomerEventRepository();
  const reservationsRepository = new EffectReservationRepository();
  const workflowsRepository = new DurableWorkflowRepository();
  const approvalsRepository = new ApprovalRepository();
  const governanceRepository = new TenantGovernanceRepository(options?.databaseRunner);
  const companyCrmRepository = new CompanyCrmProjectionRepository(options?.databaseRunner);
  const companyProjectionRepository = new CompanyProjectionRepository(options?.databaseRunner);
  const testCustomersRepository = hasDatabase
    ? new TestCustomersRepository(
        options?.databaseRunner === undefined ? {} : { tenantTransaction: options.databaseRunner },
      )
    : undefined;
  const knowledgeRepository = hasDatabase
    ? new KnowledgeRepository(options?.databaseRunner === undefined
        ? {}
        : { tenantTransaction: options.databaseRunner })
    : undefined;
  const companyAiTeamRepository = hasDatabase
    ? new AgentActivationRepository({
        ...(options?.databaseRunner === undefined ? {} : { tenantTransaction: options.databaseRunner }),
        ...(options?.platformDatabaseRunner === undefined ? {} : { platformTransaction: options.platformDatabaseRunner }),
      })
    : undefined;
  const connectorBindings = new ConnectorBindingRepository(options?.databaseRunner);
  const skillCatalogRepository = hasDatabase
    ? new SkillCatalogRepository(options?.databaseRunner === undefined ? {} : { tenantTransaction: options.databaseRunner })
    : undefined;
  // Widget launching uses the active account provider; it never exposes a second demo login.
  const demoWidgetSessions: DemoWidgetSessionIssuer | undefined = !demo_enabled
    ? undefined
    : demoAuth !== undefined
      ? {
          issue: ({ tenant_id, session_id, origin }) => demoAuth.issueWidget(session_id, origin, tenant_id),
          isDemoTenant: async () => true, // The route additionally requires the canonical demo tenant.
        }
      : dbWidgetSessions === undefined
        ? undefined
        : {
            issue: (input) => dbWidgetSessions.issue(input),
            isDemoTenant: async (tenant_id) => await skillCatalogRepository?.tenantDataClass(tenant_id) === 'DEMO',
          };
  const demoErpEligibleForTenant = async (tenant_id: string): Promise<boolean> =>
    env.MOCK_ERP_ENABLED === 'true'
    && /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.test(env.ERP_API_BASE_URL ?? '')
    && (env.MOCK_SECRET_KEY?.length ?? 0) >= 16
    && await skillCatalogRepository?.tenantDataClass(tenant_id) === 'DEMO';
  const companyIntegrations: CompanyIntegrationsPort | undefined = hasDatabase
    ? {
        listBindings: (tenant_id) => connectorBindings.list(tenant_id),
        getBinding: (tenant_id, connector_id) => connectorBindings.get(tenant_id, connector_id),
        demoErpEligibleForTenant,
        putConfig: (tenant_id, connector_id, input, actor, expectedVersion) =>
          connectorBindings.putConfig(tenant_id, connector_id, input, actor, expectedVersion),
        recordProbe: (tenant_id, connector_id, result) => connectorBindings.recordProbe(tenant_id, connector_id, result),
        disconnect: (tenant_id, connector_id, actor, expectedVersion) =>
          connectorBindings.disconnect(tenant_id, connector_id, actor, expectedVersion),
        putSecret: (tenant_id, input) => secretRepository.put(tenant_id, input),
        describeSecret: (tenant_id, secret_id) => secretRepository.describe(tenant_id, secret_id),
        revokeSecret: (tenant_id, secret_id, context) => secretRepository.revoke(tenant_id, secret_id, context),
        resolveSecret: (tenant_id, secret_id) => secretResolver.resolve(tenant_id, secret_id),
      }
    : undefined;
  const platformDirectoryRepository = hasDatabase
    ? new PlatformDirectoryRepository(
        options?.platformDatabaseRunner === undefined
          ? {}
          : { transaction: options.platformDatabaseRunner },
      )
    : undefined;
  const auditHistoryRepository = new PlatformAuditRepository({
    ...(options?.databaseRunner === undefined ? {} : { tenantTransaction: options.databaseRunner }),
    ...(options?.platformDatabaseRunner === undefined ? {} : { platformTransaction: options.platformDatabaseRunner }),
  });
  const evidenceRepository = new EvidenceRepository();
  const responseRepository = new RunResponseRepository(options?.databaseRunner);
  const auditRepository = new AuditRepository();

  const effectGuard = createEffectGuard(reservationsRepository);
  const stageRepository = new RunStageEventsRepository(options?.databaseRunner);
  const durableRuns = createDurableRunPort(
    workflowsRepository,
    evidenceRepository,
    reservationsRepository,
    workflowsRepository,
    responseRepository,
    stageRepository,
  );
  const approvalReads = createApprovalReadPort(approvalsRepository);
  const governance = createGovernancePort(governanceRepository);
  const companyCrm = createCompanyCrmPort(companyCrmRepository);
  const companyProjections = createCompanyProjectionPort(companyProjectionRepository);
  const platform = platformDirectoryRepository === undefined
    ? undefined
    : createPlatformDirectoryPort(platformDirectoryRepository);
  const platformCompanyRepository = new PlatformCompanyRepository(
    options?.platformDatabaseRunner === undefined ? {} : { platformTransaction: options.platformDatabaseRunner },
  );
  const companyCommands: PlatformCompanyCommandsPort = {
    suspend: (input) => platformCompanyRepository.suspend(input.tenant_id),
    resume: (input) => platformCompanyRepository.resume(input.tenant_id),
  };
  const handoffs = createCareHandoffPort(careHandoffsRepository);

  let ownedRedis: RuntimeRedisClient | null = null;
  const redisConfig = options?.redis === undefined ? redisConfiguration(env) : null;
  if (options?.redis === undefined && redisConfig !== null) {
    ownedRedis = createRuntimeRedisClient(redisConfig);
  }
  const redis = options?.redis ?? ownedRedis;

  const unbound_ports: string[] = [];
  if (userAdmin === undefined) unbound_ports.push('companies.invite/users.manage');
  if (invitationAccept === undefined) unbound_ports.push('auth.invitations.accept');

  const offlineDemoProvider = env.DEMO_MODE === 'true'
    && env.DEMO_PROVIDER_MODE?.trim().toLowerCase() === 'offline'
    && (env.APP_ENV === 'local' || env.APP_ENV === 'ci');
  const providers: PlatformProvidersPort = {
    list: async () => {
      const platformProvider = hasDatabase ? await llmConfigRepository.getPlatformDefault() : null;
      const configuredProvider = platformProvider === null
        ? !offlineDemoProvider && Boolean(env.OPENAI_API_KEY?.trim() && env.PRIMARY_REASONING_MODEL?.trim())
        : platformProvider.secret_id !== null;
      return [{
        provider: platformProvider?.provider_id ?? 'openai-compatible',
        configured: configuredProvider,
        mode: offlineDemoProvider ? 'DEMO_MOCK' : configuredProvider ? 'LIVE' : 'NOT_CONFIGURED',
      }];
    },
  };
  const startRunPort = createStartRunPort({
    guard: effectGuard,
    workflows: workflowsRepository,
    ids: systemIdentifiers,
    clock: systemClock,
  });

  const runs: RunPort = {
    ...startRunPort,
    ...durableRuns,
  };

  const approvals: ApprovalPort = {
    ...approvalReads,
    ...createApprovalDecisionPort(approvalsRepository),
  };

  const takeover: TakeoverLeasePort =
    redis === null
      ? {
          acquire: async () => unbound('takeover.acquire', 'no Redis lease store is configured'),
          renew: async () => unbound('takeover.renew', 'no Redis lease store is configured'),
          release: async () => unbound('takeover.release', 'no Redis lease store is configured'),
          holder: async () => unbound('takeover.holder', 'no Redis lease store is configured'),
        }
      : createTakeoverLeasePort(redis, systemClock);
  if (redis === null) {
    unbound_ports.push('takeover.acquire/renew/release/holder');
  }

  const identity: IdentityPort = createIdentityPort();

  const audit: GatewayAuditPort = {
    record: async (input) => {
      // The gateway's per-operation row joins the same chained table the engine writes, so a tenant
      // has one process-event chain rather than two (`08` §4.1).
      //
      // Vocabulary note, recorded as an unresolved dependency rather than papered over: the stored
      // row is typed with an agent identity and an authority level, and neither vocabulary has a
      // member that means "the platform produced this row". `HUMAN_HANDOFF` is the only
      // non-agent member of `PlatformAgentId`, and `AUTH-0` is the lowest clearance, so a gateway
      // operation is recorded with those two and its true principal is carried in `context`. A
      // dedicated platform identity in `04`'s vocabulary would remove the approximation.
      await auditRepository.append({
        run_id: input.correlation_id,
        tenant_id: input.tenant_id,
        agent_id: 'HUMAN_HANDOFF',
        customer_or_entity_id: input.operator_id ?? input.principal_kind,
        trigger: 'gateway',
        context: {
          principal_kind: input.principal_kind,
          operation: input.operation,
          ...(input.operator_id === undefined ? {} : { operator_id: input.operator_id }),
        },
        skill: input.operation,
        tool: 'gateway',
        decision: { outcome: input.outcome, error_code: input.error_code ?? null },
        authority: 'AUTH-0',
        approval: null,
        action: null,
        execution_status: input.outcome === 'ACCEPTED' ? 'success' : 'denied',
        evidence: null,
        outcome: input.detail ?? null,
        latency_ms: 0,
        cost: null,
        error: input.error_code === undefined ? null : { code: input.error_code },
      });
    },
  };

  const platformSkillFleetHealthRepository = hasDatabase
    ? new PlatformSkillFleetHealthRepository(
        options?.platformDatabaseRunner === undefined ? {} : { transaction: options.platformDatabaseRunner },
      )
    : undefined;
  const skillContractById = new Map(PLATFORM_SKILL_ROWS.map((row) => [row.skill_id, row] as const));
  const skillsPort = skillCatalogRepository === undefined
    ? undefined
    : createSkillsPort({
        skills: skillCatalogRepository,
        contractOf: (skill_id) => skillContractById.get(skill_id) ?? null,
        connectors: connectorBindings,
        demoErpEligibleForTenant,
        ...(options?.readDispatcher === undefined ? {} : { readDispatcher: options.readDispatcher }),
      });
  const platformSkillsPort = skillCatalogRepository === undefined || platformSkillFleetHealthRepository === undefined
    ? undefined
    : createPlatformSkillsPort(skillCatalogRepository, platformSkillFleetHealthRepository);

  const runtime: GatewayRuntime = {
    conversations: createConversationPort(conversationsRepository, { session_secret }),
    takeover,
    handoffs,
    runs,
    approvals,
    governance,
    companyProfile: tenantProfileRepository,
    companyCrm,
    auditHistory: auditHistoryRepository,
    companyProjections,
    ...(companyAiTeamRepository === undefined ? {} : { companyAiTeam: companyAiTeamRepository }),
    ...(companyIntegrations === undefined ? {} : { companyIntegrations }),
    events: createEventPort(eventsRepository),
    timeline: createEventPort(eventsRepository),
    identity,
    testCustomerArtifacts: createTestCustomerArtifactPurger({
      ...(ownedRedis === null ? {} : { redis: ownedRedis }),
      ...(env.QDRANT_URL === undefined ? {} : { qdrantUrl: env.QDRANT_URL }),
      ...(env.QDRANT_API_KEY === undefined ? {} : { qdrantApiKey: env.QDRANT_API_KEY }),
    }),
    webhooks: createWebhookVerificationPort({
      channelSecrets:
        options?.channelSecrets ??
        ({
          resolve: async () => null,
          resolvePlatform: async () =>
            useGlobalWebhookFallback ? (platform_secret ?? null) : null,
        } satisfies ChannelSecretStore),
      hmac,
    }),
    audit,
    providerCalls: stageRepository,
    receipts: createReceiptPort(effectGuard),
    effects: effectGuard,
    clock: systemClock,
    ids: systemIdentifiers,
  };

  return {
    runtime,
    companyProjections,
    ...(platform === undefined ? {} : { platform }),
    companyCommands,
    ...(emailSender === undefined ? {} : { email: emailSender }),
    ...(userAdmin === undefined ? {} : { userAdmin }),
    ...(platformAdmins === undefined ? {} : { platformAdmins }),
    ...(invitationAccept === undefined ? {} : { invitationAccept }),
    providers,
    ...(skillsPort === undefined ? {} : { skills: skillsPort }),
    ...(platformSkillsPort === undefined ? {} : { platformSkills: platformSkillsPort }),
    credentials,
    ...(demoAuth === undefined ? {} : { demoAuth }),
    ...(demoWidgetSessions === undefined ? {} : { demoWidgetSessions }),
    ...(testCustomersRepository === undefined ? {} : { testCustomers: testCustomersRepository }),
    ...(knowledgeRepository === undefined ? {} : { knowledge: knowledgeRepository }),
    ...(widgetSessions === undefined ? {} : { widgetSessions }),
    ...(dbAuth === undefined ? {} : { auth: dbAuth }),
    ...(redis === null ? {} : { turnRateLimiter: new RedisTurnRateLimiter(redis) }),
    ...(intentProposer === undefined ? {} : { intentProposer }),
    llmConfiguration,
    env: () => ({ ...env }),
    demoMode: demo_enabled,
    readiness: {
      snapshot: async ({ tenant_id }) => {
        const providerMode = env.DEMO_PROVIDER_MODE?.trim().toLowerCase();
        const offlineDemo = env.DEMO_MODE === 'true'
          && providerMode === 'offline'
          && (env.APP_ENV === 'local' || env.APP_ENV === 'ci');
        const resolvedLlmConfig = offlineDemo ? null : await llmConfigResolver.resolve(tenant_id);
        const configuredProvider = resolvedLlmConfig !== null;
        const providerProbe = configuredProvider ? 'NOT_RUN' as const : 'UNBOUND' as const;
        const isMock = env.MOCK_ERP_ENABLED === 'true' && env.ERP_API_BASE_URL?.includes('mock-erp') === true;
        const eventsMock = env.MOCK_ERP_ENABLED === 'true' && env.EVENT_INGESTION_BASE_URL?.includes('mock-erp') === true;
        const models = resolvedLlmConfig === null
          ? []
          : [{ model: resolvedLlmConfig.reasoning_model, configured: true, probe: providerProbe }];
        const provider = {
          provider: resolvedLlmConfig?.provider_id ?? null,
          configured: configuredProvider,
          probe: providerProbe,
          models,
        };
        const connectors = {
          erp: { class: isMock ? 'DEMO_MOCK' as const : 'UNBOUND' as const, probe: isMock ? 'NOT_RUN' as const : 'UNBOUND' as const },
          events: { class: eventsMock ? 'DEMO_MOCK' as const : 'UNBOUND' as const, probe: eventsMock ? 'NOT_RUN' as const : 'UNBOUND' as const },
        };
        if (options?.databaseRunner === undefined && !hasDatabase) {
          return { observed_at: systemClock().toISOString(), provider, connectors, ledger: { status: 'UNAVAILABLE' as const, stage_event_count: null, provider_call_count: null } };
        }
        const runner = options?.databaseRunner ?? withTenantContext;
        const counts = await runner(tenant_id, async (client) => {
          const [stages, calls] = await Promise.all([
            client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM agentos.run_stage_events WHERE tenant_id = $1', [tenant_id]),
            client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM agentos.provider_call_ledger WHERE tenant_id = $1', [tenant_id]),
          ]);
          return { stage_event_count: Number(stages.rows[0]?.count ?? 0), provider_call_count: Number(calls.rows[0]?.count ?? 0) };
        });
        return { observed_at: systemClock().toISOString(), provider, connectors, ledger: { status: 'OBSERVED' as const, ...counts } };
      },
    },
    trace: stageRepository,
    normalizer: createCanonicalEventNormalizer(),
    ...(p5 === undefined ? {} : { provisioning: p5.provisioning, autonomyAdmin: p5.autonomyAdmin }),
    unbound: unbound_ports,
    enabledModules,
    salesSignalEventTypes,
    marketingSignalEventTypes,
    close: async () => {
      if (ownedRedis !== null) {
        await ownedRedis.quit();
      }
    },
  };
}

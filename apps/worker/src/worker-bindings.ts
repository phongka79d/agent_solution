import {
  LlmCallRecorder,
  LlmConfigResolver,
  estimateLlmCallTokens,
  LlmUsageRecorder,
  SecretResolver,
  createSecretCipher,
  type AutonomyAdmissionPort,
  type ICrossDomainHandoffBroker,
  type RevenueOrchestrator,
} from '@agentos/core-engine';
import type { LlmRecorderContext } from '@agentos/core-engine';
import {
  DurableWorkflowRepository,
  LlmConfigRepository,
  P5AutonomyRepository,
  RunStageEventsRepository,
  SecretRepository,
} from '@agentos/database';
import {
  OpenAICompatibleLLMAdapter,
  OpenAICompatibleLLMError,
} from '@agentos/adapters';
import type { OpenAICompatibleResult } from '@agentos/adapters';
import { validateAgainstSchema } from '@agentos/skills';

import type {
  SkillBreakerRegistry,
  SkillGate,
  SkillLlmPortFactory,
} from '@agentos/skills';

import {
  createCareOrchestratorFactory,
  getUnboundCapabilities,
  type CareOrchestratorFactoryOptions,
} from './runtime/care/index.js';
import {
  createSalesOrchestratorFactory,
  getSalesUnboundCapabilities,
  type SalesOrchestratorFactoryOptions,
} from './runtime/sales/index.js';
import type { ErpReadPort, WorkerConnectors, WorkerConnectorEnv } from './runtime/connectors.js';
import {
  type DomainRuntimeBinding,
  type DomainSignalContract,
} from './runtime/domain-registry.js';
import {
  createMarketingOrchestratorFactory,
  type MarketingOrchestratorFactoryOptions,
} from './runtime/marketing/factory.js';
import {
  createMarketingConsentPort,
  createMarketingCustomer360Port,
  createMarketingCustomerBindingVerifier,
} from './runtime/marketing/data-adapters.js';
import { createMarketingAudienceReader } from './runtime/marketing/audience-adapter.js';
import { createSalesConsentPort } from './runtime/sales/consent-adapter.js';
import { createErpSalesOrderPort } from './runtime/sales/erp-order-port.js';
import { createSalesRevenueEvidencePort } from './runtime/sales/revenue-evidence-adapter.js';
import { DurableRunStageRecorder } from './runtime/shared/stage-recorder.js';
import { createExecutionLeaseAssertion } from './runtime/execution-lease.js';


class WorkerSkillLlmError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'WorkerSkillLlmError';
    this.code = code;
  }
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function workerLlmBudgetConfig(env: WorkerBindingEnv) {
  const rawTenantBudget = env.LLM_TENANT_TOKEN_BUDGET?.trim();
  const tenantBudget = rawTenantBudget === undefined || rawTenantBudget === ''
    ? undefined
    : positiveInteger(rawTenantBudget, 0, Number.MAX_SAFE_INTEGER);
  if (tenantBudget === 0) {
    throw new TypeError('LLM_TENANT_TOKEN_BUDGET must be a positive safe integer token count');
  }
  return {
    per_run_token_budget: positiveInteger(
      env.MAX_TOKENS_PER_RUN,
      4096,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(tenantBudget === undefined ? {} : { token_budget: tenantBudget }),
  };
}

function createWorkerLlmCallRecorder(env: WorkerBindingEnv): LlmCallRecorder {
  const tokenCosts = new P5AutonomyRepository();
  return new LlmCallRecorder({
    usage: new LlmUsageRecorder({
      sink: tokenCosts,
      reservationStore: tokenCosts,
      budgetConfig: workerLlmBudgetConfig(env),
    }),
    providerCalls: new RunStageEventsRepository(),
  });
}

/** LLM purposes served by the provider's fast model; everything else uses the reasoning model. */
const FAST_MODEL_PURPOSES: ReadonlySet<string> = new Set(['marketing.generate_content']);

/** Builds the invocation-scoped LLM port with the worker's usage and provider-call recorder. */
export function createWorkerSkillLlmPortFactory(
  env: Pick<WorkerBindingEnv, 'LLM_MAX_OUTPUT_TOKENS_PER_CALL'>,
  configResolver: Pick<LlmConfigResolver, 'resolve'>,
  recorder: Pick<LlmCallRecorder, 'beforeCall' | 'recordFailure' | 'recordSuccess'>,
): SkillLlmPortFactory {
  const adapters = new Map<string, OpenAICompatibleLLMAdapter>();
  // Leave room for request framing in the default 4096-token per-run reservation.
  const maxOutputTokens = positiveInteger(
    env.LLM_MAX_OUTPUT_TOKENS_PER_CALL,
    2048,
    4096,
  );
  return (context) => {
    let callIndex = 0;
    return {
      async completeStructured(request) {
        const config = await configResolver.resolve(context.tenant_id);
        if (config === null) {
          throw new WorkerSkillLlmError('LLM_NOT_CONFIGURED', 'no LLM provider is configured for this tenant');
        }
        const configOwner = config.source === 'TENANT' ? context.tenant_id : 'shared';
        const adapterKey = `${configOwner}\u0000${config.source}\u0000${config.provider_id}\u0000${config.config_version}`;
        let adapter = adapters.get(adapterKey);
        if (adapter === undefined) {
          try {
            adapter = new OpenAICompatibleLLMAdapter({
              apiKey: config.api_key,
              baseUrl: config.base_url,
              timeoutMs: config.timeout_ms,
              maxOutputTokens,
              structuredOutputMode: config.structured_mode,
            });
            adapters.set(adapterKey, adapter);
          } catch {
            throw new WorkerSkillLlmError(
              'LLM_NOT_CONFIGURED',
              'configured OpenAI-compatible provider is invalid',
            );
          }
        }

        // Copy writing is a short completion; reasoning-tier latency cannot fit its step timeout.
        const model = FAST_MODEL_PURPOSES.has(request.purpose) ? config.fast_model : config.reasoning_model;
        const callContext: LlmRecorderContext = {
          tenant_id: context.tenant_id,
          run_id: context.run_id,
          correlation_id: context.correlation_id,
          step_index: context.step_index ?? 0,
          attempt: context.attempt ?? 0,
          stage: 'EXECUTION',
          call_index: callIndex,
          provider: 'openai-compatible',
          model,
        };
        callIndex += 1;
        const maxTokens = request.max_output_tokens ?? maxOutputTokens;
        await recorder.beforeCall(
          callContext,
          estimateLlmCallTokens(request.messages, maxTokens),
        );
        const callStartedAt = Date.now();
        const signal = request.signal === undefined
          ? context.signal
          : context.signal === undefined || context.signal === request.signal
            ? request.signal
            : AbortSignal.any([context.signal, request.signal]);
        let result: OpenAICompatibleResult<unknown>;
        try {
          result = await adapter.completeStructured({
            model,
            run_id: context.run_id,
            correlation_id: context.correlation_id,
            ...(signal === undefined ? {} : { signal }),
            max_tokens: maxTokens,
            messages: request.messages,
            ...(config.structured_mode === 'json_schema'
              ? { schema: { name: request.purpose, schema: request.schema } }
              : {}),
            validate: (value) => {
              const violations = validateAgainstSchema(request.schema, value);
              if (violations.length > 0) {
                throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
              }
              return value;
            },
          });
        } catch (error) {
          await recorder.recordFailure({
            ...callContext,
            error_code: error instanceof OpenAICompatibleLLMError ? error.code : 'LLM_UNAVAILABLE',
            ...(error instanceof OpenAICompatibleLLMError ? { provider_error: error.provider_error } : {}),
            attempts: error instanceof OpenAICompatibleLLMError ? error.attempts : 1,
            latency_ms: Math.max(0, Date.now() - callStartedAt),
          });
          throw error;
        }
        await recorder.recordSuccess({
          ...callContext,
          request_id: result.request_id,
          usage: result.usage,
          latency_ms: result.latency_ms,
        });
        return { value: result.value, usage: result.usage };
      },
    };
  };
}

interface WorkerBindingEnv extends WorkerConnectorEnv {
  readonly DEMO_MODE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly PRIMARY_REASONING_MODEL?: string;
  readonly FAST_COMPLETION_MODEL?: string;
  readonly OPENAI_STRUCTURED_OUTPUT_MODE?: string;
  readonly LLM_REQUEST_TIMEOUT_MS?: string;
  readonly LLM_MAX_OUTPUT_TOKENS_PER_CALL?: string;
  readonly LLM_TENANT_TOKEN_BUDGET?: string;
  readonly MAX_TOKENS_PER_RUN?: string;
  readonly ENCRYPTION_KEY_AES256?: string;
  readonly ENCRYPTION_KEY_AES256_PREVIOUS?: string;
  readonly SALES_SIGNAL_SOURCE_CHANNELS?: string;
  readonly SALES_SIGNAL_EVENT_TYPES?: string;
  readonly MARKETING_SIGNAL_SOURCE_CHANNELS?: string;
  readonly MARKETING_SIGNAL_EVENT_TYPES?: string;
  readonly AUDIT_HMAC_SECRET?: string;
  readonly QUOTE_SIGNING_SECRET?: string;
  readonly SALES_REVENUE_MODEL_ID?: string;
  readonly SALES_REVENUE_PROVENANCE?: string;
}


type OrchestratorFactory =
  (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;

type WorkflowRepository = Pick<DurableWorkflowRepository,
  'claimNextQueuedTask' | 'getTask' | 'renewTaskLease' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
interface TenantConnectorRegistry {
  erpFor(tenant_id: string): Promise<ErpReadPort | null>;
}



interface WorkerBindingOptions {
  readonly env: WorkerBindingEnv;
  readonly workerId: string;
  readonly workflowRepository: WorkflowRepository;
  readonly connectors: Pick<WorkerConnectors, 'erp_read'>;
  readonly connectorRegistry?: TenantConnectorRegistry | undefined;
  readonly enabledModules: readonly string[];
  readonly blockers: string[];
  readonly autonomy?: AutonomyAdmissionPort | undefined;
  readonly crossDomainHandoff?: ICrossDomainHandoffBroker | undefined;
  readonly careSignalContract: DomainSignalContract;
  readonly crossDomainHandoffChannel: string;
  readonly crossDomainHandoffEventTypes: Readonly<Record<string, string>>;
  readonly marketingSignalContractDefaults: {
    readonly source_channels: readonly string[];
    readonly event_types: readonly string[];
  };
  readonly careFactoryOptions: CareOrchestratorFactoryOptions;
  readonly orchestratorFactory?: OrchestratorFactory | undefined;
  readonly salesOrchestratorFactory?: OrchestratorFactory | undefined;
  readonly salesFactoryOptions?: SalesOrchestratorFactoryOptions | undefined;
  readonly marketingOrchestratorFactory?: OrchestratorFactory | undefined;
  readonly marketingFactoryOptions?: MarketingOrchestratorFactoryOptions | undefined;
  /** Live availability gate (PLAN T4.3) shared by every domain's planner and skill engine. */
  readonly skillGate?: SkillGate | undefined;
  /** The breaker table the gate observes; the same instance every domain engine records into. */
  readonly skillBreakers?: SkillBreakerRegistry | undefined;
}

export function createWorkerDomainBindings(options: WorkerBindingOptions): DomainRuntimeBinding[] {
  const {
    env,
    workerId,
    workflowRepository,
    connectors,
    enabledModules,
    blockers,
    autonomy,
    crossDomainHandoff,
    careSignalContract,
    crossDomainHandoffChannel,
    crossDomainHandoffEventTypes,
    marketingSignalContractDefaults,
  } = options;
  const resolverEnv = env as Readonly<Record<string, string | undefined>>;
  const secretCipher = env.ENCRYPTION_KEY_AES256 === undefined
    ? null
    : createSecretCipher(resolverEnv);
  const secretRepository = new SecretRepository(
    secretCipher ?? { encrypt: () => { throw new Error('SECRET_ENCRYPTION_KEY_INVALID'); } },
  );
  const secretResolver = new SecretResolver(
    secretRepository,
    secretCipher ?? { decrypt: () => { throw new Error('SECRET_ENCRYPTION_KEY_INVALID'); } },
  );
  const llmConfigRepository = new LlmConfigRepository();
  const llmConfigReader = {
    async getTenantOverride(tenant_id: string) {
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
    getPlatformDefault: () => llmConfigRepository.getPlatformDefault(),
  };
  const llmConfigResolver = new LlmConfigResolver(llmConfigReader, secretResolver, resolverEnv);
  const llmCallRecorder = createWorkerLlmCallRecorder(env);
  const workerSkillLlmPortFactory = createWorkerSkillLlmPortFactory(env, llmConfigResolver, llmCallRecorder);
  const bindings: DomainRuntimeBinding[] = [];
  const assertExecutionLease = createExecutionLeaseAssertion({
    workflowRepository,
    workerId,
  });


  let careOrchestratorFactory: OrchestratorFactory | null = null;
  if (enabledModules.includes('support')) {
    const resolveTenantErp = options.connectorRegistry !== undefined
      && options.careFactoryOptions.erp_read === undefined;
    const unboundCapabilities = getUnboundCapabilities(options.careFactoryOptions).filter(
      (cap) => !(resolveTenantErp && cap.startsWith('API-001 ')),
    );
    if (resolveTenantErp) {
      blockers.push(
        'CARE_CAPABILITY_UNBOUND: API-001 availability is resolved per task; tenants without a BOUND connector or DEMO fallback have no ERP access.',
      );
    }
    for (const cap of unboundCapabilities) {
      blockers.push(`CARE_CAPABILITY_UNBOUND: ${cap}`);
    }

    const careFactoryOptions = {
      ...options.careFactoryOptions,
      ...(options.careFactoryOptions.env === undefined ? { env } : {}),
      ...(options.careFactoryOptions.gate !== undefined || options.skillGate === undefined
        ? {} : { gate: options.skillGate }),
      ...(options.careFactoryOptions.breakers !== undefined || options.skillBreakers === undefined
        ? {} : { breakers: options.skillBreakers }),
      ...(options.careFactoryOptions.llm === undefined
        ? { llm: workerSkillLlmPortFactory }
        : {}),
      ...(options.careFactoryOptions.auditSecret === undefined
        ? { auditSecret: env.AUDIT_HMAC_SECRET } : {}),
      ...(options.careFactoryOptions.blockers === undefined ? { blockers } : {}),
      ...(options.careFactoryOptions.assertExecutionLease === undefined ? { assertExecutionLease } : {}),
      ...(options.careFactoryOptions.runStageRecorder !== undefined
        || !(options.careFactoryOptions.workflowRepository instanceof DurableWorkflowRepository)
        ? {} : { runStageRecorder: new DurableRunStageRecorder(new RunStageEventsRepository()) }),
    };
    const careFactory: OrchestratorFactory | null = unboundCapabilities.length > 0
      ? null
      : resolveTenantErp
        ? async (tenant_id) => {
            const erp_read = await options.connectorRegistry!.erpFor(tenant_id);
            const tenantFactory = createCareOrchestratorFactory({ ...careFactoryOptions, erp_read });
            return tenantFactory(tenant_id);
          }
        : createCareOrchestratorFactory(careFactoryOptions);


    careOrchestratorFactory = options.orchestratorFactory ?? careFactory;

    if (!careOrchestratorFactory) {
      blockers.push('CARE_ORCHESTRATOR_UNBOUND: No authentic Customer Care RevenueOrchestrator factory provided (fail closed).');
    } else {
      bindings.push({
        contract: careSignalContract,
        createOrchestrator: careOrchestratorFactory,
      });
    }
  }

  if (enabledModules.includes('sales')) {
    const rawChannels = env.SALES_SIGNAL_SOURCE_CHANNELS;
    const rawEventTypes = env.SALES_SIGNAL_EVENT_TYPES;
    const salesChannels = rawChannels ? rawChannels.split(',').map((c) => c.trim()).filter(Boolean) : [];
    const salesEventTypes = rawEventTypes ? rawEventTypes.split(',').map((e) => e.trim()).filter(Boolean) : [];

    if (salesChannels.length === 0 || salesEventTypes.length === 0) {
      blockers.push('SALES_CAPABILITY_UNBOUND: SALES_SIGNAL_SOURCE_CHANNELS and SALES_SIGNAL_EVENT_TYPES must be configured and non-empty');
    } else {
      const revenueModelId = env.SALES_REVENUE_MODEL_ID?.trim();
      const revenueProvenance = env.SALES_REVENUE_PROVENANCE?.trim();
      const revenueEvidence = revenueModelId && revenueProvenance
        ? createSalesRevenueEvidencePort({ model_id: revenueModelId, provenance: revenueProvenance })
        : undefined;
      const salesFactoryOptions: SalesOrchestratorFactoryOptions = options.salesFactoryOptions === undefined
        ? {
            workerId,
            workflowRepository: workflowRepository as DurableWorkflowRepository,
            env,
            ...(options.connectorRegistry === undefined ? { erp_read: connectors.erp_read } : {}),
            consent: createSalesConsentPort(),
            ...(revenueEvidence === undefined ? {} : { revenue_evidence: revenueEvidence }),
            ...(env.QUOTE_SIGNING_SECRET === undefined ? {} : { quote_signing_secret: env.QUOTE_SIGNING_SECRET }),
            ...(crossDomainHandoff === undefined ? {} : { crossDomainHandoff }),
            ...(autonomy === undefined ? {} : { autonomy }),
            ...(options.skillGate === undefined ? {} : { gate: options.skillGate }),
            ...(options.skillBreakers === undefined ? {} : { breakers: options.skillBreakers }),
            llm: workerSkillLlmPortFactory,
          }
        : {
            ...options.salesFactoryOptions,
            ...(options.salesFactoryOptions.llm === undefined
              ? { llm: workerSkillLlmPortFactory }
              : {}),
            ...(options.skillGate === undefined || options.salesFactoryOptions.gate !== undefined
              ? {} : { gate: options.skillGate }),
            ...(options.skillBreakers === undefined || options.salesFactoryOptions.breakers !== undefined
              ? {} : { breakers: options.skillBreakers }),
            ...(options.salesFactoryOptions.env === undefined ? { env } : {}),
            ...(options.salesFactoryOptions.auditSecret === undefined
              ? { auditSecret: env.AUDIT_HMAC_SECRET } : {}),
            ...(options.salesFactoryOptions.blockers === undefined ? { blockers } : {}),
            ...(options.salesFactoryOptions.assertExecutionLease === undefined ? { assertExecutionLease } : {}),
            ...(options.salesFactoryOptions.quote_signing_secret !== undefined || env.QUOTE_SIGNING_SECRET === undefined
              ? {}
              : { quote_signing_secret: env.QUOTE_SIGNING_SECRET }),
            ...(options.salesFactoryOptions.crossDomainHandoff !== undefined || crossDomainHandoff === undefined
              ? {}
              : { crossDomainHandoff }),
            ...(options.salesFactoryOptions.autonomy !== undefined || autonomy === undefined
              ? {}
              : { autonomy }),
            ...(options.salesFactoryOptions.revenue_evidence !== undefined || revenueEvidence === undefined
              ? {}
              : { revenue_evidence: revenueEvidence }),
          };


      // Static capability gaps do not suppress the tenant-resolved factory. Tenants without a
      // BOUND ERP connector (or DEMO fallback) still fail closed when an ERP-backed skill runs.
      const resolveTenantErp = options.connectorRegistry !== undefined
        && salesFactoryOptions.erp_read === undefined;
      const salesUnboundCapabilities = getSalesUnboundCapabilities(salesFactoryOptions).filter(
        (cap) => !(
          resolveTenantErp
          && (
            cap.startsWith('API-001 (unbound ERP read')
            || cap.startsWith('API-001.PricingEngine')
            || cap.startsWith('API-001.OrderConnector')
            || cap.startsWith('API-002.CommerceCartAPI')
          )
        ),
      );
      for (const cap of salesUnboundCapabilities) {
        blockers.push(`SALES_CAPABILITY_UNBOUND: ${cap}`);
      }

      const factoryOptionsForTenant = {
        ...salesFactoryOptions,
        ...(salesFactoryOptions.runStageRecorder !== undefined
          || !(salesFactoryOptions.workflowRepository instanceof DurableWorkflowRepository)
          ? {} : { runStageRecorder: new DurableRunStageRecorder(new RunStageEventsRepository()) }),
      };
      const salesFactory: OrchestratorFactory | null = options.salesOrchestratorFactory
        ? null
        : async (tenant_id) => {
            const erp_read = resolveTenantErp
              ? await options.connectorRegistry!.erpFor(tenant_id)
              : salesFactoryOptions.erp_read;
            const order = salesFactoryOptions.order !== undefined
              ? salesFactoryOptions.order
              : createErpSalesOrderPort(erp_read);
            const tenantFactory = createSalesOrchestratorFactory({
              ...factoryOptionsForTenant,
              ...(resolveTenantErp ? { erp_read } : {}),
              order,
            });
            return tenantFactory(tenant_id);
          };
      const salesOrchestratorFactory = options.salesOrchestratorFactory ?? salesFactory;

      if (!salesOrchestratorFactory) {
        blockers.push('SALES_ORCHESTRATOR_UNBOUND: No authentic Sales RevenueOrchestrator factory provided (fail closed).');
      } else {
        bindings.push({
          contract: {
            module: 'sales',
            source_channels: Object.freeze([...salesChannels, crossDomainHandoffChannel]),
            event_types: Object.freeze([
              ...salesEventTypes,
              crossDomainHandoffEventTypes['marketing_to_sales'] as string,
            ]),
            signal_invalid_code: 'SALES_SIGNAL_INVALID',
          },
          createOrchestrator: salesOrchestratorFactory,
        });
      }
    }
  }

  if (enabledModules.includes('marketing')) {
    const marketingChannels = env.MARKETING_SIGNAL_SOURCE_CHANNELS
      ? env.MARKETING_SIGNAL_SOURCE_CHANNELS.split(',').map((value) => value.trim()).filter(Boolean)
      : [...marketingSignalContractDefaults.source_channels];
    const marketingEventTypes = env.MARKETING_SIGNAL_EVENT_TYPES
      ? env.MARKETING_SIGNAL_EVENT_TYPES.split(',').map((value) => value.trim()).filter(Boolean)
      : [...marketingSignalContractDefaults.event_types];

    let marketingFactory = options.marketingOrchestratorFactory;
    if (!marketingFactory) {
      try {
        const suppliedMarketingOptions = options.marketingFactoryOptions ?? {};
        const suppliedSkillOptions = suppliedMarketingOptions.skillOptions;
        const hasSuppliedContentEngine = suppliedSkillOptions !== undefined
          && Object.hasOwn(suppliedSkillOptions, 'content_engine')
          && suppliedSkillOptions.content_engine !== undefined;
        const marketingLlmPortFactory = suppliedSkillOptions?.llm
          ?? (hasSuppliedContentEngine ? undefined : workerSkillLlmPortFactory);
        const audienceReader = createMarketingAudienceReader();
        marketingFactory = createMarketingOrchestratorFactory({
          ...suppliedMarketingOptions,
          ...(suppliedMarketingOptions.gate !== undefined
            || suppliedSkillOptions?.gate !== undefined
            || options.skillGate === undefined
            ? {} : { gate: options.skillGate }),
          workerId,
          ...(suppliedMarketingOptions.env === undefined ? { env } : {}),
          ...(suppliedMarketingOptions.auditSecret === undefined
            ? { auditSecret: env.AUDIT_HMAC_SECRET } : {}),
          ...(suppliedMarketingOptions.blockers === undefined ? { blockers } : {}),
          ...(suppliedMarketingOptions.assertExecutionLease === undefined ? { assertExecutionLease } : {}),
          skillOptions: {
            ...(suppliedSkillOptions ?? {}),
            ...(marketingLlmPortFactory === undefined
              ? {}
              : { llm: marketingLlmPortFactory }),
            ...(options.skillGate === undefined || suppliedSkillOptions?.gate !== undefined
              ? {} : { gate: options.skillGate }),
            ...(options.skillBreakers === undefined || suppliedSkillOptions?.breakers !== undefined
              ? {} : { breakers: options.skillBreakers }),
          },
          ...(options.marketingFactoryOptions === undefined
            ? { workflowRepository: workflowRepository as DurableWorkflowRepository }
            : {}),
          ...(suppliedMarketingOptions.runStageRecorder !== undefined
            || !(options.marketingFactoryOptions === undefined
              ? workflowRepository instanceof DurableWorkflowRepository
              : suppliedMarketingOptions.workflowRepository instanceof DurableWorkflowRepository)
            ? {} : { runStageRecorder: new DurableRunStageRecorder(new RunStageEventsRepository()) }),
          // The audience and consent ports are tenant-bound per orchestrator, so a campaign run can
          // only ever read the tenant whose task it claimed. Provider ports stay unbound and refuse.
          ...(suppliedMarketingOptions.tenantSkillOptions !== undefined
            ? {}
            : {
                tenantSkillOptions: async (tenant_id: string) => {
                  const consent = createMarketingConsentPort({
                    serverBoundTenantId: tenant_id,
                    verifyCustomerBinding: createMarketingCustomerBindingVerifier(tenant_id),
                  });
                  return {
                    customer360: createMarketingCustomer360Port({
                      serverBoundTenantId: tenant_id,
                      readAudience: audienceReader,
                    }),
                    consent: {
                      // The canonical consent store answers with its own row shape; the skill
                      // contract needs only the decision, so nothing else is invented here.
                      checkConsent: async (input, context) => {
                        if (input.tenant_id !== context.tenant_id || input.tenant_id !== tenant_id) {
                          return {
                            allowed: false,
                            consent_timestamp: null,
                            suppression_reason: 'TENANT_CONTEXT_MISMATCH',
                          };
                        }
                        const decision = await consent.check({
                          tenant_id: input.tenant_id,
                          customer_id: input.customer_id ?? '',
                          channel: input.channel,
                        });
                        return {
                          allowed: decision.allowed,
                          consent_timestamp: decision.consent_timestamp,
                          suppression_reason: decision.suppression_reason,
                        };
                      },
                    },
                  };
                },
              }),
          ...(env.AUDIT_HMAC_SECRET === undefined ? {} : { auditSecret: env.AUDIT_HMAC_SECRET }),
          ...(suppliedMarketingOptions.crossDomainHandoff !== undefined
            ? {}
            : crossDomainHandoff === undefined ? {} : { crossDomainHandoff }),
          ...(suppliedMarketingOptions.autonomy !== undefined || autonomy === undefined
            ? {}
            : { autonomy }),
        });
      } catch (error) {
        blockers.push('MARKETING_ORCHESTRATOR_UNBOUND: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    if (marketingFactory) {
      bindings.push({
        contract: {
          module: 'marketing',
          source_channels: Object.freeze(marketingChannels),
          event_types: Object.freeze(marketingEventTypes),
          signal_invalid_code: 'MARKETING_SIGNAL_INVALID',
        },
        createOrchestrator: marketingFactory,
      });
    }
  }

  return bindings;
}

/**
 * @file Unit tests for worker domain binding construction.
 */

import { describe, expect, it, vi } from 'vitest';
import { LlmCallRecorder, LlmConfigResolver, LlmUsageRecorder } from '@agentos/core-engine';
import type { LlmProviderCallInput } from '@agentos/core-engine';
import type { ExecutionContext, SkillLlmPort } from '@agentos/skills';
import type * as Database from '@agentos/database';

const getProfile = vi.hoisted(() => vi.fn());
const findConsent = vi.hoisted(() => vi.fn());
const createMarketingOrchestratorFactoryMock = vi.hoisted(() => vi.fn());

vi.mock('@agentos/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  getProfile,
  findConsent,
}));

vi.mock('./runtime/marketing/factory.js', () => ({
  createMarketingOrchestratorFactory: createMarketingOrchestratorFactoryMock,
}));

import { createWorkerDomainBindings, createWorkerSkillLlmPortFactory } from './worker-bindings.js';
import { createMarketingSkillServices } from './runtime/marketing/skills/index.js';

const TENANT_ID = '01920000-0000-7000-8000-000000000001';
const CUSTOMER_ID = 'cust-uuid-1';

function consentingRow() {
  const timestamp = new Date('2026-01-01T10:00:00.000Z');
  return {
    id: 'consent-row-1',
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
    consent_type: 'marketing_messaging',
    channel: 'line',
    is_granted: true,
    opt_in_method: 'web_form',
    opt_in_timestamp: timestamp,
    opt_out_timestamp: null,
    evidence_text: 'Agreed to promotional messages',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe('createWorkerDomainBindings marketing consent', () => {
  it('allows a tenant-bound, consenting recipient through the default tenant skill options', async () => {
    getProfile.mockReset().mockResolvedValue({ tenant_id: TENANT_ID, customer_id: CUSTOMER_ID });
    findConsent.mockReset().mockResolvedValue(consentingRow());
    createMarketingOrchestratorFactoryMock.mockReset().mockReturnValue(() => null);

    createWorkerDomainBindings({
      env: {} as never,
      workerId: 'worker-test',
      workflowRepository: {} as never,
      connectors: { erp_read: {} as never },
      enabledModules: ['marketing'],
      blockers: [],
      careSignalContract: {} as never,
      crossDomainHandoffChannel: 'CROSS_DOMAIN',
      crossDomainHandoffEventTypes: { marketing_to_sales: 'marketing.to-sales' },
      marketingSignalContractDefaults: {
        source_channels: ['MARKETING_CAMPAIGN'],
        event_types: ['campaign.requested'],
      },
      careFactoryOptions: {} as never,
    });

    const factoryOptions = createMarketingOrchestratorFactoryMock.mock.calls[0]?.[0] as {
      tenantSkillOptions?: (tenantId: string) => Promise<{
        consent?: {
          checkConsent: (
            input: { tenant_id: string; customer_id?: string; channel: string },
            context: { tenant_id: string },
          ) => Promise<{ allowed: boolean; suppression_reason: string | null }>;
        };
      }>;
    };
    const tenantSkillOptions = await factoryOptions.tenantSkillOptions?.(TENANT_ID);
    const result = await tenantSkillOptions?.consent?.checkConsent(
      { tenant_id: TENANT_ID, customer_id: CUSTOMER_ID, channel: 'LINE_FLEX' },
      { tenant_id: TENANT_ID },
    );

    expect(result).toMatchObject({ allowed: true, suppression_reason: null });
    expect(getProfile).toHaveBeenCalledWith(TENANT_ID, CUSTOMER_ID);
    expect(findConsent).toHaveBeenCalledWith(TENANT_ID, CUSTOMER_ID, 'marketing_messaging', 'line');
  });
});

describe('worker skill LLM binding', () => {
  it('records each structured call once and aborts an active provider request with the context signal', async () => {
    const providerCallRecords: LlmProviderCallInput[] = [];
    const recordUsage = vi.fn(async (_input: unknown) => null);
    const recordFailure = vi.fn(async (_input: unknown) => undefined);
    const beforeCall = vi.fn(async () => undefined);
    const recorder = new LlmCallRecorder({
      usage: { beforeCall, record: recordUsage, recordFailure },
      providerCalls: {
        async appendProviderCall(input) {
          providerCallRecords.push(input);
        },
      },
    });
    const configResolver = new LlmConfigResolver(
      {
        async getTenantOverride() {
          return null;
        },
        async getPlatformDefault() {
          return null;
        },
      },
      { async resolve() { return 'test-api-key'; } },
      {
        OPENAI_API_KEY: 'test-api-key',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        PRIMARY_REASONING_MODEL: 'test-model',
        APP_ENV: 'test',
      },
    );
    let fetchCount = 0;
    let secondFetchReady!: () => void;
    const secondFetchStarted = new Promise<void>((resolve) => {
      secondFetchReady = resolve;
    });
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          id: 'request-1',
          choices: [{ message: { content: JSON.stringify({ answer: 'ok' }) } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      secondFetchReady();
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error('the adapter did not forward its abort signal');
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(new Error('aborted'));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const controller = new AbortController();
      const context: Omit<ExecutionContext, 'llm'> = {
        run_id: 'run-llm-test',
        tenant_id: 'tenant-llm-test',
        caller_agent: 'MKT-03',
        correlation_id: 'corr-llm-test',
        granted_authority: 'AUTH-2',
        effect_key: 'effect-llm-test',
        step_index: 4,
        attempt: 2,
        signal: controller.signal,
      };
      const llm: SkillLlmPort = createWorkerSkillLlmPortFactory(
        {},
        configResolver,
        recorder,
      )(context);
      const request: Parameters<SkillLlmPort['completeStructured']>[0] = {
        purpose: 'worker.llm.test',
        messages: [{ role: 'user', content: 'provide a structured answer' }],
        schema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string' } },
          additionalProperties: false,
        },
      };
      const invocationContext = { ...context, llm };

      const completion = await invocationContext.llm.completeStructured(request);
      expect(completion).toEqual({
        value: { answer: 'ok' },
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
      const abortedCall = invocationContext.llm.completeStructured(request);
      await secondFetchStarted;
      controller.abort();
      await expect(abortedCall).rejects.toMatchObject({ code: 'LLM_CANCELLED' });

      expect(beforeCall).toHaveBeenCalledTimes(2);
      expect(recordUsage).toHaveBeenCalledTimes(1);
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(providerCallRecords).toHaveLength(2);
      expect(providerCallRecords[0]).toMatchObject({
        tenant_id: 'tenant-llm-test',
        run_id: 'run-llm-test',
        step_index: 4,
        call_index: 0,
        observed_status: 'SUCCESS',
      });
      expect(providerCallRecords[1]).toMatchObject({
        tenant_id: 'tenant-llm-test',
        run_id: 'run-llm-test',
        step_index: 4,
        call_index: 1,
        observed_status: 'LLM_CANCELLED',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reserves the marketing completion within the run budget and accepts the local provider contract', async () => {
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'ci';
    let closeStub: (() => Promise<void>) | undefined;
    try {
      // The stub is an MJS-only fixture outside this package's tsconfig rootDir.
      const { startLlmStub } = await import(new URL('../../../tests/stack/tools/llm-stub.mjs', import.meta.url).href);
      const stub = await startLlmStub({ host: '127.0.0.1' });
      closeStub = stub.close;

      const reservations = new Map<string, number>();
      let usedTokens = 0;
      let estimatedTokens = 0;
      const usage = new LlmUsageRecorder({
        budgetConfig: { per_run_token_budget: 4096 },
        reservationStore: {
          async reserveTokenBudget(input) {
            estimatedTokens = input.estimated_tokens;
            const alreadyReserved = [...reservations.values()].reduce((total, tokens) => total + tokens, 0);
            if (usedTokens + alreadyReserved + input.estimated_tokens > (input.run_token_budget ?? 4096)) return false;
            reservations.set(input.reservation_id, input.estimated_tokens);
            return true;
          },
          async settleTokenBudget(input) {
            const estimate = reservations.get(input.reservation_id);
            if (estimate === undefined) throw new Error('reservation was not created');
            reservations.delete(input.reservation_id);
            usedTokens += input.actual_tokens ?? estimate;
          },
          async releaseTokenBudget(input) {
            reservations.delete(input.reservation_id);
          },
        },
      });
      const providerCalls: LlmProviderCallInput[] = [];
      const recorder = new LlmCallRecorder({
        usage,
        providerCalls: {
          async appendProviderCall(input) {
            providerCalls.push(input);
          },
        },
      });
      const configResolver = new LlmConfigResolver(
        {
          async getTenantOverride() { return null; },
          async getPlatformDefault() {
            return {
              provider_id: 'worker-stub',
              base_url: stub.url,
              reasoning_model: 'llm-stub',
              fast_model: 'llm-stub-fast',
              timeout_ms: 5000,
              structured_mode: 'json_object',
              secret_id: 'stub-secret',
              config_version: '1',
            };
          },
        },
        {
          async resolve() { throw new Error('tenant secrets are not used by this platform-default test'); },
          async resolvePlatform() { return 'test-api-key'; },
        },
        { APP_ENV: 'ci' },
      );
      const signal = new AbortController().signal;
      const llm = createWorkerSkillLlmPortFactory({}, configResolver, recorder)({
        run_id: 'marketing-stub-run',
        tenant_id: TENANT_ID,
        caller_agent: 'MKT-03',
        correlation_id: 'marketing-stub-correlation',
        granted_authority: 'AUTH-3',
        effect_key: 'marketing-stub-effect',
        step_index: 1,
        attempt: 0,
        signal,
      });
      const services = createMarketingSkillServices({
        resolve_correlation_id: async () => 'marketing-stub-correlation',
        resolve_grant: async () => 'AUTH-3',
      });

      const generated = await services.tool_port.invoke<unknown, { readonly brand_audit_text: string }>({
        skill_id: 'skill.mkt.generate_content',
        tool_binding: 'Core.LLMContentEngine',
        input: {
          tenant_id: TENANT_ID,
          campaign_theme: 'inactive customer reactivation',
          channel: 'EMAIL_HTML',
          locale: 'en-US',
        },
        context: {
          run_id: 'marketing-stub-run',
          tenant_id: TENANT_ID,
          caller_agent: 'MKT-03',
          correlation_id: 'marketing-stub-correlation',
          granted_authority: 'AUTH-3',
          effect_key: 'marketing-stub-effect',
          signal,
          llm,
        },
      });

      expect(generated.brand_audit_text).toBe(
        'A thoughtful update\nExplore a fresh update from us, tailored for your interests.\nLearn more',
      );
      expect(estimatedTokens).toBeLessThanOrEqual(4096);
      // Copy writing is served by the fast model, not the reasoning model.
      expect(providerCalls).toMatchObject([{ observed_status: 'SUCCESS', model: 'llm-stub-fast' }]);
      expect(usedTokens).toBeGreaterThan(0);
      expect(reservations.size).toBe(0);
    } finally {
      await closeStub?.();
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });

});

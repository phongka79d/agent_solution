/**
 * @file Unit tests for Marketing API-003 outbound connector binding.
 *
 * Verifies:
 * 1. Unconfigured refusal (fail closed, no fake success, absent credentials/provider/transport).
 * 2. Configured payload forwarding (preserves tenant_id, effect_key, action_id, action_revision, exact payload).
 * 3. Tenant mismatch refusal (action draft or payload tenant mismatch rejected before transport).
 * 4. Confirmed receipt pass-through (exact ExecutionReceipt object from transport passed through).
 * 5. Timeout no-success (timeouts and unconfirmed dispatches classified as TIMEOUT/UNKNOWN for reconciliation;
 *    untrusted provider data cannot overwrite platform-owned classification fields).
 * 6. Reconciliation outcomes (SUCCEEDED, FAILED, INDETERMINATE, and missing reconcile method).
 * 7. Channel, payload identity, and strict target validation (channel presence/enumeration, payload consistency,
 *    fixed non-overridable API-003 connector target).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import { ConnectorRegistry } from '@agentos/adapters';

import {
  API003_CONNECTOR_ID,
  type Api003OutboundDispatchInput,
  type Api003OutboundTransport,
  type Api003ReconcileInput,
  type Api003TransportDispatchResult,
  Api003RefusalError,
  createMarketingApi003Binding,
  DEFAULT_API003_CONNECTOR_ID,
  MarketingApi003Connector,
  type MarketingApi003Config,
  registerMarketingApi003Connector,
  SUPPORTED_API003_CHANNELS,
} from './api003.js';

const TEST_TENANT = 'tenant-marketing-alpha';
const OTHER_TENANT = 'tenant-marketing-beta';
const TEST_PROVIDER = 'test-channel-provider';
const TEST_CREDENTIALS = { apiKey: 'secret-api-key-xyz-123' };

function createDefaultReceipt(overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
  return {
    execution_id: `${API003_CONNECTOR_ID}:act-campaign-001:1`,
    adapter_status: 'SUCCESS',
    provider_reference: 'msg-ref-prov-789',
    response_payload: { status: 'QUEUED', provider_id: 'prov-789' },
    latency_ms: 15,
    token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    ...overrides,
  };
}

function createMockTransport(
  dispatchResult?: Api003TransportDispatchResult,
  reconcileOutcome?: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE',
  customReconcileReceipt?: ExecutionReceipt,
): Api003OutboundTransport {
  return {
    dispatch: vi.fn(async (_input: Api003OutboundDispatchInput) => {
      if (dispatchResult) {
        return dispatchResult;
      }
      return {
        ok: true as const,
        receipt: createDefaultReceipt(),
      };
    }),
    ...(reconcileOutcome
      ? {
          reconcile: vi.fn(async (_input: Api003ReconcileInput) => {
            if (reconcileOutcome === 'SUCCEEDED') {
              return {
                outcome: 'SUCCEEDED' as const,
                receipt:
                  customReconcileReceipt ??
                  createDefaultReceipt({
                    execution_id: `${API003_CONNECTOR_ID}:act-campaign-001:reconciled`,
                    provider_reference: 'reconciled-ref-123',
                    response_payload: { delivered_at: '2026-09-26T00:00:00Z', status: 'DELIVERED' },
                  }),
              };
            }
            if (reconcileOutcome === 'FAILED') {
              return {
                outcome: 'FAILED' as const,
                response_payload: { reason: 'MESSAGE_NOT_FOUND' },
              };
            }
            return {
              outcome: 'INDETERMINATE' as const,
              error_message: 'Provider downstream gateway timeout',
            };
          }),
        }
      : {}),
  };
}

function createValidConfig(
  transportOverrides?: Api003OutboundTransport,
  overrides?: Partial<MarketingApi003Config>,
): MarketingApi003Config {
  return {
    tenant_id: TEST_TENANT,
    provider: TEST_PROVIDER,
    credentials: TEST_CREDENTIALS,
    transport: transportOverrides ?? createMockTransport(),
    ...overrides,
  };
}

function createActionDraft(overrides?: Partial<ActionDraft>): ActionDraft {
  return {
    action_id: 'act-campaign-001',
    run_id: 'run-marketing-001',
    tenant_id: TEST_TENANT,
    agent_id: 'MKT-05',
    skill_id: 'skill.mkt.dispatch_campaign',
    adapter_target: API003_CONNECTOR_ID,
    step_index: 0,
    mutating: true,
    price_bearing: false,
    request_id: 'req-campaign-001',
    action_revision: 1,
    effect_key: 'eff-key-campaign-001',
    required_authority: 'AUTH-4',
    payload: {
      channel: 'EMAIL',
      campaign_id: 'camp-2026-m01',
      segment_id: 'seg-vip-001',
      approved_content_id: 'doc-approved-001',
      nested_metadata: { priority: 'HIGH', tags: ['q3', 'promo'] },
    },
    ...overrides,
  };
}

describe('Marketing API-003 Outbound Connector Binding', () => {
  describe('1. Unconfigured refusal', () => {
    it('refuses dispatch when connector is instantiated with empty config', async () => {
      const connector = new MarketingApi003Connector();
      expect(connector.isConfigured).toBe(false);

      const draft = createActionDraft();
      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'TENANT_UNSCOPED',
      });
    });

    it('refuses dispatch when credentials are absent (undefined or null)', async () => {
      const connector = new MarketingApi003Connector({
        tenant_id: TEST_TENANT,
        provider: TEST_PROVIDER,
        credentials: null,
        transport: createMockTransport(),
      });
      expect(connector.isConfigured).toBe(false);

      const draft = createActionDraft();
      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'CREDENTIALS_ABSENT',
      });
    });

    it('refuses dispatch when provider is missing', async () => {
      const connector = new MarketingApi003Connector({
        tenant_id: TEST_TENANT,
        provider: '',
        credentials: TEST_CREDENTIALS,
        transport: createMockTransport(),
      });
      expect(connector.isConfigured).toBe(false);

      const draft = createActionDraft();
      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'PROVIDER_ABSENT',
      });
    });

    it('refuses dispatch when transport is missing', async () => {
      const connector = new MarketingApi003Connector({
        tenant_id: TEST_TENANT,
        provider: TEST_PROVIDER,
        credentials: TEST_CREDENTIALS,
      });
      expect(connector.isConfigured).toBe(false);

      const draft = createActionDraft();
      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'CONNECTOR_UNCONFIGURED',
      });
    });

    it('refuses reconcile when unconfigured', async () => {
      const connector = new MarketingApi003Connector();
      await expect(
        connector.reconcile({
          tenant_id: TEST_TENANT,
          effect_key: 'eff-key-001',
        }),
      ).rejects.toThrow(Api003RefusalError);
    });

    it('factory does not register connector when credentials or provider are missing', () => {
      const registry = new ConnectorRegistry();
      const res = registerMarketingApi003Connector(registry, {
        tenant_id: TEST_TENANT,
        provider: '',
        transport: createMockTransport(),
      });

      expect(res.bound).toBe(false);
      expect(res.status).toBe('UNBOUND');
      expect(res.connector_id).toBeNull();
      expect(registry.has(API003_CONNECTOR_ID)).toBe(false);
    });

    it('factory does not register connector when config is null', () => {
      const registry = new ConnectorRegistry();
      const res = registerMarketingApi003Connector(registry, null);

      expect(res.bound).toBe(false);
      expect(res.status).toBe('UNBOUND');
      expect(registry.ids()).toEqual([]);
    });

    it('dispatcher throws OrchestratorError on dispatch to unbound API-003 connector', async () => {
      const binding = createMarketingApi003Binding(null);
      expect(binding.isBound).toBe(false);
      expect(binding.status).toBe('UNBOUND');

      const draft = createActionDraft();
      await expect(binding.dispatcher.dispatch(draft)).rejects.toThrow(OrchestratorError);
      await expect(binding.dispatcher.dispatch(draft)).rejects.toMatchObject({
        code: 'CONNECTOR_NOT_FOUND',
      });
    });

    it('dispatcher throws OrchestratorError on reconcile of unbound API-003 connector', async () => {
      const binding = createMarketingApi003Binding(null);

      await expect(
        binding.dispatcher.reconcile!({
          tenant_id: TEST_TENANT,
          effect_key: 'eff-key-001',
          adapter_target: API003_CONNECTOR_ID,
        }),
      ).rejects.toThrow(OrchestratorError);
    });
  });

  describe('2. Configured payload forwarding', () => {
    it('forwards tenant_id, effect_key, action_id, action_revision, channel, exact payload, and credentials', async () => {
      const transport = createMockTransport();
      const config = createValidConfig(transport);
      const connector = new MarketingApi003Connector(config);
      const draft = createActionDraft();

      await connector.dispatch(draft);

      expect(transport.dispatch).toHaveBeenCalledTimes(1);
      const dispatchInput: Api003OutboundDispatchInput = vi.mocked(transport.dispatch).mock.calls[0]![0];

      expect(dispatchInput.tenant_id).toBe(draft.tenant_id);
      expect(dispatchInput.effect_key).toBe(draft.effect_key);
      expect(dispatchInput.action_id).toBe(draft.action_id);
      expect(dispatchInput.action_revision).toBe(draft.action_revision);
      expect(dispatchInput.channel).toBe('EMAIL');
      expect(dispatchInput.provider).toBe(TEST_PROVIDER);
      expect(dispatchInput.credentials).toEqual(TEST_CREDENTIALS);
      // Exact payload preserved without mutation
      expect(dispatchInput.payload).toBe(draft.payload);
      expect(dispatchInput.payload).toEqual({
        channel: 'EMAIL',
        campaign_id: 'camp-2026-m01',
        segment_id: 'seg-vip-001',
        approved_content_id: 'doc-approved-001',
        nested_metadata: { priority: 'HIGH', tags: ['q3', 'promo'] },
      });
    });

    it('forwards exact payload through createMarketingApi003Binding dispatcher', async () => {
      const transport = createMockTransport();
      const binding = createMarketingApi003Binding(createValidConfig(transport));
      expect(binding.isBound).toBe(true);

      const draft = createActionDraft();
      const receipt = await binding.dispatcher.dispatch(draft);

      expect(receipt.adapter_status).toBe('SUCCESS');
      expect(transport.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('3. Tenant mismatch refusal', () => {
    it('refuses dispatch when action tenant_id differs from bound tenant', async () => {
      const transport = createMockTransport();
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft({ tenant_id: OTHER_TENANT });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'TENANT_MISMATCH',
      });
      expect(transport.dispatch).not.toHaveBeenCalled();
    });

    it('refuses dispatch when payload tenant_id differs from action tenant_id', async () => {
      const transport = createMockTransport();
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft({
        payload: {
          channel: 'SMS',
          tenant_id: OTHER_TENANT, // mismatched payload identity
        },
      });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'PAYLOAD_IDENTITY_MISMATCH',
      });
      expect(transport.dispatch).not.toHaveBeenCalled();
    });

    it('refuses reconcile when tenant_id differs from bound tenant', async () => {
      const transport = createMockTransport(undefined, 'SUCCEEDED');
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      await expect(
        connector.reconcile({
          tenant_id: OTHER_TENANT,
          effect_key: 'eff-key-001',
        }),
      ).rejects.toThrow(Api003RefusalError);
      await expect(
        connector.reconcile({
          tenant_id: OTHER_TENANT,
          effect_key: 'eff-key-001',
        }),
      ).rejects.toMatchObject({
        code: 'TENANT_MISMATCH',
      });
    });
  });

  describe('4. Confirmed receipt pass-through', () => {
    it('passes through the exact ExecutionReceipt returned by transport', async () => {
      const confirmedReceipt: ExecutionReceipt = {
        execution_id: `${API003_CONNECTOR_ID}:act-campaign-001:1`,
        adapter_status: 'SUCCESS',
        provider_reference: 'confirmed-msg-12345',
        response_payload: { provider_message_id: 'pm-12345', status: 'SENT', raw_code: 200 },
        latency_ms: 42,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };

      const transport = createMockTransport({
        ok: true,
        receipt: confirmedReceipt,
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      // Must be the exact object passed through from transport without mutation
      expect(receipt).toBe(confirmedReceipt);
      expect(receipt.adapter_status).toBe('SUCCESS');
      expect(receipt.provider_reference).toBe('confirmed-msg-12345');
      expect(receipt.response_payload).toEqual({
        provider_message_id: 'pm-12345',
        status: 'SENT',
        raw_code: 200,
      });
    });
  });

  describe('5. Timeout no-success and unconfirmed classification', () => {
    it('classifies TIMEOUT failure_class with adapter_status TIMEOUT and null provider_reference', async () => {
      const transport = createMockTransport({
        ok: false,
        failure_class: 'TIMEOUT',
        error_message: 'Transport gateway timeout after 5000ms',
        provider_status: 504,
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('TIMEOUT');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
      expect(receipt.response_payload.error_message).toBe('Transport gateway timeout after 5000ms');
    });

    it('classifies UNKNOWN failure_class (possible dispatch) with adapter_status TIMEOUT and null provider_reference', async () => {
      const transport = createMockTransport({
        ok: false,
        failure_class: 'UNKNOWN',
        error_message: 'Socket connection reset while waiting for response headers',
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('UNKNOWN');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
    });

    it('classifies REJECTED failure_class with adapter_status ERROR and null provider_reference', async () => {
      const transport = createMockTransport({
        ok: false,
        failure_class: 'REJECTED',
        error_message: 'Provider rejected template payload (400 Bad Request)',
        provider_status: 400,
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('ERROR');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('REJECTED');
      expect(receipt.response_payload.reconciliation_required).toBe(false);
    });

    it('catches transport exceptions and classifies timeout errors as TIMEOUT failure_class', async () => {
      const transport: Api003OutboundTransport = {
        dispatch: vi.fn(async () => {
          throw new Error('AbortError: Request timed out');
        }),
      };
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('TIMEOUT');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
    });

    it('catches generic network exceptions and classifies as UNKNOWN failure_class', async () => {
      const transport: Api003OutboundTransport = {
        dispatch: vi.fn(async () => {
          throw new Error('ECONNRESET');
        }),
      };
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('UNKNOWN');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
    });

    it('treats transport receipt without provider_reference as UNKNOWN with adapter_status TIMEOUT', async () => {
      const unconfirmedReceipt: ExecutionReceipt = {
        execution_id: `${API003_CONNECTOR_ID}:act-001:1`,
        adapter_status: 'SUCCESS',
        provider_reference: null, // missing provider_reference
        response_payload: { status: 'UNKNOWN_STATE' },
        latency_ms: 10,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      const transport = createMockTransport({
        ok: true,
        receipt: unconfirmedReceipt,
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      expect(receipt.response_payload.failure_class).toBe('UNKNOWN');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
    });

    it('prevents untrusted provider response_payload from overwriting platform classification fields', async () => {
      const transport = createMockTransport({
        ok: false,
        failure_class: 'TIMEOUT',
        error_message: 'Timed out',
        // Malicious or conflicting provider fields attempting to turn failure into success
        response_payload: {
          failure_class: 'CORRUPTED_OVERWRITE',
          reconciliation_required: false,
          adapter_status: 'SUCCESS',
          effect_key: 'corrupted-key',
        },
      });
      const connector = new MarketingApi003Connector(createValidConfig(transport));
      const draft = createActionDraft();

      const receipt = await connector.dispatch(draft);

      expect(receipt.adapter_status).toBe('TIMEOUT');
      expect(receipt.provider_reference).toBeNull();
      // Platform-owned classification fields take precedence:
      expect(receipt.response_payload.failure_class).toBe('TIMEOUT');
      expect(receipt.response_payload.reconciliation_required).toBe(true);
      expect(receipt.response_payload.effect_key).toBe(draft.effect_key);
    });
  });

  describe('6. Reconciliation outcomes', () => {
    it('returns outcome SUCCEEDED with exact reconciled receipt when provider confirms action', async () => {
      const reconciledReceipt = createDefaultReceipt({
        execution_id: `${API003_CONNECTOR_ID}:act-campaign-001:reconciled`,
        provider_reference: 'reconciled-ref-123',
        response_payload: { delivered_at: '2026-09-26T00:00:00Z' },
      });
      const transport = createMockTransport(undefined, 'SUCCEEDED', reconciledReceipt);
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      const result = await connector.reconcile({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
        action_id: 'act-campaign-001',
      });

      expect(result.outcome).toBe('SUCCEEDED');
      expect(result.receipt).toBe(reconciledReceipt);
      expect(result.receipt!.adapter_status).toBe('SUCCESS');
      expect(result.receipt!.provider_reference).toBe('reconciled-ref-123');
    });

    it('returns outcome FAILED when provider confirms action is absent or failed', async () => {
      const transport = createMockTransport(undefined, 'FAILED');
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      const result = await connector.reconcile({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
      });

      expect(result.outcome).toBe('FAILED');
      expect(result.receipt).toBeUndefined();
    });

    it('returns outcome INDETERMINATE when provider cannot verify outcome', async () => {
      const transport = createMockTransport(undefined, 'INDETERMINATE');
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      const result = await connector.reconcile({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
      });

      expect(result.outcome).toBe('INDETERMINATE');
    });

    it('returns outcome INDETERMINATE when transport does not implement reconcile', async () => {
      const transport: Api003OutboundTransport = {
        dispatch: vi.fn(async () => ({ ok: true, receipt: createDefaultReceipt() })),
      };
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      const result = await connector.reconcile({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
      });

      expect(result.outcome).toBe('INDETERMINATE');
    });

    it('dispatches reconciliation via IAdapterDispatcher and defaults omitted adapter_target to API-003.CommunicationConnector', async () => {
      const transport = createMockTransport(undefined, 'SUCCEEDED');
      const binding = createMarketingApi003Binding(createValidConfig(transport));

      // Omitted adapter_target must default to API-003.CommunicationConnector, reaching this connector instead of generic API-001
      const result = await binding.dispatcher.reconcile!({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
      });

      expect(result.outcome).toBe('SUCCEEDED');
      expect(result.receipt).toBeDefined();
      expect(transport.reconcile).toHaveBeenCalledTimes(1);
    });

    it('enforces grounded-receipt guard on reconciliation: non-SUCCESS receipt maps to INDETERMINATE', async () => {
      const unconfirmedReconcileReceipt: ExecutionReceipt = {
        execution_id: `${API003_CONNECTOR_ID}:act-001:reconciled`,
        adapter_status: 'TIMEOUT', // Non-SUCCESS status
        provider_reference: 'some-ref',
        response_payload: {},
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      const transport = createMockTransport(undefined, 'SUCCEEDED', unconfirmedReconcileReceipt);
      const connector = new MarketingApi003Connector(createValidConfig(transport));

      const result = await connector.reconcile({
        tenant_id: TEST_TENANT,
        effect_key: 'eff-key-campaign-001',
      });

      expect(result.outcome).toBe('INDETERMINATE');
      expect(result.receipt).toBeUndefined();
    });
  });

  describe('7. Channel, payload identity, and strict target validation', () => {
    it('refuses dispatch when payload lacks channel', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({
        payload: {
          campaign_id: 'camp-001',
        },
      });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'CHANNEL_ABSENT',
      });
    });

    it('refuses dispatch when channel is invalid / unapproved', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({
        payload: {
          channel: 'TELEGRAM_UNAPPROVED',
        },
      });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'INVALID_CHANNEL',
      });
    });

    it.each(SUPPORTED_API003_CHANNELS)(
      'accepts recognized API-003 channel: %s',
      async (channel) => {
        const transport = createMockTransport();
        const connector = new MarketingApi003Connector(createValidConfig(transport));
        const draft = createActionDraft({
          payload: {
            channel,
            campaign_id: 'camp-channel-test',
          },
        });

        const receipt = await connector.dispatch(draft);
        expect(receipt.adapter_status).toBe('SUCCESS');
        expect(transport.dispatch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(transport.dispatch).mock.calls[0]![0].channel).toBe(channel);
      },
    );

    it('refuses dispatch when payload action_id mismatches draft action_id', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({
        payload: {
          channel: 'SMS',
          action_id: 'different-action-id',
        },
      });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'PAYLOAD_IDENTITY_MISMATCH',
      });
    });

    it('refuses dispatch when payload effect_key mismatches draft effect_key', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({
        payload: {
          channel: 'EMAIL',
          effect_key: 'different-effect-key',
        },
      });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'PAYLOAD_IDENTITY_MISMATCH',
      });
    });

    it('refuses dispatch when action_id is missing from draft', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({ action_id: '' });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'ACTION_ID_MISSING',
      });
    });

    it('refuses dispatch when effect_key is missing from draft', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());
      const draft = createActionDraft({ effect_key: '' });

      await expect(connector.dispatch(draft)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draft)).rejects.toMatchObject({
        code: 'EFFECT_KEY_MISSING',
      });
    });

    it('refuses dispatch when action adapter_target does not match fixed API-003.CommunicationConnector ID', async () => {
      const connector = new MarketingApi003Connector(createValidConfig());

      // Domain mismatch (e.g. ERP target)
      const draftErp = createActionDraft({ adapter_target: 'API-001' });
      await expect(connector.dispatch(draftErp)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draftErp)).rejects.toMatchObject({
        code: 'ADAPTER_TARGET_MISMATCH',
      });

      // Bare prefix without canonical CommunicationConnector suffix is refused (no alias / fallback)
      const draftBarePrefix = createActionDraft({ adapter_target: 'API-003' });
      await expect(connector.dispatch(draftBarePrefix)).rejects.toThrow(Api003RefusalError);
      await expect(connector.dispatch(draftBarePrefix)).rejects.toMatchObject({
        code: 'ADAPTER_TARGET_MISMATCH',
      });
    });

    it('enforces single connector ID: unapproved target cannot be reached via dispatcher', async () => {
      const transport = createMockTransport();
      const binding = createMarketingApi003Binding(createValidConfig(transport));

      // Fixed ID only is bound
      expect(binding.registry.ids()).toEqual([DEFAULT_API003_CONNECTOR_ID]);

      // Unapproved target fails closed
      const draft = createActionDraft({ adapter_target: 'UNAPPROVED_TARGET' });
      await expect(binding.dispatcher.dispatch(draft)).rejects.toThrow(OrchestratorError);
      await expect(binding.dispatcher.dispatch(draft)).rejects.toMatchObject({
        code: 'CONNECTOR_NOT_FOUND',
      });
      expect(transport.dispatch).not.toHaveBeenCalled();
    });
  });
});

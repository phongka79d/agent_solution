/**
 * @file Unit tests for Marketing Data Adapters (apps/worker/src/runtime/marketing/data-adapters.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConsentRow } from '@agentos/database';
import { MarketingRuntimeError } from './contracts.js';
import {
  createMarketingConsentPort,
  createMarketingResearchPort,
  normalizeMarketingChannel,
  type MarketingConsentRepository,
} from './data-adapters.js';

const VALID_TENANT = '01920000-0000-7000-8000-000000000001';
const OTHER_TENANT = '01920000-0000-7000-8000-000000000002';
const CUSTOMER_ID = 'cust-uuid-1';

function createFakeConsentRow(overrides: Partial<ConsentRow> = {}): ConsentRow {
  return {
    id: 'consent-row-1',
    tenant_id: VALID_TENANT,
    customer_id: CUSTOMER_ID,
    consent_type: 'marketing_messaging',
    channel: 'line',
    is_granted: true,
    opt_in_method: 'web_form',
    opt_in_timestamp: new Date('2026-01-01T10:00:00.000Z'),
    opt_out_timestamp: null,
    evidence_text: 'Agreed to promotional messages',
    created_at: new Date('2026-01-01T10:00:00.000Z'),
    updated_at: new Date('2026-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('normalizeMarketingChannel', () => {
  it('normalizes channel prefixes to canonical stored identifiers', () => {
    expect(normalizeMarketingChannel('LINE_FLEX')).toBe('line');
    expect(normalizeMarketingChannel('WHATSAPP_TEMPLATE')).toBe('whatsapp');
    expect(normalizeMarketingChannel('EMAIL_HTML')).toBe('email');
    expect(normalizeMarketingChannel('SMS_TEXT')).toBe('sms');
    expect(normalizeMarketingChannel('ZALO_ZNS')).toBe('zalo');
    expect(normalizeMarketingChannel('MESSENGER_GENERIC')).toBe('messenger');
    expect(normalizeMarketingChannel('INSTAGRAM_DIRECT')).toBe('instagram');
    expect(normalizeMarketingChannel('TIKTOK_CARD')).toBe('tiktok');
  });

  it('normalizes simple lowercase and mixed case strings', () => {
    expect(normalizeMarketingChannel('line')).toBe('line');
    expect(normalizeMarketingChannel('  SMS  ')).toBe('sms');
    expect(normalizeMarketingChannel('Email')).toBe('email');
  });

  it('handles empty or non-string inputs safely', () => {
    expect(normalizeMarketingChannel('')).toBe('');
    expect(normalizeMarketingChannel(null as unknown as string)).toBe('');
  });
});

describe('createMarketingConsentPort', () => {
  it('requires a mandatory serverBoundTenantId at factory creation', () => {
    expect(() => createMarketingConsentPort(null as unknown as never)).toThrow('TENANT_CONTEXT_REQUIRED');
    expect(() => createMarketingConsentPort({ serverBoundTenantId: '' })).toThrow('TENANT_CONTEXT_REQUIRED');
    expect(() => createMarketingConsentPort({ serverBoundTenantId: 'invalid-uuid' })).toThrow('TENANT_CONTEXT_REQUIRED');
  });

  it('allows outreach when customer identity is verified and consent is granted with null opt-out', async () => {
    const row = createFakeConsentRow();
    const findConsent = vi.fn().mockResolvedValue(row);
    const repository: MarketingConsentRepository = { findConsent };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'LINE_FLEX',
    });

    expect(verifyCustomerBinding).toHaveBeenCalledWith(VALID_TENANT, CUSTOMER_ID);
    expect(findConsent).toHaveBeenCalledWith(
      VALID_TENANT,
      CUSTOMER_ID,
      'marketing_messaging',
      'line',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.suppression_reason).toBeNull();
    expect(decision.consent_timestamp).toBe('2026-01-01T10:00:00.000Z');
    expect(decision.source_uri).toBe('urn:agentos:consent:consent-row-1');
  });

  it('denies outreach without repository access when customer binding verifier is not configured', async () => {
    const findConsent = vi.fn();
    const repository: MarketingConsentRepository = { findConsent };

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CUSTOMER_BINDING_UNVERIFIED');
    expect(decision.consent_timestamp).toBeNull();
    expect(findConsent).not.toHaveBeenCalled();
  });

  it('denies outreach without repository access when customer binding verification fails (mismatch/unbound)', async () => {
    const findConsent = vi.fn();
    const repository: MarketingConsentRepository = { findConsent };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(false);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(verifyCustomerBinding).toHaveBeenCalledWith(VALID_TENANT, CUSTOMER_ID);
    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CUSTOMER_BINDING_MISMATCH');
    expect(decision.consent_timestamp).toBeNull();
    expect(findConsent).not.toHaveBeenCalled();
  });

  it('denies outreach without repository access when customer binding verifier throws an error', async () => {
    const findConsent = vi.fn();
    const repository: MarketingConsentRepository = { findConsent };
    const verifyCustomerBinding = vi.fn().mockRejectedValue(new Error('Identity lookup service timeout'));

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CUSTOMER_BINDING_ERROR');
    expect(findConsent).not.toHaveBeenCalled();
  });

  it('denies outreach without verifier or repository access when customer_id is absent or empty', async () => {
    const findConsent = vi.fn();
    const verifyCustomerBinding = vi.fn();
    const repository: MarketingConsentRepository = { findConsent };

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: '   ',
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CUSTOMER_IDENTITY_REQUIRED');
    expect(verifyCustomerBinding).not.toHaveBeenCalled();
    expect(findConsent).not.toHaveBeenCalled();
  });

  it('refuses execution when caller asserts a tenant mismatch with server-bound tenant', async () => {
    const findConsent = vi.fn();
    const verifyCustomerBinding = vi.fn();
    const repository: MarketingConsentRepository = { findConsent };

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });

    await expect(
      port.check({
        tenant_id: OTHER_TENANT,
        customer_id: CUSTOMER_ID,
        channel: 'line',
      }),
    ).rejects.toThrow(MarketingRuntimeError);

    await expect(
      port.check({
        tenant_id: OTHER_TENANT,
        customer_id: CUSTOMER_ID,
        channel: 'line',
      }),
    ).rejects.toThrow('TENANT_CONTEXT_MISMATCH');

    expect(verifyCustomerBinding).not.toHaveBeenCalled();
    expect(findConsent).not.toHaveBeenCalled();
  });

  it('denies outreach and fails closed when consent row is missing in repository', async () => {
    const findConsent = vi.fn().mockResolvedValue(null);
    const repository: MarketingConsentRepository = { findConsent };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'EMAIL_HTML',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CONSENT_NOT_FOUND');
    expect(decision.consent_timestamp).toBeNull();
  });

  it('denies outreach when consent is not granted (is_granted = false)', async () => {
    const row = createFakeConsentRow({ is_granted: false });
    const repository: MarketingConsentRepository = {
      findConsent: vi.fn().mockResolvedValue(row),
    };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'SMS_TEXT',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CONSENT_OPTED_OUT');
  });

  it('denies outreach when opt_out_timestamp is set', async () => {
    const row = createFakeConsentRow({
      is_granted: true,
      opt_out_timestamp: new Date('2026-02-01T12:00:00.000Z'),
    });
    const repository: MarketingConsentRepository = {
      findConsent: vi.fn().mockResolvedValue(row),
    };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CONSENT_OPTED_OUT');
  });

  it('fails closed when repository findConsent throws an error', async () => {
    const repository: MarketingConsentRepository = {
      findConsent: vi.fn().mockRejectedValue(new Error('DB connection reset')),
    };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CONSENT_CHECK_ERROR');
    expect(decision.consent_timestamp).toBeNull();
  });

  it('denies outreach when row consent_type does not match marketing_messaging', async () => {
    const row = createFakeConsentRow({ consent_type: 'order_updates' });
    const repository: MarketingConsentRepository = {
      findConsent: vi.fn().mockResolvedValue(row),
    };
    const verifyCustomerBinding = vi.fn().mockResolvedValue(true);

    const port = createMarketingConsentPort({
      serverBoundTenantId: VALID_TENANT,
      verifyCustomerBinding,
      repository,
    });
    const decision = await port.check({
      tenant_id: VALID_TENANT,
      customer_id: CUSTOMER_ID,
      channel: 'line',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.suppression_reason).toBe('CONSENT_TYPE_MISMATCH');
  });
});

describe('createMarketingResearchPort', () => {
  it('throws MARKETING_RESEARCH_UNAVAILABLE when readMarketSignals is not configured', async () => {
    const port = createMarketingResearchPort();

    await expect(
      port.readMarketSignals({
        tenant_id: VALID_TENANT,
        market_region: 'TW',
        category_id: 'cat-1',
        observation_window_days: 30,
      }),
    ).rejects.toThrow(MarketingRuntimeError);

    await expect(
      port.readMarketSignals({
        tenant_id: VALID_TENANT,
        market_region: 'TW',
        category_id: 'cat-1',
        observation_window_days: 30,
      }),
    ).rejects.toThrow('MARKETING_RESEARCH_UNAVAILABLE');
  });

  it('throws MARKETING_SEGMENTATION_UNAVAILABLE when segmentAudience is not configured', async () => {
    const port = createMarketingResearchPort();

    await expect(
      port.segmentAudience({
        tenant_id: VALID_TENANT,
        rfm_criteria: 'CHAMPIONS',
        min_days_inactive: 10,
      }),
    ).rejects.toThrow(MarketingRuntimeError);

    await expect(
      port.segmentAudience({
        tenant_id: VALID_TENANT,
        rfm_criteria: 'CHAMPIONS',
        min_days_inactive: 10,
      }),
    ).rejects.toThrow('MARKETING_SEGMENTATION_UNAVAILABLE');
  });

  it('validates tenant binding on research calls', async () => {
    const port = createMarketingResearchPort({
      serverBoundTenantId: VALID_TENANT,
    });

    await expect(
      port.readMarketSignals({
        tenant_id: OTHER_TENANT,
        market_region: 'TW',
        category_id: 'cat-1',
        observation_window_days: 14,
      }),
    ).rejects.toThrow('TENANT_CONTEXT_MISMATCH');

    await expect(
      port.segmentAudience({
        tenant_id: OTHER_TENANT,
        rfm_criteria: 'LOYAL',
        min_days_inactive: 10,
      }),
    ).rejects.toThrow('TENANT_CONTEXT_MISMATCH');
  });

  it('delegates to injected research and segmentation implementations when provided', async () => {
    const mockSignalsResult = {
      signals: [],
      trend_velocity: 'STABLE' as const,
      source_uri: 'urn:mock:signals',
      source_version: 'v1',
    };
    const mockAudience = [
      {
        tenant_id: VALID_TENANT,
        customer_id: 'cust-123',
        source_uri: 'urn:mock:c360',
        source_version: 'v1',
        observed_at: '2026-01-01T00:00:00.000Z',
        match_reason: 'manual_cohort',
      },
    ];

    const readMarketSignals = vi.fn().mockResolvedValue(mockSignalsResult);
    const segmentAudience = vi.fn().mockResolvedValue(mockAudience);

    const port = createMarketingResearchPort({
      readMarketSignals,
      segmentAudience,
    });

    const signals = await port.readMarketSignals({
      tenant_id: VALID_TENANT,
      market_region: 'GLOBAL_US',
      category_id: 'cat-shoes',
      observation_window_days: 7,
    });
    expect(signals).toBe(mockSignalsResult);

    const audience = await port.segmentAudience({
      tenant_id: VALID_TENANT,
      rfm_criteria: 'POTENTIAL_LOYALIST',
      min_days_inactive: 15,
    });
    expect(audience).toBe(mockAudience);
  });
});

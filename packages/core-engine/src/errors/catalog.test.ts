import { describe, expect, it } from 'vitest';

import {
  ERROR_CATALOG,
  classifyErrorCode,
  getErrorCatalogEntry,
} from './catalog.js';

describe('error catalog', () => {
  it.each(Object.entries(ERROR_CATALOG))('defines a complete classification for %s', (code, entry) => {
    expect(getErrorCatalogEntry(code)).toBe(entry);
    expect(['RETRYABLE', 'FATAL', 'UNKNOWN']).toContain(entry.class);
    expect(entry.reason_key.length).toBeGreaterThan(0);
    expect(entry.admin_hint.length).toBeGreaterThan(0);
  });

  it.each([
    ['EFFECT_UNKNOWN', 'UNKNOWN'],
    ['SKILL_DISABLED', 'FATAL'],
    ['UNAUTHORIZED_AGENT', 'FATAL'],
    ['SCHEMA_CUSTOM_VALIDATION', 'FATAL'],
    ['CONSENT_REQUIRED', 'FATAL'],
    ['HANDOFF_REQUEST_FINGERPRINT_MISSING', 'FATAL'],
    ['ACTION_EFFECT_KEY_CONFLICT', 'FATAL'],
    ['OUT_OF_STOCK', 'FATAL'],
    ['P_FLOOR_UNAVAILABLE', 'FATAL'],
    ['AUTHORITATIVE_SOURCE_UNAVAILABLE', 'FATAL'],
    ['DOCUMENT_NOT_APPROVED', 'FATAL'],
    ['LLM_NOT_CONFIGURED', 'FATAL'],
    ['LLM_AUTH_FAILED', 'FATAL'],
    ['CAMPAIGN_DISPATCH_NOT_INTEGRATED', 'FATAL'],
    ['LLM_UNAVAILABLE', 'RETRYABLE'],
    ['LLM_TIMEOUT', 'RETRYABLE'],
    ['LLM_RATE_LIMITED', 'RETRYABLE'],
    ['TIMEOUT', 'RETRYABLE'],
    ['CIRCUIT_BREAKER_OPEN', 'RETRYABLE'],
    ['BREAKER_OPEN', 'RETRYABLE'],
    ['PROVIDER_RATE_LIMITED', 'RETRYABLE'],
    ['PROVIDER_503', 'RETRYABLE'],
    ['HTTP_500', 'RETRYABLE'],
    ['40001', 'RETRYABLE'],
    ['40P01', 'RETRYABLE'],
    ['ECONNRESET', 'RETRYABLE'],
  ] as const)('classifies %s as %s', (code, expected) => {
    expect(classifyErrorCode(code)).toBe(expected);
  });

  it('catalogs an action identity collision as a deterministic refusal', () => {
    expect(getErrorCatalogEntry('ACTION_EFFECT_KEY_CONFLICT')).toMatchObject({
      class: 'FATAL',
      reason_key: 'run.failure.deterministic',
    });
  });

  it('catalogs missing approved knowledge as a deterministic refusal', () => {
    expect(getErrorCatalogEntry('DOCUMENT_NOT_APPROVED')).toMatchObject({
      class: 'FATAL',
      reason_key: 'run.failure.deterministic',
    });
  });

  it('fails closed for an unrecognized error code', () => {
    expect(classifyErrorCode('UNMAPPED_CODE')).toBe('FATAL');
  });
});

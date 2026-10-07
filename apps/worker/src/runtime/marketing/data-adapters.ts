/**
 * @file Marketing Worker Runtime Data Adapters.
 *
 * Implements isolated runtime seams for consent verification and market research/segmentation
 * using lazy/injected dependencies and the canonical PostgreSQL repository contracts.
 *
 * INVARIANTS:
 * 1. Fail closed on consent: missing records, revoked status, opt-out timestamps, or errors deny outreach.
 * 2. Multi-tenant isolation: tenant ID must be server-bound and verified; caller cannot assert foreign tenants.
 * 3. Identity binding: customer identity must be verified as bound to the tenant before checking consent;
 *    unbound or unverified customers deny outreach without repository access.
 * 4. Epistemic integrity: no fabricated consent timestamps, no synthetic audience candidates, and no invented signals.
 * 5. Lazy database binding: no database pool connection on import.
 */

import { assertTenantContext, findConsent as canonicalFindConsent, getProfile, type ConsentRow } from '@agentos/database';
import type {
  ExecutionContext,
  InputMktAnalyzeSignal,
  InputMktSegmentAudience,
  MarketingAnalyticsPort,
  MarketingCustomer360Port,
  MarketingSignalReadPort,
  OutputMktAnalyzeSignal,
  OutputMktSegmentAudience,
} from './skills/types.js';
import {
  MarketingRuntimeError,
  type MarketingAudienceCandidate,
  type MarketingConsentDecision,
  type MarketingConsentPort,
  type MarketingResearchPort,
  type MarketingSegmentInput,
  type MarketingSignalInput,
  type MarketingSignalResearchResult,
} from './contracts.js';

export type FindConsentFn = (
  tenantId: string,
  customerId: string,
  consentType: string,
  channel: string,
) => Promise<ConsentRow | null>;

export interface MarketingConsentRepository {
  readonly findConsent: FindConsentFn;
}

export type CustomerBindingVerifier = (
  tenantId: string,
  customerId: string,
) => Promise<boolean> | boolean;

export interface MarketingConsentPortOptions {
  /** Mandatory server-bound tenant UUID; prevents caller-asserted tenant contexts. */
  readonly serverBoundTenantId: string;
  /** Injected server-side capability confirming the customer identity is bound to this tenant. */
  readonly verifyCustomerBinding?: CustomerBindingVerifier;
  /** Optional repository implementation; defaults to canonical `@agentos/database` findConsent. */
  readonly repository?: MarketingConsentRepository;
}

/**
 * Normalizes input channel identifiers (e.g. 'LINE_FLEX', 'EMAIL_HTML', 'sms') to
 * stored consent channel keys ('line', 'whatsapp', 'email', 'sms', etc.).
 */
export function normalizeMarketingChannel(channel: string): string {
  if (typeof channel !== 'string') {
    return '';
  }
  const trimmed = channel.trim().toLowerCase();
  if (trimmed.startsWith('line')) return 'line';
  if (trimmed.startsWith('whatsapp')) return 'whatsapp';
  if (trimmed.startsWith('email')) return 'email';
  if (trimmed.startsWith('sms')) return 'sms';
  if (trimmed.startsWith('zalo')) return 'zalo';
  if (trimmed.startsWith('messenger')) return 'messenger';
  if (trimmed.startsWith('instagram')) return 'instagram';
  if (trimmed.startsWith('tiktok')) return 'tiktok';
  return trimmed;
}

const MARKETING_CONSENT_TYPE = 'marketing_messaging';

/**
 * Creates a tenant/channel-scoped MarketingConsentPort.
 */
export function createMarketingConsentPort(options: MarketingConsentPortOptions): MarketingConsentPort {
  if (!options || typeof options.serverBoundTenantId !== 'string' || options.serverBoundTenantId.trim().length === 0) {
    throw new MarketingRuntimeError(
      'TENANT_CONTEXT_REQUIRED',
      'serverBoundTenantId is mandatory for createMarketingConsentPort to enforce server-side tenant binding.',
    );
  }

  const serverBoundTenantId = options.serverBoundTenantId;
  assertTenantContext(serverBoundTenantId);

  const repository: MarketingConsentRepository = options.repository ?? {
    findConsent: canonicalFindConsent,
  };
  const verifyCustomerBinding = options.verifyCustomerBinding;

  return {
    check: async (input: {
      readonly tenant_id: string;
      readonly customer_id: string;
      readonly channel: string;
    }): Promise<MarketingConsentDecision> => {
      // 1. Server-bound tenant check & tenant context validation
      const tenantId = input.tenant_id;
      if (tenantId !== serverBoundTenantId) {
        throw new MarketingRuntimeError(
          'TENANT_CONTEXT_MISMATCH',
          `Caller asserted tenant '${tenantId}' does not match server-bound tenant '${serverBoundTenantId}'.`,
        );
      }
      assertTenantContext(tenantId);

      // 2. Customer identity requirement
      const customerId = input.customer_id;
      if (!customerId || customerId.trim().length === 0) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId ?? '',
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CUSTOMER_IDENTITY_REQUIRED',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      // 3. Customer identity binding verification: must be confirmed before repository access
      if (!verifyCustomerBinding) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CUSTOMER_BINDING_UNVERIFIED',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      try {
        const isBound = await verifyCustomerBinding(serverBoundTenantId, customerId);
        if (!isBound) {
          return {
            tenant_id: serverBoundTenantId,
            customer_id: customerId,
            channel: input.channel,
            allowed: false,
            consent_timestamp: null,
            suppression_reason: 'CUSTOMER_BINDING_MISMATCH',
            source_uri: 'urn:agentos:consents',
            source_version: 'none',
          };
        }
      } catch {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CUSTOMER_BINDING_ERROR',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      // 4. Channel normalization
      const normalizedChannel = normalizeMarketingChannel(input.channel);
      if (!normalizedChannel) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'INVALID_CHANNEL',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      // 5. Read consent using canonical repository contract
      let row: ConsentRow | null = null;
      try {
        row = await repository.findConsent(
          serverBoundTenantId,
          customerId,
          MARKETING_CONSENT_TYPE,
          normalizedChannel,
        );
      } catch {
        // Any read failure fails closed
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_CHECK_ERROR',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      // 6. Evaluate consent row: missing, ungranted, or opted-out fails closed
      if (!row) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_NOT_FOUND',
          source_uri: 'urn:agentos:consents',
          source_version: 'none',
        };
      }

      if (row.consent_type !== MARKETING_CONSENT_TYPE) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: null,
          suppression_reason: 'CONSENT_TYPE_MISMATCH',
          source_uri: `urn:agentos:consent:${row.id}`,
          source_version: row.updated_at ? new Date(row.updated_at).toISOString() : 'none',
        };
      }

      if (!row.is_granted || row.opt_in_timestamp === null || row.opt_out_timestamp !== null) {
        return {
          tenant_id: serverBoundTenantId,
          customer_id: customerId,
          channel: input.channel,
          allowed: false,
          consent_timestamp: row.opt_in_timestamp ? new Date(row.opt_in_timestamp).toISOString() : null,
          suppression_reason: row.opt_in_timestamp === null
            ? 'CONSENT_TIMESTAMP_MISSING'
            : 'CONSENT_OPTED_OUT',
          source_uri: `urn:agentos:consent:${row.id}`,
          source_version: row.updated_at ? new Date(row.updated_at).toISOString() : 'none',
        };
      }

      // 7. Allowed consent decision
      return {
        tenant_id: serverBoundTenantId,
        customer_id: customerId,
        channel: input.channel,
        allowed: true,
        consent_timestamp: new Date(row.opt_in_timestamp).toISOString(),
        suppression_reason: null,
        source_uri: `urn:agentos:consent:${row.id}`,
        source_version: row.updated_at ? new Date(row.updated_at).toISOString() : '1',
      };
    },
  };
}

export interface MarketingResearchPortOptions {
  /** Injected implementation of market signals research. */
  readonly readMarketSignals?: (input: MarketingSignalInput) => Promise<MarketingSignalResearchResult>;
  /** Injected implementation of audience segmentation. */
  readonly segmentAudience?: (input: MarketingSegmentInput) => Promise<readonly MarketingAudienceCandidate[]>;
  /** Optional server-bound tenant UUID. */
  readonly serverBoundTenantId?: string;
}

/**
 * Creates a MarketingResearchPort.
 * If segmentation or market signal research cannot be supported from the canonical store without
 * inventing data, calling the missing method throws an explicit unavailable MarketingRuntimeError.
 */
export function createMarketingResearchPort(options: MarketingResearchPortOptions = {}): MarketingResearchPort {
  const { readMarketSignals, segmentAudience, serverBoundTenantId } = options;

  return {
    readMarketSignals: async (input: MarketingSignalInput): Promise<MarketingSignalResearchResult> => {
      if (serverBoundTenantId !== undefined && input.tenant_id !== serverBoundTenantId) {
        throw new MarketingRuntimeError(
          'TENANT_CONTEXT_MISMATCH',
          `Caller asserted tenant '${input.tenant_id}' does not match server-bound tenant '${serverBoundTenantId}'.`,
        );
      }
      assertTenantContext(input.tenant_id);

      if (!readMarketSignals) {
        throw new MarketingRuntimeError(
          'MARKETING_RESEARCH_UNAVAILABLE',
          'Market signals research is not configured in this runtime; signal providers must be explicitly injected.',
        );
      }
      return readMarketSignals(input);
    },

    segmentAudience: async (input: MarketingSegmentInput): Promise<readonly MarketingAudienceCandidate[]> => {
      if (serverBoundTenantId !== undefined && input.tenant_id !== serverBoundTenantId) {
        throw new MarketingRuntimeError(
          'TENANT_CONTEXT_MISMATCH',
          `Caller asserted tenant '${input.tenant_id}' does not match server-bound tenant '${serverBoundTenantId}'.`,
        );
      }
      assertTenantContext(input.tenant_id);

      if (!segmentAudience) {
        throw new MarketingRuntimeError(
          'MARKETING_SEGMENTATION_UNAVAILABLE',
          'Audience segmentation is unavailable: canonical C360 projection does not support arbitrary RFM cohort queries without inventing segmentation logic or customer data.',
        );
      }
      return segmentAudience(input);
    },
  };
}
/**
 * Tenant-scoped Customer360 segmentation adapter used by the live Marketing campaign plan.
 *
 * The worker does not query commerce tables directly. Hosts bind the authoritative Customer360
 * projection through `readAudience`; the adapter only enforces tenant identity and the approved
 * audience bound before the result enters the skill registry.
 */
export interface MarketingCustomer360PortOptions {
  readonly serverBoundTenantId: string;
  readonly readAudience: (
    input: InputMktSegmentAudience,
    context: ExecutionContext,
  ) => Promise<OutputMktSegmentAudience>;
}

export interface MarketingSignalReadPortOptions {
  readonly serverBoundTenantId: string;
  readonly readSignals: (
    input: InputMktAnalyzeSignal,
    context: ExecutionContext,
  ) => Promise<OutputMktAnalyzeSignal>;
}

function assertBoundTenant(
  inputTenant: unknown,
  contextTenant: string,
  boundTenant: string,
): asserts inputTenant is string {
  if (inputTenant !== boundTenant || contextTenant !== boundTenant) {
    throw new MarketingRuntimeError(
      'TENANT_CONTEXT_MISMATCH',
      'Marketing adapter input, execution context, and server-bound tenant must match',
    );
  }
}

function assertBoundTenantAtCreation(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new MarketingRuntimeError('TENANT_CONTEXT_REQUIRED', 'A server-bound tenant is required');
  }
  assertTenantContext(tenantId);
}

export function createMarketingCustomer360Port(
  options: MarketingCustomer360PortOptions,
): MarketingCustomer360Port {
  assertBoundTenantAtCreation(options.serverBoundTenantId);
  const boundTenant = options.serverBoundTenantId;

  return {
    segmentAudience: async (
      input: InputMktSegmentAudience,
      context: ExecutionContext,
    ): Promise<OutputMktSegmentAudience> => {
      assertBoundTenant(input.tenant_id, context.tenant_id, boundTenant);
      const maxSegmentSize = input.max_segment_size;
      if (
        typeof maxSegmentSize !== 'number'
        || !Number.isSafeInteger(maxSegmentSize)
        || maxSegmentSize < 1
      ) {
        throw new MarketingRuntimeError(
          'ASM_003_UNAVAILABLE',
          'Customer360 segmentation requires the server-resolved approved ASM-003 cap',
        );
      }
      const output = await options.readAudience(input, context);
      if (
        output === null
        || typeof output.segment_id !== 'string'
        || output.segment_id.trim().length === 0
        || !Number.isSafeInteger(output.matched_customer_count)
        || output.matched_customer_count < 0
        || !Array.isArray(output.customer_ids)
        || output.customer_ids.length !== output.matched_customer_count
        || output.customer_ids.length > maxSegmentSize
        || output.customer_ids.some((customerId) => typeof customerId !== 'string' || customerId.trim() === '')
        || typeof output.generated_at !== 'string'
      ) {
        throw new MarketingRuntimeError(
          'SEGMENT_OUTPUT_INVALID',
          'Customer360 returned an invalid or over-cap tenant-scoped audience',
        );
      }
      return output;
    },
  };
}

/**
 * Creates the tenant-scoped API-002 signal adapter. A signal reader is required: unlike a
 * campaign cohort, market velocity cannot be inferred from a missing or unrelated event stream.
 */
export function createMarketingSignalReadPort(
  options: MarketingSignalReadPortOptions,
): MarketingSignalReadPort {
  assertBoundTenantAtCreation(options.serverBoundTenantId);
  const boundTenant = options.serverBoundTenantId;
  return {
    readSignals: async (
      input: InputMktAnalyzeSignal,
      context: ExecutionContext,
    ): Promise<OutputMktAnalyzeSignal> => {
      assertBoundTenant(input.tenant_id, context.tenant_id, boundTenant);
      const output = await options.readSignals(input, context);
      if (!output || !Array.isArray(output.signals) || typeof output.trend_velocity !== 'string') {
        throw new MarketingRuntimeError('SIGNAL_OUTPUT_INVALID', 'API-002 returned an invalid signal result');
      }
      return output;
    },
  };
}

/**
 * Analytics remains a real, tenant-scoped capability even when no measured conversion exists.
 * The default deliberately refuses rather than returning zero-valued synthetic KPIs.
 */
export function createMarketingAnalyticsPort(
  serverBoundTenantId: string,
  evaluate: MarketingAnalyticsPort['evaluateAttribution'],
): MarketingAnalyticsPort {
  assertBoundTenantAtCreation(serverBoundTenantId);
  return {
    evaluateAttribution: async (input, context) => {
      assertBoundTenant(input.tenant_id, context.tenant_id, serverBoundTenantId);
      return evaluate(input, context);
    },
  };
}

/**
 * Verifies an identity belongs to the server-bound tenant before any consent row is read.
 * This is intentionally separate from the consent query so a foreign customer cannot probe
 * another tenant's consent state.
 */
export function createMarketingCustomerBindingVerifier(serverBoundTenantId: string): CustomerBindingVerifier {
  assertBoundTenantAtCreation(serverBoundTenantId);
  return async (tenantId, customerId) => {
    if (tenantId !== serverBoundTenantId) return false;
    const profile = await getProfile(serverBoundTenantId, customerId);
    return profile?.tenant_id === serverBoundTenantId && profile.customer_id === customerId;
  };
}

/**
 * @file Tenant-scoped Sales consent source.
 *
 * The Sales policy engine re-reads consent at the authority gate and never trusts a payload claim
 * (BR-004). This adapter answers that read from the tenant's own Customer360 profile, so a customer
 * whose marketing consent was revoked, or who is suppressed, is refused rather than assumed.
 */

import { getProfile, type CustomerProfileRow } from '@agentos/database';
import type { ConsentState } from '@agentos/core-engine';

import type { SalesConsentDecision, SalesConsentPort, SalesConsentQuery } from './skills/types.js';

export interface SalesConsentPortOptions {
  /** Injected profile reader; defaults to the canonical tenant-scoped repository read. */
  readonly getProfileFn?: (tenant_id: string, customer_id: string) => Promise<CustomerProfileRow | null>;
}

/**
 * Builds the `SalesConsentPort` over the tenant's Customer360 profile.
 *
 * @param options Injected profile reader.
 * @returns A port that answers `undefined` (unknown) for an unbound or foreign customer instead of
 *   inventing a consent, so the policy engine refuses rather than assuming permission.
 */
export function createSalesConsentPort(options: SalesConsentPortOptions = {}): SalesConsentPort {
  const readProfile = options.getProfileFn ?? ((tenant_id: string, customer_id: string) => getProfile(tenant_id, customer_id));

  const consentFor = async (tenant_id: string, customer_id: string): Promise<ConsentState | undefined> => {
    if (tenant_id.trim().length === 0 || customer_id.trim().length === 0) return undefined;
    const profile = await readProfile(tenant_id, customer_id);
    if (profile === null || profile.tenant_id !== tenant_id || profile.customer_id !== customer_id) {
      return undefined;
    }
    return {
      consent_marketing: profile.consent_marketing,
      suppression_active: profile.suppression_active,
    };
  };

  return {
    async getConsent(input: { readonly tenant_id: string; readonly customer_id: string }): Promise<ConsentState | undefined> {
      return consentFor(input.tenant_id, input.customer_id);
    },

    async read(query: SalesConsentQuery): Promise<SalesConsentDecision> {
      const state = await consentFor(query.tenant_id, query.customer_id);
      if (state === undefined) {
        return { consented: false, suppressed: false, reason: 'IDENTITY_UNVERIFIED' };
      }
      if (state.suppression_active) {
        return { consented: false, suppressed: true, reason: 'SUPPRESSED' };
      }
      if (!state.consent_marketing) {
        return { consented: false, suppressed: false, reason: 'CONSENT_REQUIRED' };
      }
      return { consented: true, suppressed: false };
    },
  };
}

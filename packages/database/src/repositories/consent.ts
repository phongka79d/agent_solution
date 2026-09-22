import type { ConsentInsert, ConsentRow } from '../contracts/index.js';
import { withTenantContext } from '../rls.js';
import { buildInsertQuery, requireRow } from './sql.js';

/** Columns of `agentos.consents`. */
const CONSENT_COLUMNS = [
  'id',
  'tenant_id',
  'customer_id',
  'consent_type',
  'channel',
  'is_granted',
  'opt_in_method',
  'opt_in_timestamp',
  'opt_out_timestamp',
  'evidence_text',
  'created_at',
  'updated_at',
].join(', ');

/**
 * Records one consent decision with the evidence that produced it (BR-004).
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param consent - Consent evidence to store; `opt_in_timestamp` defaults to the insert instant.
 * @returns The inserted consent row.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function insertConsent(
  tenantId: string,
  consent: ConsentInsert,
): Promise<ConsentRow> {
  return withTenantContext(tenantId, async (client) => {
    const { text, values } = buildInsertQuery('agentos.consents', [
      ['tenant_id', tenantId],
      ['customer_id', consent.customer_id],
      ['consent_type', consent.consent_type],
      ['channel', consent.channel],
      ['opt_in_method', consent.opt_in_method],
      ['is_granted', consent.is_granted],
      ['opt_in_timestamp', consent.opt_in_timestamp ?? new Date()],
      ['opt_out_timestamp', consent.opt_out_timestamp],
      ['evidence_text', consent.evidence_text],
    ]);

    const result = await client.query(text, values);

    return requireRow(result.rows as ConsentRow[], 'agentos.consents');
  });
}

/**
 * Reads the consent row for one customer, consent type and channel, which is the
 * tenant-scoped unique key of the table.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param customerId - Customer the consent belongs to.
 * @param consentType - Consent type, for example `marketing_messaging`.
 * @param channel - Consent channel, for example `line`.
 * @returns The consent row, or `null` when no decision was recorded.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function findConsent(
  tenantId: string,
  customerId: string,
  consentType: string,
  channel: string,
): Promise<ConsentRow | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT ${CONSENT_COLUMNS} FROM agentos.consents
        WHERE tenant_id = $1 AND customer_id = $2 AND consent_type = $3 AND channel = $4`,
      [tenantId, customerId, consentType, channel],
    );

    const row = result.rows[0] as ConsentRow | undefined;

    return row ?? null;
  });
}

/**
 * Revokes one consent by flipping `is_granted` and stamping `opt_out_timestamp`.
 *
 * The row is updated in place and never deleted: `opt_in_timestamp`, `evidence_text`
 * and `created_at` are left untouched, so the opt-in history that proves how consent
 * was obtained survives the revocation. Once revoked the row stays suppressed, which
 * is what the `suppression_active` flag of the Customer 360 projection reads.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param consentId - Consent row to revoke.
 * @returns The revoked row, or `null` when the tenant has no such consent.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function revokeConsent(
  tenantId: string,
  consentId: string,
): Promise<ConsentRow | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE agentos.consents
          SET is_granted = FALSE,
              opt_out_timestamp = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${CONSENT_COLUMNS}`,
      [tenantId, consentId],
    );

    const row = result.rows[0] as ConsentRow | undefined;

    return row ?? null;
  });
}

import type { CustomerFactInsert, CustomerFactRow, CustomerProfileRow } from '../contracts/index.js';
import { assertEpistemicWrite } from '../epistemic.js';
import { assertTenantContext, withTenantContext } from '../rls.js';
import { buildInsertQuery, requireRow } from './sql.js';

/** FACT columns of the `agentos.customer_360_profiles` projection. */
const PROFILE_COLUMNS = [
  'customer_id',
  'tenant_id',
  'verified_phone',
  'verified_email',
  'total_spent',
  'order_count',
  'rfm_segment_hypothesis',
  'consent_marketing',
  'consent_updated_at',
  'suppression_active',
  'line_user_id',
  'created_at',
].join(', ');

/** Own property that would smuggle a derived RFM hypothesis into the FACT store. */
const RFM_HYPOTHESIS_FIELD = 'rfm_segment_hypothesis';

/**
 * Reads the Customer 360 projection for one customer: verified handles only, the
 * derived `rfm_segment_hypothesis` label, and the fail-closed marketing consent.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param customerId - Customer whose projection row is read.
 * @returns The projection row, or `null` when the tenant has no such customer.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function getProfile(
  tenantId: string,
  customerId: string,
): Promise<CustomerProfileRow | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT ${PROFILE_COLUMNS} FROM agentos.customer_360_profiles
        WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, customerId],
    );

    const row = result.rows[0] as CustomerProfileRow | undefined;

    return row ?? null;
  });
}

/**
 * Inserts one authoritative FACT row into `agentos.customers`, the only write path
 * this package has into the customer mirror.
 *
 * A derived RFM label is a HYPOTHESIS, not a fact, so a `rfm_segment_hypothesis`
 * property is refused before any pool connection is opened; the label is read from
 * the projection and only ever persisted as an `agentos.evidences` HYPOTHESIS row.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param fact - FACT columns to write; omitted columns keep their DDL default.
 * @returns The inserted row.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 * @throws Error `HYPOTHESIS_PROMOTION_REFUSED` when `fact` carries an own `rfm_segment_hypothesis` property.
 */
export async function insertFact(
  tenantId: string,
  fact: CustomerFactInsert,
): Promise<CustomerFactRow> {
  assertTenantContext(tenantId);

  if (Object.hasOwn(fact, RFM_HYPOTHESIS_FIELD)) {
    // Delegates the refusal to the single epistemic boundary, so the code and the
    // remediation text have exactly one definition (FR-C360-003).
    assertEpistemicWrite('HYPOTHESIS', 'customers');
  }

  return withTenantContext(tenantId, async (client) => {
    const { text, values } = buildInsertQuery('agentos.customers', [
      ['tenant_id', tenantId],
      ['id', fact.id],
      ['external_crm_id', fact.external_crm_id],
      ['primary_phone', fact.primary_phone],
      ['primary_email', fact.primary_email],
      ['display_name', fact.display_name],
      ['verification_status', fact.verification_status],
      ['customer_tier', fact.customer_tier],
      ['total_spent', fact.total_spent],
      ['order_count', fact.order_count],
      ['last_interaction_at', fact.last_interaction_at],
      ['metadata', fact.metadata],
    ]);

    const result = await client.query(text, values);

    return requireRow(result.rows as CustomerFactRow[], 'agentos.customers');
  });
}

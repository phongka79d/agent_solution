import type { CustomerIdentityInsert, CustomerIdentityRow } from '../contracts/index.js';
import { withTenantContext } from '../rls.js';
import { buildInsertQuery, requireRow } from './sql.js';

/** Columns of `agentos.customer_identities`. */
const IDENTITY_COLUMNS = [
  'id',
  'tenant_id',
  'customer_id',
  'channel_type',
  'channel_identifier',
  'identifier_hash',
  'is_primary',
  'verified_at',
  'created_at',
].join(', ');

/**
 * Maps one channel handle (LINE UID, WhatsApp id, web UUID, phone, email) to a
 * customer.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param identity - Channel mapping to store; `identifier_hash` is the caller's digest of the handle.
 * @returns The inserted identity row.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function insertIdentity(
  tenantId: string,
  identity: CustomerIdentityInsert,
): Promise<CustomerIdentityRow> {
  return withTenantContext(tenantId, async (client) => {
    const { text, values } = buildInsertQuery('agentos.customer_identities', [
      ['tenant_id', tenantId],
      ['customer_id', identity.customer_id],
      ['channel_type', identity.channel_type],
      ['channel_identifier', identity.channel_identifier],
      ['identifier_hash', identity.identifier_hash],
      ['is_primary', identity.is_primary],
      ['verified_at', identity.verified_at],
    ]);

    const result = await client.query(text, values);

    return requireRow(result.rows as CustomerIdentityRow[], 'agentos.customer_identities');
  });
}

/**
 * Resolves the customer behind one channel handle, using the tenant-scoped unique
 * key `(tenant_id, channel_type, channel_identifier)`.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param channelType - Channel of the handle, for example `line`.
 * @param channelIdentifier - Platform-specific handle to resolve.
 * @returns The identity row, or `null` when this tenant has no such handle.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function findIdentity(
  tenantId: string,
  channelType: string,
  channelIdentifier: string,
): Promise<CustomerIdentityRow | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT ${IDENTITY_COLUMNS} FROM agentos.customer_identities
        WHERE tenant_id = $1 AND channel_type = $2 AND channel_identifier = $3`,
      [tenantId, channelType, channelIdentifier],
    );

    const row = result.rows[0] as CustomerIdentityRow | undefined;

    return row ?? null;
  });
}

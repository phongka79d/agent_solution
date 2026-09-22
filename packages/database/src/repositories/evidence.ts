import type { EvidenceInsert, EvidenceRow } from '../contracts/index.js';
import { withTenantContext } from '../rls.js';
import { buildInsertQuery, requireRow } from './sql.js';

/**
 * Appends one grounding evidence row to `agentos.evidences`.
 *
 * This is the append-only sink an AI HYPOTHESIS is allowed to live in: the row
 * carries the claim, its `source_uri`, the version it was read at and the component
 * that verified it, so a later FACT promotion has a validation record to cite. The
 * table is immutable, so no update or delete path exists here.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param evidence - Evidence to append; `taxonomy_type` is required and is the epistemic class of the claim.
 * @returns The appended evidence row.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function insertEvidence(
  tenantId: string,
  evidence: EvidenceInsert,
): Promise<EvidenceRow> {
  return withTenantContext(tenantId, async (client) => {
    const { text, values } = buildInsertQuery('agentos.evidences', [
      ['tenant_id', tenantId],
      ['customer_id', evidence.customer_id],
      ['run_id', evidence.run_id],
      ['taxonomy_type', evidence.taxonomy_type],
      ['claim', evidence.claim],
      ['source_uri', evidence.source_uri],
      ['source_version', evidence.source_version],
      ['conditions', evidence.conditions],
      ['verified_by', evidence.verified_by],
    ]);

    const result = await client.query(text, values);

    return requireRow(result.rows as EvidenceRow[], 'agentos.evidences');
  });
}

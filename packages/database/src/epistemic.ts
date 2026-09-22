import type { EpistemicClass, SoRFactTable } from './contracts/index.js';

/**
 * SoR-mirror tables whose rows are authoritative facts. A HYPOTHESIS value written
 * into any of them would promote an AI guess into customer fact (SRS §5 /
 * FR-C360-003), so every mirror writer must pass through `assertEpistemicWrite()`.
 */
export const SOR_FACT_TABLES: ReadonlyArray<SoRFactTable> = [
  'customers',
  'products',
  'skus',
  'prices',
  'inventories',
  'orders',
  'invoices',
];

/**
 * Enforces the persistence-side epistemic boundary: a HYPOTHESIS value is refused
 * by every SoR mirror and may only be stored as an `agentos.evidences` row whose
 * `taxonomy_type` is `HYPOTHESIS`. Every other class may target a mirror, because
 * those writes are the sourced FACT/SIGNAL/DECISION/ACTION paths.
 *
 * @param epistemicClass - Value class the caller is about to persist.
 * @param table - Unqualified SoR table name the write targets, for example `customers`.
 * @returns Nothing when the write is allowed.
 * @throws Error `HYPOTHESIS_PROMOTION_REFUSED` when a HYPOTHESIS targets an SoR mirror.
 */
export function assertEpistemicWrite(epistemicClass: EpistemicClass, table: string): void {
  if (epistemicClass !== 'HYPOTHESIS') {
    return;
  }

  const isSoRFactTable = SOR_FACT_TABLES.some((soRFactTable) => soRFactTable === table);

  if (isSoRFactTable) {
    throw new Error(
      `HYPOTHESIS_PROMOTION_REFUSED: refusing to write a HYPOTHESIS value into agentos.${table}; `
        + "persist it as an agentos.evidences row with taxonomy_type = 'HYPOTHESIS' instead (FR-C360-003).",
    );
  }
}

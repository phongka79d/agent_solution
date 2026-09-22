/**
 * Canonical skill registry seed (23 platform skills).
 *
 * P0 authorises no skill rows: the seed fails closed so a placeholder skill
 * definition can never be loaded as approved policy.
 *
 * @throws Error `SEED_POLICY_UNAPPROVED` always.
 */
export async function runSeed(): Promise<never> {
  throw new Error(
    'SEED_POLICY_UNAPPROVED: the 23 canonical platform skill rows are not authorized in this task; no unapproved row may become approved policy.',
  );
}

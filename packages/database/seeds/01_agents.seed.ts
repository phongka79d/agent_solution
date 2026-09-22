/**
 * Canonical agent registry seed (13 specialized agents).
 *
 * P0 authorises no agent rows and no business policy: the seed fails closed so a
 * placeholder value can never be mistaken for an approved registry row.
 *
 * @throws Error `SEED_POLICY_UNAPPROVED` always.
 */
export async function runSeed(): Promise<never> {
  throw new Error(
    'SEED_POLICY_UNAPPROVED: the 13 canonical agent rows are not authorized in this task; no unapproved row may become approved policy.',
  );
}

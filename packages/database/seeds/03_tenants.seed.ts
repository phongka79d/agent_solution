/**
 * Tenant registry seed.
 *
 * Tenant policy values stay unset and unapproved: the seed fails closed so no
 * tenant, including ASM-003/ASM-004 inputs, is created by accident.
 *
 * @throws Error `SEED_POLICY_UNAPPROVED` always.
 */
export async function runSeed(): Promise<never> {
  throw new Error(
    'SEED_POLICY_UNAPPROVED: no tenant row or tenant policy value is authorized in this task; unknown policy stays unset and fails closed.',
  );
}

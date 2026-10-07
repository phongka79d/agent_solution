import type { TenantGovernanceRepository } from '@agentos/database';

import type { GovernancePort } from '../../gateway/ports.js';

type GovernanceRepository = Pick<TenantGovernanceRepository, 'get'>;

/** Binds the read-only D2 setting; a missing row is the contract's disabled default. */
export function createGovernancePort(repository: GovernanceRepository): GovernancePort {
  return {
    async get(tenant_id) {
      const setting = await repository.get(tenant_id);
      return {
        require_distinct_approver: setting?.require_distinct_approver ?? false,
      };
    },
  };
}

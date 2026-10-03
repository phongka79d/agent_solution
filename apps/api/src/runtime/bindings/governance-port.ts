import type { TenantGovernanceRepository } from '@agentos/database';

import type { GovernancePort } from '../../gateway/ports.js';

type GovernanceRepository = Pick<TenantGovernanceRepository, 'get' | 'update'>;

/** Binds tenant governance reads and optimistic audited updates to their repository. */
export function createGovernancePort(repository: GovernanceRepository): GovernancePort {
  return {
    async get(tenant_id) {
      const setting = await repository.get(tenant_id);
      if (setting === null) throw new Error('GOVERNANCE_SETTINGS_NOT_FOUND');
      return setting;
    },
    async update(tenant_id, input) {
      return repository.update(tenant_id, input);
    },
  };
}

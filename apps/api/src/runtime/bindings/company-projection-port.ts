import type { CompanyActivityPageOptions, CompanyProjectionSources, CompanyProjectionRepository } from '@agentos/database';

import type { CompanyProjectionPort } from '../../gateway/ports.js';

type CompanyProjectionRepositoryPort = Pick<CompanyProjectionRepository, 'getSources'>;

/** Binds the tenant-scoped database source repository to the gateway port. */
export function createCompanyProjectionPort(repository: CompanyProjectionRepositoryPort): CompanyProjectionPort {
  return {
    getSources(tenant_id: string, activityPage?: CompanyActivityPageOptions): Promise<CompanyProjectionSources> {
      return repository.getSources(tenant_id, activityPage);
    },
  };
}

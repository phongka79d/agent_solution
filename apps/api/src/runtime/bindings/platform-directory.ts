import type { PlatformDirectoryRepository } from '@agentos/database';

import type { PlatformDirectoryPort } from '../../gateway/ports.js';

type PlatformDirectoryRepositoryPort = Pick<
  PlatformDirectoryRepository,
  | 'listTenants'
  | 'getTenant'
  | 'readiness'
  | 'usage'
  | 'listRuns'
  | 'runDetail'
  | 'runTraceDetails'
  | 'runsSummary'
  | 'reconciliationQueue'
  | 'companyOverview'
>;

/** Exposes the database's fixed platform projections to route handlers. */
export function createPlatformDirectoryPort(repository: PlatformDirectoryRepositoryPort): PlatformDirectoryPort {
  return repository;
}

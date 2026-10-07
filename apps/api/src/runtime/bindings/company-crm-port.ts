import type { CompanyCrmProjectionRepository } from '@agentos/database';

import type { CompanyCrmPort } from '../../gateway/ports.js';

type CompanyCrmRepository = Pick<
  CompanyCrmProjectionRepository,
  'listCustomers' | 'getCustomerProfile' | 'listCampaigns' | 'getCampaign' | 'getConversationSummary'
>;

/** Binds the read-only company CRM projections to the gateway port. */
export function createCompanyCrmPort(repository: CompanyCrmRepository): CompanyCrmPort {
  return repository;
}

import type { AssignableAuthority, IAdapterDispatcher } from '@agentos/core-engine/contracts';
import type { SkillRegistry, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';
import type {
  SalesContextAggregatorLike,
  SalesRecommendationRevenueEvidencePort,
} from './tool-port.js';

export type { ErpReadPort } from '../../connectors.js';
export type {
  SalesContextAggregatorLike,
  SalesRecommendationRevenueEvidence,
  SalesRecommendationRevenueEvidencePort,
  SalesSkillToolPortOptions,
} from './tool-port.js';

export interface SalesSkillOptions {
  readonly erp_read: ErpReadPort | null;
  readonly context: Pick<SalesContextAggregatorLike, 'verifiedCustomerFor' | 'verifiedTimelineFor'>;
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort;
  readonly now?: () => Date;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
}

export interface SalesSkillServices {
  readonly registry: SkillRegistry;
  readonly tool_port: SkillToolPort;
  readonly dispatcher: IAdapterDispatcher;
  readonly unbound: readonly string[];
}

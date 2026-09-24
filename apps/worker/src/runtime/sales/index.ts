/**
 * Sales runtime root.
 *
 * The worker's durable poll loop remains Customer Care-specific; this root exposes the deterministic
 * Sales graph and its offline harness without silently wiring Sales into that loop.
 */
export {
  SalesAgentRuntime,
  deriveEffectPolicy,
  extractMessageContent,
  isCustomerLookupInquiry,
  isInventoryInquiry,
  isPriceInquiry,
  isProductSearchInquiry,
  isRecommendInquiry,
  type DerivedEffectPolicy,
  type ParsedSalesRationale,
  type SalesAgentRuntimeOptions,
  type SalesIntent,
  type SkillRegistryPort,
  type SkillRegistryResolver,
  type SkillRegistryRowMetadata,
} from './agent-runtime.js';

export {
  BoundedMap,
  SalesContextAggregator,
  type SalesContextAggregatorOptions,
  type SalesContextAggregatorRepositories,
  type SalesCustomerEventTimeline,
} from './context-aggregator.js';

export {
  createSalesSkillDispatcher,
  createSalesSkillServices,
  createSalesSkillToolPort,
  SalesSkillToolError,
  type ErpReadPort,
  type SalesContextAggregatorLike,
  type SalesRecommendationRevenueEvidence,
  type SalesRecommendationRevenueEvidencePort,
  type SalesSkillOptions,
  type SalesSkillServices,
  type SalesSkillToolPortOptions,
} from './skills/index.js';

export {
  createSalesOfflineHarness,
  PILOT_02_OFFLINE_FIXTURE,
  SALES_P2_DISABLED_SKILLS,
  SalesOfflineHarness,
  SalesOfflineHarnessError,
  type SalesOfflineCatalogItem,
  type SalesOfflineFixture,
  type SalesOfflineHarnessOptions,
  type SalesOfflineInventoryItem,
  type SalesOfflineReadInput,
  type SalesOfflineRefusalCode,
  type SalesOfflineSkillServiceOverrides,
} from './offline-harness.js';

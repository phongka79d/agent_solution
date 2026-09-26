/**
 * @file Customer Care Runtime Root (implement/04 §3.2, implement/06 §8.1).
 *
 * Exports the complete Customer Care orchestration graph for worker execution.
 */

export {
  createCareOrchestratorFactory,
  createCarePolicyEngine,
  getUnboundCapabilities,
  type CareAdaptersShape,
  type CareOrchestratorFactoryOptions,
  type CareSkillEnv,
  type CreateCarePolicyEngineOptions,
} from './factory.js';

export {
  CareContextAggregator,
  type CareContextAggregatorOptions,
  type CareContextAggregatorRepositories,
} from './context-aggregator.js';

export {
  CareAgentRuntime,
  extractOrderReference,
  isOrderStatusMessage,
  isQuestionMessage,
} from './agent-runtime.js';

export {
  CARE_SKILLS,
  CARE_ALLOWED_PAYLOAD_FIELDS,
} from './policy-registry.js';

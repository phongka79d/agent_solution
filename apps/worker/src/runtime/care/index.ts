/**
 * @file Customer Care Runtime Root (implement/04 §3.2, implement/06 §8.1).
 *
 * Exports the complete Customer Care orchestration graph for worker execution.
 */

export {
  createCareOrchestratorFactory,
  getUnboundCapabilities,
  type CareAdaptersShape,
  type CareOrchestratorFactoryOptions,
  type CareSkillEnv,
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
  CarePolicyEngine,
  type CarePolicyEngineOptions,
} from './policy-engine.js';

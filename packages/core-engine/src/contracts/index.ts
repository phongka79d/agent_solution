/** Single home of the shared orchestration contracts (implement/02 §2 core-engine boundary). */
export * from './types.js';
export * from './cross-domain-handoff.js';
export {
  IContextAggregator,
  IAgentRuntime,
  IPolicyEngine,
  IAdapterDispatcher,
  IIdentityResolver,
  ISessionControl,
  ICrossDomainHandoffBroker,
  DurableLeaseManager,
} from './ports.js';

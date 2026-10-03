/** Single home of the shared orchestration contracts (implement/02 §2 core-engine boundary). */
export * from './types.js';
export { getErrorCatalogEntry } from '../errors/catalog.js';
export type { ResponseKind, TemplateKey } from '../responses/templates.js';
export * from './cross-domain-handoff.js';
export {
  IContextAggregator,
  IAgentRuntime,
  IPlanInputResolver,
  IResponseFinalizer,
  IRunResponseStore,
  IRunStageRecorder,
  IPolicyEngine,
  IAdapterDispatcher,
  IIdentityResolver,
  ISessionControl,
  ICrossDomainHandoffBroker,
  DurableLeaseManager,
} from './ports.js';

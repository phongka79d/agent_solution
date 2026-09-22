import type {
  ActionDraft,
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';

import { UnknownConnectorError, type ConnectorRegistry } from './registry.js';

/**
 * The dispatcher the engine sees: one action draft in, one provider receipt out.
 *
 * It is the only place where an `adapter_target` becomes transport behavior, and it holds the
 * fail-closed rule that matters most at this boundary: an id that is not registered is refused
 * before any transport call, so an action can never be sent to a provider the composition root
 * never bound. There is no default connector and no no-op success.
 *
 * Settlement of the effect reservation belongs to the caller (`04` §4.4): this function reports
 * what the provider said and nothing more, because only the orchestrator knows whether the
 * reservation it holds should be resolved, left RESERVED for reconciliation, or failed.
 *
 * @param deps.registry The composition-root registry. An empty registry dispatches nothing.
 * @throws Error `CONNECTOR_NOT_FOUND` when the action names an unregistered connector.
 */
export function createAdapterDispatcher(deps: {
  readonly registry: ConnectorRegistry;
  /** Builds the refusal raised for an unknown target; the owning layer supplies its error type. */
  readonly refuseUnknownTarget?: (connector_id: string) => Error;
}): IAdapterDispatcher {
  const refuse =
    deps.refuseUnknownTarget ??
    ((connector_id: string): Error =>
      new UnknownConnectorError(connector_id));

  return {
    dispatch: async (action: ActionDraft): Promise<ExecutionReceipt> => {
      try {
        return await deps.registry.resolve(action.adapter_target).dispatch(action);
      } catch (error) {
        if (error instanceof UnknownConnectorError) {
          throw refuse(action.adapter_target);
        }
        throw error;
      }
    },
  };
}

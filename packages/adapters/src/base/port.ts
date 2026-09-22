import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

/**
 * Transport port every external connector implements. The port is bound at the gateway/worker
 * boundary, so the orchestrator never learns a provider SDK, credential or vendor payload shape.
 */
export interface AdapterPort {
  /** Stable connector identifier, e.g. the `adapter_target` a `PlannedStep` names. */
  readonly adapterId: string;
  /**
   * Sends one already-authorized action draft to the provider.
   *
   * @param draft Immutable action draft produced by the orchestrator's dispatch guard.
   * @returns The provider receipt, or a timeout/error receipt when the outcome is not confirmed.
   */
  dispatch(draft: ActionDraft): Promise<ExecutionReceipt>;
}

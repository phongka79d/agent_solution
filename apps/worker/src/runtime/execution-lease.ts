import { OrchestratorError } from '@agentos/core-engine';
import type { DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';

export type ExecutionLeaseRepository = Pick<DurableWorkflowRepository, 'getTask'>;

export interface ExecutionLeaseAssertionOptions {
  readonly workflowRepository: ExecutionLeaseRepository;
  readonly workerId: string;
  readonly now?: () => Date;
}

/**
 * Builds the fence checked immediately before every provider dispatch.
 * The durable task row is authoritative: an absent, foreign, terminal or expired lease
 * never admits an adapter call.
 */
export function createExecutionLeaseAssertion(
  options: ExecutionLeaseAssertionOptions,
): (tenant_id: string, run_id: string) => Promise<void> {
  const now = options.now ?? (() => new Date());

  return async (tenant_id: string, run_id: string): Promise<void> => {
    const task: DurableTaskRecord | null = await options.workflowRepository.getTask(tenant_id, run_id);
    if (task === null) {
      throw new OrchestratorError(
        'TASK_NOT_FOUND',
        `Cannot assert execution lease: durable task '${run_id}' was not found for tenant '${tenant_id}'`,
      );
    }

    if (task.state !== 'running') {
      throw new OrchestratorError(
        'TASK_LEASE_NOT_HELD',
        `Execution lease for task '${run_id}' is not dispatchable in state '${task.state}'`,
      );
    }
    if (task.lease_owner !== options.workerId) {
      throw new OrchestratorError(
        'TASK_LEASE_NOT_HELD',
        `Worker '${options.workerId}' does not hold the execution lease for task '${run_id}'`,
      );
    }

    const expiresAt = task.lease_expires_at === null ? Number.NaN : Date.parse(task.lease_expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now().getTime()) {
      throw new OrchestratorError(
        'TASK_LEASE_EXPIRED',
        `Execution lease for task '${run_id}' is absent or expired`,
      );
    }
  };
}

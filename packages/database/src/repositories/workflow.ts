import type { WorkflowInsert, WorkflowProgressUpdate, WorkflowRow } from '../contracts/index.js';
import { assertTenantContext, withTenantContext } from '../rls.js';
import type { SqlField, SqlValue } from './sql.js';
import { buildInsertQuery, requireRow } from './sql.js';

/** Columns of `agentos.workflows`. */
const WORKFLOW_COLUMNS = [
  'id',
  'tenant_id',
  'workflow_name',
  'correlation_id',
  'current_step',
  'status',
  'context_data',
  'started_at',
  'completed_at',
].join(', ');

/**
 * Creates one durable orchestration row.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param workflow - Workflow to create; `current_step`, `status` and `context_data` keep their DDL defaults when omitted.
 * @returns The inserted workflow row.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function insertWorkflow(
  tenantId: string,
  workflow: WorkflowInsert,
): Promise<WorkflowRow> {
  return withTenantContext(tenantId, async (client) => {
    const { text, values } = buildInsertQuery('agentos.workflows', [
      ['tenant_id', tenantId],
      ['workflow_name', workflow.workflow_name],
      ['correlation_id', workflow.correlation_id],
      ['current_step', workflow.current_step],
      ['status', workflow.status],
      ['context_data', workflow.context_data],
    ]);

    const result = await client.query(text, values);

    return requireRow(result.rows as WorkflowRow[], 'agentos.workflows');
  });
}

/**
 * Reads one workflow of the tenant.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param workflowId - Workflow to read.
 * @returns The workflow row, or `null` when the tenant has no such workflow.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 */
export async function getWorkflow(
  tenantId: string,
  workflowId: string,
): Promise<WorkflowRow | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT ${WORKFLOW_COLUMNS} FROM agentos.workflows WHERE tenant_id = $1 AND id = $2`,
      [tenantId, workflowId],
    );

    const row = result.rows[0] as WorkflowRow | undefined;

    return row ?? null;
  });
}

/**
 * Advances a workflow by writing only the four progress columns it is allowed to
 * move: `current_step`, `status`, `context_data` and `completed_at`. Omitted fields
 * keep their stored value, and the identity columns (`workflow_name`,
 * `correlation_id`, `started_at`) can never be rewritten.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param workflowId - Workflow whose progress advances.
 * @param progress - Progress columns to write; at least one is required.
 * @returns The updated workflow row, or `null` when the tenant has no such workflow.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID.
 * @throws Error `WORKFLOW_PROGRESS_REQUIRED` when `progress` carries no progress column.
 */
export async function updateWorkflowProgress(
  tenantId: string,
  workflowId: string,
  progress: WorkflowProgressUpdate,
): Promise<WorkflowRow | null> {
  assertTenantContext(tenantId);

  const assignments: SqlField[] = [];

  if (progress.current_step !== undefined) {
    assignments.push(['current_step', progress.current_step]);
  }

  if (progress.status !== undefined) {
    assignments.push(['status', progress.status]);
  }

  if (progress.context_data !== undefined) {
    assignments.push(['context_data', progress.context_data]);
  }

  if (progress.completed_at !== undefined) {
    assignments.push(['completed_at', progress.completed_at]);
  }

  if (assignments.length === 0) {
    throw new Error(
      'WORKFLOW_PROGRESS_REQUIRED: refusing to update agentos.workflows without at least one of '
        + 'current_step, status, context_data, completed_at.',
    );
  }

  return withTenantContext(tenantId, async (client) => {
    const values: SqlValue[] = [tenantId, workflowId];
    const setClauses: string[] = [];

    for (const [column, value] of assignments) {
      values.push(value);
      setClauses.push(`${column} = $${values.length}`);
    }

    const result = await client.query(
      `UPDATE agentos.workflows SET ${setClauses.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${WORKFLOW_COLUMNS}`,
      values,
    );

    const row = result.rows[0] as WorkflowRow | undefined;

    return row ?? null;
  });
}

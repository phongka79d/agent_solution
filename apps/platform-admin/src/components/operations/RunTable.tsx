/**
 * Keyboard-accessible virtualized/paginated tabular view of R16 agent run history.
 */

import { AdvancedDetails, StatusBadge } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';

import type { AgentRunProjection } from './types';
import { isRunRetryable } from './retry-helpers';
interface RunTableProps {
  readonly runs: readonly AgentRunProjection[];
  readonly isLoading: boolean;
  readonly selectedRunId: string | null;
  readonly onSelectRun: (run: AgentRunProjection) => void;
  readonly onRetryRun: (run: AgentRunProjection) => void;
  readonly nextCursor: string | null | undefined;
  readonly cursorStackLength: number;
  readonly onNextPage: () => void;
  readonly onPrevPage: () => void;
  readonly totalCount?: number | undefined;
}

function stateCode(state: string): string {
  switch (state) {
    case 'completed':
    case 'success':
      return 'ACTIVE';
    case 'failed':
      return 'FAILED';
    case 'running':
    case 'executing':
      return 'ATTENTION';
    case 'queued':
    case 'waiting':
      return 'APPROVAL_PENDING';
    case 'awaiting_human':
      return 'HUMAN_HANDOFF';
    default:
      return 'UNKNOWN';
  }
}

export function RunTable({
  runs,
  isLoading,
  selectedRunId,
  onSelectRun,
  onRetryRun,
  nextCursor,
  cursorStackLength,
  onNextPage,
  onPrevPage,
  totalCount,
}: RunTableProps) {
  return (
    <div className="platform-card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-mono">
          Showing {runs.length} run{runs.length === 1 ? '' : 's'}
          {typeof totalCount === 'number' ? ` of ${totalCount}` : ''}
        </span>
        {isLoading && <span className="animate-pulse font-mono text-brand">Syncing R16...</span>}
      </div>

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="ui-table min-w-[900px] font-mono text-xs" role="table">
          <thead>
            <tr>
              <th scope="col">Run ID</th>
              <th scope="col">Agent</th>
              <th scope="col">State</th>
              <th scope="col" className="ui-table__numeric">Steps</th>
              <th scope="col" className="ui-table__numeric">Latency</th>
              <th scope="col" className="ui-table__numeric">Cost</th>
              <th scope="col">Retry</th>
              <th scope="col">Error Class</th>
              <th scope="col" className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && !isLoading && (
              <tr>
                <td colSpan={9} className="text-center font-sans text-muted">No run executions found matching active criteria.</td>
              </tr>
            )}
            {runs.map((run) => {
              const isSelected = selectedRunId === run.run_id;
              const canRetry = isRunRetryable(run);
              const stepCount = run.steps?.length ?? run.current_step;
              return (
                <tr
                  key={run.run_id}
                  tabIndex={0}
                  aria-selected={isSelected}
                  onClick={() => onSelectRun(run)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRun(run);
                    }
                  }}
                  className={`cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ${isSelected ? 'bg-brand-soft text-ink' : 'text-ink-body hover:bg-surface-low'}`}
                >
                  <td className="max-w-[120px] truncate font-semibold text-brand" title={run.run_id}>{run.run_id.slice(0, 8)}...</td>
                  <td className="font-semibold text-ink">{run.agent_id}</td>
                  <td><StatusBadge code={stateCode(run.state)} /><AdvancedDetails value={run.state} /></td>
                  <td className="ui-table__numeric text-muted">{typeof stepCount === 'number' ? stepCount : t('common.empty')}</td>
                  <td className="ui-table__numeric text-ink-body">{typeof run.latency_ms === 'number' ? `${run.latency_ms}ms` : t('common.empty')}</td>
                  <td className="ui-table__numeric text-ink-body">{typeof run.cost === 'number' ? `$${run.cost.toFixed(4)}` : t('common.empty')}</td>
                  <td className="text-muted">r{run.retry_count}</td>
                  <td className="max-w-[130px] truncate text-muted" title={run.last_error_class || ''}>{run.last_error_class ? <AdvancedDetails value={run.last_error_class} /> : t('common.empty')}</td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1.5 font-sans">
                      <button type="button" onClick={() => onSelectRun(run)} className="ui-button ui-button--secondary ui-button--compact">Inspect</button>
                      <button type="button" disabled={!canRetry} onClick={() => onRetryRun(run)} title={canRetry ? 'Execute safe operator retry' : 'Retry unavailable (only verified side-effect-free failures can be retried)'} className="ui-button ui-button--danger ui-button--compact disabled:cursor-not-allowed">Retry</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-1 text-xs">
        <button type="button" onClick={onPrevPage} disabled={cursorStackLength === 0 || isLoading} className="ui-button ui-button--secondary ui-button--sm disabled:cursor-not-allowed">&larr; Previous Page</button>
        <span className="font-mono text-[11px] text-muted">Page {cursorStackLength + 1}</span>
        <button type="button" onClick={onNextPage} disabled={!nextCursor || isLoading} className="ui-button ui-button--secondary ui-button--sm disabled:cursor-not-allowed">Next Page &rarr;</button>
      </div>
    </div>
  );
}

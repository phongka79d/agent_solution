/**
 * Keyboard-accessible query filter controls for R16 agent run history.
 */

import type { KeyboardEvent } from 'react';
import type { RunFilters } from './types';

interface RunFilterControlsProps {
  readonly filters: RunFilters;
  readonly onChange: (filters: RunFilters) => void;
  readonly onApply: () => void;
  readonly onReset: () => void;
  readonly isLoading: boolean;
}

const LIFECYCLE_STATES = [
  'accepted',
  'queued',
  'running',
  'waiting',
  'awaiting_human',
  'completed',
  'stopped',
  'failed',
] as const;

const EXECUTION_STATUSES = [
  'pending',
  'executing',
  'success',
  'failed',
  'denied',
  'aborted',
] as const;

export function RunFilterControls({
  filters,
  onChange,
  onApply,
  onReset,
  isLoading,
}: RunFilterControlsProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <form
      aria-label="Filter Agent Runs"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
      onKeyDown={handleKeyDown}
      className="platform-card p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <div>
          <label htmlFor="filter-agent-id" className="mb-1 block text-xs font-medium text-ink-body">
            Agent ID
          </label>
          <input
            id="filter-agent-id"
            type="text"
            value={filters.agent_id}
            onChange={(e) => onChange({ ...filters, agent_id: e.target.value })}
            placeholder="e.g. AGENT-SALES-01"
            className="ui-input w-full font-mono text-xs"
          />
        </div>

        <div>
          <label htmlFor="filter-state" className="mb-1 block text-xs font-medium text-ink-body">
            Task State
          </label>
          <select
            id="filter-state"
            value={filters.state}
            onChange={(e) => onChange({ ...filters, state: e.target.value })}
            className="ui-select w-full font-mono text-xs"
          >
            <option value="">All States</option>
            {LIFECYCLE_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="filter-status" className="mb-1 block text-xs font-medium text-ink-body">
            Step Status
          </label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value })}
            className="ui-select w-full font-mono text-xs"
          >
            <option value="">All Statuses</option>
            {EXECUTION_STATUSES.map((stat) => <option key={stat} value={stat}>{stat}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="filter-from" className="mb-1 block text-xs font-medium text-ink-body">
            From Timestamp
          </label>
          <input
            id="filter-from"
            type="text"
            value={filters.from}
            onChange={(e) => onChange({ ...filters, from: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm:ssZ"
            className="ui-input w-full font-mono text-xs"
          />
        </div>

        <div>
          <label htmlFor="filter-to" className="mb-1 block text-xs font-medium text-ink-body">
            To Timestamp
          </label>
          <input
            id="filter-to"
            type="text"
            value={filters.to}
            onChange={(e) => onChange({ ...filters, to: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm:ssZ"
            className="ui-input w-full font-mono text-xs"
          />
        </div>

        <div>
          <label htmlFor="filter-limit" className="mb-1 block text-xs font-medium text-ink-body">
            Page Limit
          </label>
          <select
            id="filter-limit"
            value={filters.limit}
            onChange={(e) => onChange({ ...filters, limit: Number(e.target.value) || 20 })}
            className="ui-select w-full font-mono text-xs"
          >
            <option value="10">10 per page</option>
            <option value="20">20 per page</option>
            <option value="50">50 per page</option>
            <option value="100">100 per page</option>
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
        <button type="button" onClick={onReset} disabled={isLoading} className="ui-button ui-button--ghost ui-button--sm" aria-label="Reset filters">
          Reset Filters
        </button>
        <button type="submit" disabled={isLoading} className="ui-button ui-button--primary ui-button--sm">
          {isLoading ? 'Loading...' : 'Apply Filters'}
        </button>
      </div>
    </form>
  );
}

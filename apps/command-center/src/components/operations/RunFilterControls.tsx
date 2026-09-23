/**
 * @file apps/command-center/src/components/operations/RunFilterControls.tsx
 * Keyboard-accessible query filter controls for R16 agent run history.
 */

import React from 'react';
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
  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <div>
          <label htmlFor="filter-agent-id" className="block text-xs font-medium text-slate-300 mb-1">
            Agent ID
          </label>
          <input
            id="filter-agent-id"
            type="text"
            value={filters.agent_id}
            onChange={(e) => onChange({ ...filters, agent_id: e.target.value })}
            placeholder="e.g. AGENT-SALES-01"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          />
        </div>

        <div>
          <label htmlFor="filter-state" className="block text-xs font-medium text-slate-300 mb-1">
            Task State
          </label>
          <select
            id="filter-state"
            value={filters.state}
            onChange={(e) => onChange({ ...filters, state: e.target.value })}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          >
            <option value="">All States</option>
            {LIFECYCLE_STATES.map((st) => (
              <option key={st} value={st}>
                {st}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-status" className="block text-xs font-medium text-slate-300 mb-1">
            Step Status
          </label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value })}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          >
            <option value="">All Statuses</option>
            {EXECUTION_STATUSES.map((stat) => (
              <option key={stat} value={stat}>
                {stat}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="filter-from" className="block text-xs font-medium text-slate-300 mb-1">
            From Timestamp
          </label>
          <input
            id="filter-from"
            type="text"
            value={filters.from}
            onChange={(e) => onChange({ ...filters, from: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm:ssZ"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          />
        </div>

        <div>
          <label htmlFor="filter-to" className="block text-xs font-medium text-slate-300 mb-1">
            To Timestamp
          </label>
          <input
            id="filter-to"
            type="text"
            value={filters.to}
            onChange={(e) => onChange({ ...filters, to: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm:ssZ"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          />
        </div>

        <div>
          <label htmlFor="filter-limit" className="block text-xs font-medium text-slate-300 mb-1">
            Page Limit
          </label>
          <select
            id="filter-limit"
            value={filters.limit}
            onChange={(e) => onChange({ ...filters, limit: Number(e.target.value) || 20 })}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono"
          >
            <option value="10">10 per page</option>
            <option value="20">20 per page</option>
            <option value="50">50 per page</option>
            <option value="100">100 per page</option>
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 pt-2 border-t border-slate-800/80">
        <button
          type="button"
          onClick={onReset}
          disabled={isLoading}
          className="rounded px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Reset Filters
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="rounded bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {isLoading ? 'Loading...' : 'Apply Filters'}
        </button>
      </div>
    </form>
  );
}

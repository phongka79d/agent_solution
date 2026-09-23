/**
 * @file apps/command-center/src/components/operations/AgentDirectory.tsx
 * Dynamic agent directory derived purely from returned R16 run records.
 * Never invents agent identities, fake metrics, or phantom status rows.
 */

import React, { useMemo } from 'react';
import type { AgentRunProjection, AgentDirectoryItem, TaskLifecycleState } from './types';

interface AgentDirectoryProps {
  readonly runs: readonly AgentRunProjection[];
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
}

export function AgentDirectory({
  runs,
  selectedAgentId,
  onSelectAgent,
}: AgentDirectoryProps) {
  const directory = useMemo<readonly AgentDirectoryItem[]>(() => {
    const map = new Map<
      string,
      {
        total: number;
        success: number;
        failed: number;
        running: number;
        latencies: number[];
        cost: number;
        lastActive: string | null;
        lastState: TaskLifecycleState | null;
      }
    >();

    for (const run of runs) {
      if (!run.agent_id) continue;
      const existing = map.get(run.agent_id) ?? {
        total: 0,
        success: 0,
        failed: 0,
        running: 0,
        latencies: [],
        cost: 0,
        lastActive: null,
        lastState: null,
      };

      existing.total += 1;
      if (run.state === 'completed' || run.execution_status === 'success') {
        existing.success += 1;
      }
      if (run.state === 'failed' || run.execution_status === 'failed') {
        existing.failed += 1;
      }
      if (
        run.state === 'running' ||
        run.state === 'queued' ||
        run.execution_status === 'executing'
      ) {
        existing.running += 1;
      }

      if (typeof run.latency_ms === 'number' && run.latency_ms >= 0) {
        existing.latencies.push(run.latency_ms);
      }
      if (typeof run.cost === 'number' && run.cost > 0) {
        existing.cost += run.cost;
      }

      if (!existing.lastActive || (run.started_at && run.started_at > existing.lastActive)) {
        existing.lastActive = run.started_at;
        existing.lastState = run.state;
      }

      map.set(run.agent_id, existing);
    }

    return Array.from(map.entries())
      .map(([agent_id, stats]) => ({
        agent_id,
        totalRuns: stats.total,
        successCount: stats.success,
        failedCount: stats.failed,
        runningCount: stats.running,
        avgLatencyMs:
          stats.latencies.length > 0
            ? Math.round(
                stats.latencies.reduce((sum, val) => sum + val, 0) / stats.latencies.length
              )
            : null,
        totalCost: stats.cost > 0 ? stats.cost : null,
        lastActiveAt: stats.lastActive,
        lastState: stats.lastState,
      }))
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  }, [runs]);

  return (
    <section
      aria-label="Observed Agent Directory"
      className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-200">Observed Agent Directory</h2>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-slate-400">
            {directory.length} Active
          </span>
        </div>
        {selectedAgentId && (
          <button
            type="button"
            onClick={() => onSelectAgent('')}
            className="text-xs text-sky-400 hover:text-sky-300 focus-visible:outline-none focus-visible:underline"
          >
            Clear Filter ({selectedAgentId})
          </button>
        )}
      </div>

      {directory.length === 0 ? (
        <div className="rounded border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">
          No agent identities observed in the currently returned run dataset.
        </div>
      ) : (
        <div
          role="list"
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {directory.map((agent) => {
            const isSelected = selectedAgentId === agent.agent_id;
            const successRate =
              agent.totalRuns > 0
                ? Math.round((agent.successCount / agent.totalRuns) * 100)
                : 0;

            return (
              <div
                key={agent.agent_id}
                role="listitem"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => onSelectAgent(isSelected ? '' : agent.agent_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectAgent(isSelected ? '' : agent.agent_id);
                  }
                }}
                className={`cursor-pointer rounded border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  isSelected
                    ? 'border-sky-500 bg-sky-950/40 text-slate-100 shadow-sm'
                    : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between gap-1 mb-2">
                  <span className="font-mono text-xs font-semibold text-sky-300 truncate">
                    {agent.agent_id}
                  </span>
                  {agent.runningCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-mono">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      {agent.runningCount} busy
                    </span>
                  ) : agent.failedCount > 0 ? (
                    <span className="text-[10px] text-rose-400 font-mono">
                      {agent.failedCount} failed
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 font-mono">idle</span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-1 text-[11px] text-slate-400 font-mono">
                  <div>
                    <span className="block text-[10px] text-slate-500 uppercase">Runs</span>
                    <span className="text-slate-200">{agent.totalRuns}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-500 uppercase">Pass</span>
                    <span className={successRate === 100 ? 'text-emerald-400' : 'text-slate-200'}>
                      {successRate}%
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-500 uppercase">Lat</span>
                    <span className="text-slate-200">
                      {agent.avgLatencyMs !== null ? `${agent.avgLatencyMs}ms` : '-'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

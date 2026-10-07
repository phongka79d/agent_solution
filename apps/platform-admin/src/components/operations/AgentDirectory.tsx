/**
 * Dynamic agent directory derived purely from returned R16 run records.
 * Never invents agent identities, fake metrics, or phantom status rows.
 */

import { useMemo } from 'react';
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

      if (run.started_at && (!existing.lastActive || run.started_at > existing.lastActive)) {
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
      aria-label="Observed run actors"
      className="platform-card p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Observed run actors</h2>
          <span className="rounded-[var(--radius-badge)] bg-surface-low px-2 py-0.5 text-xs font-mono text-muted">
            {directory.length} observed
          </span>
        </div>
        {selectedAgentId && (
          <button
            type="button"
            onClick={() => onSelectAgent('')}
            className="text-xs text-brand hover:text-brand-deep focus-visible:outline-none focus-visible:underline"
          >
            Clear Filter ({selectedAgentId})
          </button>
        )}
      </div>

      {directory.length === 0 ? (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-xs text-muted">
          No agent identities observed in the currently returned run dataset.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {directory.map((agent) => {
            const isSelected = selectedAgentId === agent.agent_id;
            const successRate =
              agent.totalRuns > 0
                ? Math.round((agent.successCount / agent.totalRuns) * 100)
                : 0;

            return (
              <button
                key={agent.agent_id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectAgent(isSelected ? '' : agent.agent_id)}
                className={`w-full cursor-pointer rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  isSelected
                    ? 'border-brand bg-brand-soft text-ink shadow-sm'
                    : 'border-line bg-surface-low text-ink-body hover:border-line-strong hover:bg-surface'
                }`}
              >
                <div className="flex items-center justify-between gap-1 mb-2">
                  <span className="truncate font-mono text-xs font-semibold text-brand">
                    {agent.agent_id}
                  </span>
                  {agent.runningCount > 0 ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-success">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                      {agent.runningCount} busy
                    </span>
                  ) : agent.failedCount > 0 ? (
                    <span className="font-mono text-[10px] text-danger">
                      {agent.failedCount} failed
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-muted">idle</span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-1 font-mono text-[11px] text-muted">
                  <div>
                    <span className="block text-[10px] uppercase text-muted">Runs</span>
                    <span className="text-ink">{agent.totalRuns}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase text-muted">Pass</span>
                    <span className={successRate === 100 ? 'text-success' : 'text-ink'}>
                      {successRate}%
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] uppercase text-muted">Lat</span>
                    <span className="text-ink">
                      {agent.avgLatencyMs !== null ? `${agent.avgLatencyMs}ms` : '-'}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

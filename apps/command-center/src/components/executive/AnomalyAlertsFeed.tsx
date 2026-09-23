/**
 * @file apps/command-center/src/components/executive/AnomalyAlertsFeed.tsx
 * Displays operational anomaly and alert events (SCR-001 Indicator #10).
 * Never fabricates synthetic anomaly rows when no alerts are returned.
 */

'use client';

import React from 'react';
import type { AnomalyAlert } from './types';

export function AnomalyAlertsFeed({
  alerts = [],
}: {
  readonly alerts?: readonly AnomalyAlert[];
}) {
  const getSeverityStyle = (severity: AnomalyAlert['severity']) => {
    switch (severity) {
      case 'CRITICAL':
        return 'bg-rose-950/80 text-rose-300 border-rose-800';
      case 'WARN':
        return 'bg-amber-950/80 text-amber-300 border-amber-800';
      case 'INFO':
        return 'bg-sky-950/80 text-sky-300 border-sky-800';
      default:
        return 'bg-slate-800 text-slate-300 border-slate-700';
    }
  };

  return (
    <div className="w-full bg-slate-900 border border-slate-800 rounded-lg p-5 mb-6">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Operational Anomalies & Critical Alerts
          </h3>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">
            Indicator #10 &bull; Automated Telemetry Monitors
          </p>
        </div>
        <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
          {alerts.length} Events
        </span>
      </div>

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-28 text-slate-500 border border-dashed border-slate-800/80 rounded-lg p-4">
          <span className="text-xs font-mono text-slate-400">
            Upstream anomaly data unavailable / not instrumented
          </span>
          <span className="text-[11px] text-slate-600 mt-0.5">
            Telemetry anomaly detection is not instrumented or unavailable for this window.
          </span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`p-3 rounded border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 ${getSeverityStyle(
                alert.severity
              )}`}
            >
              <div className="flex items-start gap-2.5">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider bg-slate-950/60 border border-current">
                  {alert.severity}
                </span>
                <div>
                  <div className="text-xs font-medium text-slate-200">{alert.message}</div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                    Source: {alert.source}
                    {alert.evidence_reference && ` | Evidence: ${alert.evidence_reference}`}
                  </div>
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap self-end sm:self-center">
                {alert.timestamp}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Displays operational anomaly and alert events (SCR-001 Indicator #10).
 * Never fabricates synthetic anomaly rows when no alerts are returned.
 */

'use client';

import type { AnomalyAlert } from './types';

export function AnomalyAlertsFeed({
  alerts = [],
}: {
  readonly alerts?: readonly AnomalyAlert[];
}) {
  const getSeverityStyle = (severity: AnomalyAlert['severity']) => {
    switch (severity) {
      case 'CRITICAL':
        return 'bg-danger-bg text-danger border-danger-border';
      case 'WARN':
        return 'bg-warning-bg text-warning border-warning-border';
      case 'INFO':
        return 'bg-info-bg text-info border-info-border';
      default:
        return 'bg-neutral-bg text-muted border-neutral-border';
    }
  };

  return (
    <div className="mb-6 w-full rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            Operational Anomalies & Critical Alerts
          </h3>
          <p className="mt-0.5 text-xs font-mono text-muted">
            Indicator #10 &bull; Automated Telemetry Monitors
          </p>
        </div>
        <span className="rounded border border-neutral-border bg-neutral-bg px-2 py-0.5 text-xs font-mono text-muted">
          {alerts.length} Events
        </span>
      </div>

      {alerts.length === 0 ? (
        <div className="flex h-28 flex-col items-center justify-center rounded-lg border border-dashed border-line p-4 text-muted">
          <span className="text-xs font-mono text-muted">
            Upstream anomaly data unavailable / not instrumented
          </span>
          <span className="mt-0.5 text-[11px] text-muted">
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
                <span className="rounded border border-current bg-surface-low px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider">
                  {alert.severity}
                </span>
                <div>
                  <div className="text-xs font-medium text-ink-body">{alert.message}</div>
                  <div className="mt-0.5 text-[11px] font-mono text-muted">
                    Source: {alert.source}
                    {alert.evidence_reference && ` | Evidence: ${alert.evidence_reference}`}
                  </div>
                </div>
              </div>
              <span className="self-end whitespace-nowrap text-[11px] font-mono text-muted sm:self-center">
                {alert.timestamp}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

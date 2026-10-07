/**
 * Control bar for SCR-005: operator takeover mutex, AI outbound silencer, and resume command.
 * Strictly reflects lease state from the contracted conversation routes.
 */
'use client';

import type { TakeoverLeaseState } from './types';

export interface TakeoverControlsProps {
  readonly isTakenOver: boolean;
  readonly leaseState: TakeoverLeaseState;
  readonly leaseExpiresAt: string | null;
  readonly lastHeartbeatAt?: string | null;
  readonly errorMessage: string | null;
  readonly onTakeover: () => Promise<void> | void;
  readonly onResume: () => Promise<void> | void;
  readonly onOpenEvaluation: () => void;
  readonly onClearError: () => void;
  readonly disabled?: boolean;
}

export function TakeoverControls({
  isTakenOver,
  leaseState,
  leaseExpiresAt,
  lastHeartbeatAt,
  errorMessage,
  onTakeover,
  onResume,
  onOpenEvaluation,
  onClearError,
  disabled = false,
}: TakeoverControlsProps) {
  const isAcquiring = leaseState === 'acquiring';
  const isReleasing = leaseState === 'releasing';
  const isConflict = leaseState === 'conflict';
  const isStale = leaseState === 'stale';

  // Format expiry timestamp for display
  const formatTime = (isoString: string | null) => {
    if (!isoString) return null;
    try {
      return new Date(isoString).toLocaleTimeString();
    } catch {
      return isoString;
    }
  };

  return (
    <div className="tenant-takeover-controls">
      <div className="tenant-takeover-controls__body">
        <div className="flex items-center gap-3">
          <span className={`tenant-takeover-controls__dot ${
            isTakenOver
              ? 'tenant-takeover-controls__dot--warning'
              : isAcquiring || isReleasing
              ? 'tenant-takeover-controls__dot--info'
              : isConflict
              ? 'tenant-takeover-controls__dot--danger'
              : isStale
              ? 'tenant-takeover-controls__dot--warning'
              : 'tenant-takeover-controls__dot--success'
          }`} aria-hidden="true" />
          <div className="flex flex-col">
            <span className="font-mono text-sm font-semibold text-ink">
              {isTakenOver ? (
                <span className="font-bold text-warning">Control Mode: HUMAN_TAKEOVER (Autonomous AI Outbound Suppressed)</span>
              ) : isAcquiring ? (
                <span className="text-info">Control Mode: HANDOVER_REQUESTED (Acquiring Mutex Lease...)</span>
              ) : isReleasing ? (
                <span className="text-info">Control Mode: RESUME_AUDIT (Re-validating & Releasing...)</span>
              ) : isConflict ? (
                <span className="text-danger">Control Mode: LEASE_CONFLICT (409 Locked by Another Operator)</span>
              ) : isStale ? (
                <span className="text-warning">Control Mode: LEASE_STALE (Heartbeat Lapsed, AI Active)</span>
              ) : (
                <span className="text-success">Control Mode: AI_CONTROLLED (= ACTIVE)</span>
              )}
            </span>
            {isTakenOver && leaseExpiresAt ? (
              <span className="mt-0.5 font-mono text-xs text-muted">
                Lease active (renews every 30s) · Expires: {formatTime(leaseExpiresAt)}
                {lastHeartbeatAt && ` · Last heartbeat: ${formatTime(lastHeartbeatAt)}`}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isTakenOver ? (
            <>
              <button type="button" onClick={onOpenEvaluation} className="ui-button ui-button--secondary ui-button--sm" title="Rate dialogue quality per SCR-005 (renders explicit unavailable state)">
                Rate Dialogue
              </button>
              <button type="button" onClick={onResume} disabled={isReleasing} className="ui-button ui-button--primary ui-button--sm">
                {isReleasing ? 'Resuming Agent...' : 'Resume AI Control'}
              </button>
            </>
          ) : (
            <button type="button" onClick={onTakeover} disabled={disabled || isAcquiring} className="ui-button ui-button--primary ui-button--sm">
              {isAcquiring ? 'Acquiring Mutex...' : 'Take Over Session'}
            </button>
          )}
        </div>
      </div>

      {(errorMessage || isConflict || isStale) ? (
        <div className={`tenant-takeover-controls__notice ${isConflict ? 'tenant-notice--danger' : 'tenant-notice--warning'}`}>
          <div className="flex items-center gap-2">
            <span className="tenant-summary-badge">
              {isConflict ? 'Lease Conflict (409)' : isStale ? 'Lease Stale' : 'Takeover Notice'}
            </span>
            <span>{errorMessage || (isConflict ? 'Another operator currently holds the lease. Autonomous AI remains active.' : 'Takeover lease expired or lost to heartbeat failure. Control returned to agent.')}</span>
          </div>
          <button type="button" onClick={onClearError} className="ui-focus-ring text-sm underline hover:no-underline">
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

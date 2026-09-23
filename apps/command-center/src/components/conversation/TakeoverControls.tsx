/**
 * @file apps/command-center/src/components/conversation/TakeoverControls.tsx
 * Control bar for SCR-005: Operator takeover mutex, AI outbound silencer, resume command.
 * Strictly reflects state per implement/07-human-command-center-ui.md §6.2.
 */
'use client';

import React from 'react';
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
    <div className="bg-slate-900 border-b border-slate-800">
      <div className="p-3 sm:p-4 flex flex-wrap justify-between items-center gap-3">
        {/* State Indicator */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-3 h-3">
            {isTakenOver ? (
              <>
                <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
              </>
            ) : isAcquiring || isReleasing ? (
              <>
                <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500" />
              </>
            ) : isConflict ? (
              <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
            ) : isStale ? (
              <span className="relative inline-flex rounded-full h-3 w-3 bg-orange-500" />
            ) : (
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            )}
          </div>

          <div className="flex flex-col">
            <span className="text-xs font-mono font-semibold text-slate-200">
              {isTakenOver ? (
                <span className="text-amber-400 font-bold">
                  Control Mode: HUMAN_TAKEOVER (Autonomous AI Outbound Suppressed)
                </span>
              ) : isAcquiring ? (
                <span className="text-sky-400">
                  Control Mode: HANDOVER_REQUESTED (Acquiring Mutex Lease...)
                </span>
              ) : isReleasing ? (
                <span className="text-sky-400">
                  Control Mode: RESUME_AUDIT (Re-validating & Releasing...)
                </span>
              ) : isConflict ? (
                <span className="text-rose-400">
                  Control Mode: LEASE_CONFLICT (409 Locked by Another Operator)
                </span>
              ) : isStale ? (
                <span className="text-orange-400">
                  Control Mode: LEASE_STALE (Heartbeat Lapsed, AI Active)
                </span>
              ) : (
                <span className="text-emerald-400">
                  Control Mode: AI_CONTROLLED (= ACTIVE)
                </span>
              )}
            </span>

            {isTakenOver && leaseExpiresAt && (
              <span className="text-[10px] font-mono text-slate-400 mt-0.5">
                Lease active (renews every 30s) · Expires: {formatTime(leaseExpiresAt)}
                {lastHeartbeatAt && ` · Last heartbeat: ${formatTime(lastHeartbeatAt)}`}
              </span>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {isTakenOver ? (
            <>
              <button
                type="button"
                onClick={onOpenEvaluation}
                className="px-3 py-1.5 rounded text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                title="Rate dialogue quality per SCR-005 (renders explicit unavailable state)"
              >
                Rate Dialogue
              </button>
              <button
                type="button"
                onClick={onResume}
                disabled={isReleasing}
                className="px-4 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white shadow-sm transition-colors"
              >
                {isReleasing ? 'Resuming Agent...' : 'Resume AI Control'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onTakeover}
              disabled={disabled || isAcquiring}
              className="px-4 py-1.5 rounded text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-500 text-white shadow-sm transition-colors"
            >
              {isAcquiring ? 'Acquiring Mutex...' : 'Take Over Session'}
            </button>
          )}
        </div>
      </div>

      {/* Explicit Lease Conflict / Stale / Error Banner */}
      {(errorMessage || isConflict || isStale) && (
        <div
          className={`px-4 py-2 border-t text-xs flex justify-between items-center ${
            isConflict
              ? 'bg-rose-950/70 border-rose-800/80 text-rose-200'
              : isStale
              ? 'bg-amber-950/70 border-amber-800/80 text-amber-200'
              : 'bg-red-950/70 border-red-800/80 text-red-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-black/40 border border-current">
              {isConflict ? 'Lease Conflict (409)' : isStale ? 'Lease Stale' : 'Takeover Notice'}
            </span>
            <span>
              {errorMessage ||
                (isConflict
                  ? 'Another operator currently holds the lease. Autonomous AI remains active.'
                  : 'Takeover lease expired or lost to heartbeat failure. Control returned to agent.')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClearError}
            className="text-[11px] underline hover:no-underline ml-4 text-slate-400 hover:text-slate-200"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

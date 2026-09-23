/**
 * @file apps/command-center/src/components/executive/RevenueAttributionChart.tsx
 * Real-time revenue attribution streaming component (SCR-001).
 * Subscribes to R09 SSE stream (/api/v1/telemetry/stream?metric=revenue_attribution).
 * Enforces event-id de-duplication, named event listeners, bounded exponential reconnect,
 * and stale/unavailable markers. Never invents mock or default chart data.
 */

'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiClient } from '../../lib/api-client';
import type { AttributionPoint, SseConnectionStatus } from './types';

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_DATA_POINTS = 48;

type TimeoutHandle = ReturnType<typeof setTimeout> extends number ? number : NodeJS.Timeout;

function parseAttributionPoint(data: unknown): AttributionPoint | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // Strictly require existing time string and numeric baseline & aiAttributed
  if (
    typeof obj.time !== 'string' ||
    typeof obj.baseline !== 'number' ||
    typeof obj.aiAttributed !== 'number' ||
    Number.isNaN(obj.baseline) ||
    Number.isNaN(obj.aiAttributed)
  ) {
    return null;
  }

  return {
    time: obj.time,
    baseline: obj.baseline,
    aiAttributed: obj.aiAttributed,
    id: typeof obj.id === 'string' ? obj.id : undefined,
  };
}

export function RevenueAttributionChart({
  initialData = [],
}: {
  readonly initialData?: readonly AttributionPoint[];
}) {
  const [dataPoints, setDataPoints] = useState<readonly AttributionPoint[]>(initialData);
  const [connectionStatus, setConnectionStatus] = useState<SseConnectionStatus>('CONNECTING');
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [lastObservedAt, setLastObservedAt] = useState<string | null>(null);
  const [streamErrorMessage, setStreamErrorMessage] = useState<string | null>(null);

  const seenEventIds = useRef<Set<string>>(new Set());
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<TimeoutHandle | null>(null);
  const retryCountRef = useRef<number>(0);

  const cleanupStream = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const handleIncomingFrame = useCallback((event: MessageEvent<string>) => {
    const eventId = event.lastEventId || '';
    if (eventId) {
      if (seenEventIds.current.has(eventId)) {
        return;
      }
      seenEventIds.current.add(eventId);
      if (seenEventIds.current.size > 500) {
        const firstSeen = seenEventIds.current.values().next().value;
        if (firstSeen !== undefined) seenEventIds.current.delete(firstSeen);
      }
    }

    try {
      const payload: unknown = JSON.parse(event.data);
      const point = parseAttributionPoint(payload);
      if (point !== null) {
        setDataPoints((prev) => [...prev.slice(-(MAX_DATA_POINTS - 1)), point]);
        setLastObservedAt(point.time);
      }
    } catch {
      // Discard invalid JSON frames without inventing substitute data
    }
  }, []);

  const handleStreamError = useCallback((event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      if (typeof payload.message === 'string') {
        setStreamErrorMessage(payload.message);
      }
    } catch {
      // Ignore unparseable error frame
    }
    setConnectionStatus('UNAVAILABLE');
  }, []);

  const connectStream = useCallback(() => {
    cleanupStream();

    const streamUrl = apiClient.getTelemetryStreamUrl({ metric: 'revenue_attribution' });
    const es = new EventSource(streamUrl);
    eventSourceRef.current = es;
    setConnectionStatus(retryCountRef.current > 0 ? 'RECONNECTING' : 'CONNECTING');
    setStreamErrorMessage(null);

    es.onopen = () => {
      setConnectionStatus('LIVE');
      retryCountRef.current = 0;
      setReconnectAttempt(0);
      setStreamErrorMessage(null);
    };

    // Named SSE listeners per 06 §8.1.2 R09 and 07 §10
    es.addEventListener('telemetry.snapshot', handleIncomingFrame);
    es.addEventListener('revenue_attribution', handleIncomingFrame);
    es.addEventListener('stream.error', handleStreamError);
    es.onmessage = handleIncomingFrame;

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      if (retryCountRef.current < MAX_RECONNECT_ATTEMPTS) {
        retryCountRef.current += 1;
        setReconnectAttempt(retryCountRef.current);
        setConnectionStatus('RECONNECTING');

        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, retryCountRef.current - 1),
          30000
        );

        reconnectTimerRef.current = setTimeout(() => {
          connectStream();
        }, delay) as TimeoutHandle;
      } else {
        setConnectionStatus('UNAVAILABLE');
      }
    };
  }, [cleanupStream, handleIncomingFrame, handleStreamError]);

  useEffect(() => {
    connectStream();
    return () => cleanupStream();
  }, [connectStream, cleanupStream]);

  const statusBadge = connectionStatus === 'LIVE' ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      STREAM LIVE
    </span>
  ) : connectionStatus === 'RECONNECTING' ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-800">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
      RECONNECTING ({reconnectAttempt}/{MAX_RECONNECT_ATTEMPTS})
    </span>
  ) : connectionStatus === 'UNAVAILABLE' ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-rose-950 text-rose-300 border border-rose-800">
      STREAM UNAVAILABLE
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700">
      {connectionStatus}
    </span>
  );

  return (
    <div className="w-full bg-slate-900 border border-slate-800 rounded-lg p-5 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4 pb-3 border-b border-slate-800/80">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Real-Time Revenue Attribution (Organic Baseline vs AI Attributed)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">
            R09 SSE Stream &bull; metric=revenue_attribution
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastObservedAt && (
            <span className="text-[11px] font-mono text-slate-500">
              Last Frame: {lastObservedAt}
            </span>
          )}
          {statusBadge}
          {connectionStatus === 'UNAVAILABLE' && (
            <button
              type="button"
              onClick={() => {
                retryCountRef.current = 0;
                setReconnectAttempt(0);
                connectStream();
              }}
              className="px-2 py-0.5 text-[10px] font-medium rounded bg-slate-800 text-sky-400 border border-slate-700 hover:bg-slate-700"
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      {streamErrorMessage && (
        <div className="mb-4 p-2.5 rounded bg-rose-950/50 border border-rose-800/60 text-xs font-mono text-rose-300">
          Stream Notice: {streamErrorMessage}
        </div>
      )}

      {dataPoints.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-slate-500 border border-dashed border-slate-800/80 rounded-lg p-6">
          <span className="text-xs font-mono font-medium text-slate-400 mb-1">
            Awaiting streaming attribution telemetry
          </span>
          <p className="text-[11px] text-slate-500 max-w-md text-center">
            {connectionStatus === 'UNAVAILABLE'
              ? 'Telemetry stream is unavailable. No data points were recorded.'
              : 'No revenue attribution events received yet for the current window. Incoming stream events will be charted here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-end gap-4 text-xs font-mono text-slate-400 mb-2">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-sky-500" /> Organic Baseline
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> AI Attributed
            </span>
          </div>
          <div className="h-44 w-full flex items-end gap-1 pt-4 pb-2 px-1 bg-slate-950/60 rounded border border-slate-800/60 overflow-x-auto">
            {dataPoints.map((pt, idx) => {
              const maxVal = Math.max(...dataPoints.map((d) => d.baseline + d.aiAttributed), 1);
              const baselinePct = Math.min(100, Math.round((pt.baseline / maxVal) * 100));
              const aiPct = Math.min(100, Math.round((pt.aiAttributed / maxVal) * 100));
              return (
                <div
                  key={pt.id ?? idx}
                  className="flex-1 min-w-[12px] max-w-[28px] flex flex-col justify-end items-center h-full group relative"
                >
                  <div
                    style={{ height: `${aiPct}%` }}
                    className="w-full bg-emerald-500/80 rounded-t-sm transition-all"
                  />
                  <div
                    style={{ height: `${baselinePct}%` }}
                    className="w-full bg-sky-600/70 transition-all"
                  />
                  <div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-1 z-10 pointer-events-none p-1.5 bg-slate-900 border border-slate-700 text-[10px] font-mono text-slate-200 rounded shadow-lg whitespace-nowrap">
                    <div>Time: {pt.time}</div>
                    <div className="text-sky-300">Baseline: NT$ {pt.baseline.toLocaleString()}</div>
                    <div className="text-emerald-300">AI: NT$ {pt.aiAttributed.toLocaleString()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

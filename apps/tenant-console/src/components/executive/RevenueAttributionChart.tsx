/**
 * Real-time revenue attribution streaming component (SCR-001).
 * Subscribes to the existing R09 SSE stream and never invents mock chart data.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
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
    ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
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

    const streamUrl = tenantConsoleClient.getTelemetryStreamUrl({ metric: 'revenue_attribution' });
    const es = new EventSource(streamUrl, { withCredentials: true });
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
    <span className="inline-flex items-center gap-1.5 rounded border border-success-border bg-success-bg px-2 py-0.5 text-[10px] font-mono text-success">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
      STREAM LIVE
    </span>
  ) : connectionStatus === 'RECONNECTING' ? (
    <span className="inline-flex items-center gap-1.5 rounded border border-warning-border bg-warning-bg px-2 py-0.5 text-[10px] font-mono text-warning">
      <span className="h-1.5 w-1.5 animate-ping rounded-full bg-warning" />
      RECONNECTING ({reconnectAttempt}/{MAX_RECONNECT_ATTEMPTS})
    </span>
  ) : connectionStatus === 'UNAVAILABLE' ? (
    <span className="inline-flex items-center gap-1.5 rounded border border-danger-border bg-danger-bg px-2 py-0.5 text-[10px] font-mono text-danger">
      STREAM UNAVAILABLE
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded border border-neutral-border bg-neutral-bg px-2 py-0.5 text-[10px] font-mono text-muted">
      {connectionStatus}
    </span>
  );

  return (
    <div className="mb-6 w-full rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex flex-col gap-2 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            Real-Time Revenue Attribution (Organic Baseline vs AI Attributed)
          </h3>
          <p className="mt-0.5 text-xs font-mono text-muted">
            R09 SSE Stream &bull; metric=revenue_attribution
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastObservedAt && (
            <span className="text-[11px] font-mono text-muted">
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
              className="ui-button ui-button--secondary rounded px-2 py-0.5 text-[10px] font-medium text-info"
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      {streamErrorMessage && (
        <div className="mb-4 rounded border border-danger-border bg-danger-bg p-2.5 text-xs font-mono text-danger">
          Stream Notice: {streamErrorMessage}
        </div>
      )}

      {dataPoints.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed border-line p-6 text-muted">
          <span className="mb-1 text-xs font-mono font-medium text-muted">
            Awaiting streaming attribution telemetry
          </span>
          <p className="max-w-md text-center text-[11px] text-muted">
            {connectionStatus === 'UNAVAILABLE'
              ? 'Telemetry stream is unavailable. No data points were recorded.'
              : 'No revenue attribution events received yet for the current window. Incoming stream events will be charted here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="mb-2 flex items-center justify-end gap-4 text-xs font-mono text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-info" /> Organic Baseline
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-success" /> AI Attributed
            </span>
          </div>
          <div className="flex h-44 w-full items-end gap-1 overflow-x-auto rounded border border-line bg-surface-low px-1 pb-2 pt-4">
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
                    className="w-full rounded-t-sm bg-success transition-all"
                  />
                  <div
                    style={{ height: `${baselinePct}%` }}
                    className="w-full bg-info transition-all"
                  />
                  <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded border border-line bg-ink p-1.5 text-[10px] font-mono text-primary-ink opacity-0 shadow-lg group-hover:opacity-100">
                    <div>Time: {pt.time}</div>
                    <div className="text-info">Baseline: NT$ {pt.baseline.toLocaleString()}</div>
                    <div className="text-success">AI: NT$ {pt.aiAttributed.toLocaleString()}</div>
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

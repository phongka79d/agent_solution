'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../http-client.js';
import { describeApiError, type ApiErrorView } from '../errors.js';
import type { ApiErrorEnvelope } from '../types/common.js';

/** Injectable for tests and for BFF-relative transports; defaults to the browser `fetch`. */
export type UseApiFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface UseApiRetryPolicy {
  /** Total attempts after the first failure (0 disables retries). */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface UseApiOptions<T> {
  readonly enabled?: boolean;
  /** Visible-tab polling interval in ms; 0 disables polling. */
  readonly pollMs?: number;
  readonly headers?: Record<string, string>;
  readonly fetcher?: UseApiFetcher;
  readonly retry?: UseApiRetryPolicy;
  /** Defaults to a hard navigation to the sign-in route. */
  readonly onUnauthorized?: () => void;
  readonly redirectTo?: string;
  readonly select?: (body: unknown) => T;
}

export interface UseApiResult<T> {
  readonly data: T | null;
  readonly error: ApiErrorView | null;
  readonly loading: boolean;
  /** True while a background poll/refresh is in flight and stale data is still shown. */
  readonly validating: boolean;
  readonly lastUpdatedAt: string | null;
  readonly refresh: () => void;
}

const DEFAULT_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 4_000;

interface WireErrorBody {
  readonly error_code?: unknown;
  readonly message?: unknown;
  readonly retryable?: unknown;
  readonly correlation_id?: unknown;
  readonly details?: unknown;
}

async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ApiErrorEnvelope = {
    error_code: `HTTP_${response.status}`,
    message: response.statusText || `HTTP ${response.status}`,
    retryable: response.status >= 500 || response.status === 429,
    correlation_id: response.headers.get('x-correlation-id') ?? '',
  };
  try {
    const body = (await response.json()) as WireErrorBody | null;
    if (body !== null && typeof body === 'object' && typeof body.error_code === 'string') {
      envelope = {
        error_code: body.error_code,
        message: typeof body.message === 'string' ? body.message : envelope.message,
        retryable: typeof body.retryable === 'boolean' ? body.retryable : envelope.retryable,
        correlation_id:
          typeof body.correlation_id === 'string'
            ? body.correlation_id
            : response.headers.get('x-correlation-id') ?? '',
        details: body.details,
      };
    }
  } catch {
    // Non-JSON error bodies keep the status-derived envelope.
  }
  return new ApiError(response.status, envelope);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * SWR-like reader with ETag revalidation, bounded retry for RETRYABLE codes and a 401 redirect.
 * UNKNOWN effects are never retried — the descriptor forbids it (`retryable: false`).
 */
export function useApi<T>(url: string | null, options: UseApiOptions<T> = {}): UseApiResult<T> {
  const { enabled = true, pollMs = 0 } = options;

  const [state, setState] = useState<{ data: T | null; error: ApiErrorView | null; loading: boolean; validating: boolean; lastUpdatedAt: string | null }>({
    data: null,
    error: null,
    loading: url !== null && enabled,
    validating: false,
    lastUpdatedAt: null,
  });

  // Options live in refs so an inline options object cannot restart the request effect each render.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const etagRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (url === null) return;
    const current = optionsRef.current;
    const doFetch = current.fetcher ?? ((input: string, init: RequestInit) => fetch(input, init));
    const attempts = Math.max(0, current.retry?.attempts ?? DEFAULT_ATTEMPTS);
    const baseDelay = current.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelay = current.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

    setState((previous) =>
      loadedRef.current ? { ...previous, validating: true } : { ...previous, loading: true, error: null },
    );

    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const requestHeaders: Record<string, string> = { Accept: 'application/json', ...current.headers };
        if (etagRef.current !== null) requestHeaders['If-None-Match'] = etagRef.current;
        const response = await doFetch(url, { headers: requestHeaders, signal });

        if (response.status === 304) {
          loadedRef.current = true;
          if (mountedRef.current) {
            setState((previous) => ({
              ...previous,
              loading: false,
              validating: false,
              error: null,
              lastUpdatedAt: new Date().toISOString(),
            }));
          }
          return;
        }

        if (response.status === 401) {
          loadedRef.current = true;
          abortRef.current?.abort();
          if (mountedRef.current) {
            setState((previous) => ({
              ...previous,
              loading: false,
              validating: false,
              error: describeApiError(
                new ApiError(401, {
                  error_code: 'SESSION_EXPIRED',
                  message: 'Session expired',
                  retryable: false,
                  correlation_id: response.headers.get('x-correlation-id') ?? '',
                }),
              ),
            }));
          }
          if (current.onUnauthorized) current.onUnauthorized();
          else if (typeof window !== 'undefined') window.location.assign(current.redirectTo ?? '/sign-in');
          return;
        }

        if (!response.ok) throw await toApiError(response);

        const etag = response.headers.get('etag');
        etagRef.current = etag ?? etagRef.current;
        const body: unknown = await response.json();
        const next = current.select ? current.select(body) : (body as T);
        loadedRef.current = true;
        if (mountedRef.current) {
          setState({
            data: next,
            error: null,
            loading: false,
            validating: false,
            lastUpdatedAt: new Date().toISOString(),
          });
        }
        return;
      } catch (caught) {
        if (typeof caught === 'object' && caught !== null && 'name' in caught && caught.name === 'AbortError') {
          return;
        }
        const view = describeApiError(caught);
        if (!view.retryable || attempt >= attempts) {
          loadedRef.current = true;
          if (mountedRef.current) {
            setState((previous) => ({ ...previous, loading: false, validating: false, error: view }));
          }
          return;
        }
        await delay(Math.min(maxDelay, baseDelay * 2 ** attempt), signal);
      }
    }
  }, [url]);

  const run = useCallback((): void => {
    if (url === null || !enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);
  }, [url, enabled, load]);

  useEffect(() => {
    if (url === null || !enabled) {
      setState((previous) => ({ ...previous, loading: false, validating: false }));
      return undefined;
    }
    run();
    return () => abortRef.current?.abort();
  }, [url, enabled, run]);

  useEffect(() => {
    if (url === null || !enabled || pollMs <= 0 || typeof document === 'undefined') return undefined;
    const tick = (): void => {
      if (document.visibilityState === 'visible') run();
    };
    const interval = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [url, enabled, pollMs, run]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    validating: state.validating,
    lastUpdatedAt: state.lastUpdatedAt,
    refresh: run,
  };
}

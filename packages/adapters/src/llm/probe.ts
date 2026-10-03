export interface ProbeLlmProviderInput {
  readonly base_url: string;
  readonly api_key: string;
  readonly model: string;
  /** Provider URL policy belongs to the host so this adapter stays independent of core-engine. */
  readonly assertSafeProviderUrl: (value: string) => void;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}


export interface ProbeLlmProviderResult {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

function failure(error_class: string, latency_ms: number, http_status: number | null = null): ProbeLlmProviderResult {
  return { outcome: 'FAIL', latency_ms, http_status, error_class };
}
/** Performs a bounded, body-free OpenAI-compatible provider health check. */
export async function probeLlmProvider(input: ProbeLlmProviderInput): Promise<ProbeLlmProviderResult> {
  const started = performance.now();
  const latency = (): number => Math.max(0, Math.round(performance.now() - started));
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || input.api_key.trim().length === 0 || input.model.trim().length === 0) {
    return failure('INVALID_INPUT', latency());
  }
  try {
    input.assertSafeProviderUrl(input.base_url);
  } catch (error) {
    const code = error instanceof TypeError && error.message.includes('LLM_PROVIDER_URL_UNSAFE')
      ? 'URL_UNSAFE'
      : 'URL_INVALID';
    return failure(code, latency());
  }

  const base = input.base_url.replace(/\/+$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = async (path: string, init: RequestInit): Promise<Response> => fetchImpl(`${base}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${input.api_key}`,
      ...init.headers,
    },
    signal: controller.signal,
  });
  const finish = (response: Response): ProbeLlmProviderResult => {
    void response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300
      ? { outcome: 'PASS', latency_ms: latency(), http_status: response.status, error_class: null }
      : failure(`HTTP_${response.status}`, latency(), response.status);
  };

  try {
    const listing = await request('/models', { method: 'GET' });
    if (listing.status !== 404 && listing.status !== 405) return finish(listing);
    void listing.body?.cancel().catch(() => undefined);
    const completion = await request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    return finish(completion);
  } catch (error) {
    const timedOut = controller.signal.aborted
      || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
    return failure(timedOut ? 'TIMEOUT' : error instanceof TypeError ? 'NETWORK_ERROR' : 'PROBE_ERROR', latency());
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MODEL_LENGTH = 256;
const MAX_RUN_ID_LENGTH = 128;
const MAX_MESSAGE_BYTES = 256 * 1024;

export type OpenAICompatibleRole = 'system' | 'developer' | 'user' | 'assistant';

export interface OpenAICompatibleMessage {
  readonly role: OpenAICompatibleRole;
  readonly content: string;
}

export interface OpenAICompatibleUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}

export interface OpenAICompatibleResult<T> {
  readonly value: T;
  readonly usage: OpenAICompatibleUsage | null;
  readonly latency_ms: number;
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly request_id: string | null;
}

export type OpenAICompatibleErrorCode =
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'LLM_CANCELLED'
  | 'LLM_INVALID_RESPONSE';

export class OpenAICompatibleLLMError extends Error {
  readonly code: OpenAICompatibleErrorCode;
  readonly status: number | null;

  constructor(code: OpenAICompatibleErrorCode, status: number | null = null) {
    super(code);
    this.name = 'OpenAICompatibleLLMError';
    this.code = code;
    this.status = status;
  }
}

export interface OpenAICompatibleStructuredSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

interface BaseCompletionRequest {
  readonly messages: readonly OpenAICompatibleMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly max_tokens: number;
  readonly run_id: string;
  readonly correlation_id: string;
}

export interface CompleteStructuredRequest<T> extends BaseCompletionRequest {
  readonly validate: (value: unknown) => T;
  readonly schema?: OpenAICompatibleStructuredSchema;
}

export type CompleteTextRequest = BaseCompletionRequest;

export interface OpenAICompatibleLLMAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly maxResponseBytes?: number;
  readonly structuredOutputMode?: 'json_object' | 'json_schema';
  readonly fetchImpl?: typeof fetch;
}

interface ProviderEnvelope {
  readonly id?: unknown;
  readonly choices?: unknown;
  readonly usage?: unknown;
}


class ResponseBodyTooLargeError extends Error {}


function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}.`);
  }
}

function assertBoundedIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_RUN_ID_LENGTH) {
    throw new TypeError(`${field} must be a non-empty bounded string.`);
  }
}

function assertMessages(messages: readonly OpenAICompatibleMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must contain at least one message.');
  }

  let totalBytes = 0;
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('messages contain an unsupported role.');
    }
    const candidate = message as { readonly role?: unknown; readonly content?: unknown };
    if (typeof candidate.role !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(candidate.role)) {
      throw new TypeError('messages contain an unsupported role.');
    }
    if (typeof candidate.content !== 'string') {
      throw new TypeError('messages content must be text.');
    }
    totalBytes += byteLength(candidate.content);
    if (totalBytes > MAX_MESSAGE_BYTES) {
      throw new TypeError('messages exceed the bounded input size.');
    }
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('baseUrl must be an absolute http(s) URL.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('baseUrl must be an absolute http(s) URL without userinfo, query, or fragment.');
  }
  return value.replace(/\/+$/, '');
}

function providerErrorForStatus(status: number): OpenAICompatibleLLMError {
  if (status === 401) return new OpenAICompatibleLLMError('LLM_AUTH_FAILED', status);
  if (status === 429) return new OpenAICompatibleLLMError('LLM_RATE_LIMITED', status);
  if (status >= 500 && status <= 599) return new OpenAICompatibleLLMError('LLM_UNAVAILABLE', status);
  return new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE', status);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new ResponseBodyTooLargeError();
  }

  if (!response.body) {
    const text = await response.text();
    if (byteLength(text) > maxBytes) throw new ResponseBodyTooLargeError();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function extractContent(envelope: ProviderEnvelope): { content: string; requestId: string | null; usage: OpenAICompatibleUsage | null } {
  if (!Array.isArray(envelope.choices) || envelope.choices.length === 0) {
    throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
  }
  const choice = envelope.choices[0];
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice) || !('message' in choice)) {
    throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
  }
  const message = (choice as { readonly message?: unknown }).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
  }
  const content = (message as { readonly content?: unknown }).content;
  if (typeof content !== 'string') {
    throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
  }

  const rawUsage = envelope.usage;
  const usageObject =
    rawUsage !== null && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
      ? (rawUsage as { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown })
      : null;
  const usage =
    usageObject !== null &&
    Number.isSafeInteger(usageObject.prompt_tokens) &&
    Number.isSafeInteger(usageObject.completion_tokens) &&
    Number(usageObject.prompt_tokens) >= 0 &&
    Number(usageObject.completion_tokens) >= 0
      ? {
          prompt_tokens: Number(usageObject.prompt_tokens),
          completion_tokens: Number(usageObject.completion_tokens),
        }
      : null;
  const requestId = typeof envelope.id === 'string' && envelope.id.length > 0 && envelope.id.length <= 256 ? envelope.id : null;
  return { content, requestId, usage };
}

export class OpenAICompatibleLLMAdapter {
  readonly provider = 'openai-compatible' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxResponseBytes: number;
  private readonly structuredOutputMode: 'json_object' | 'json_schema';
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleLLMAdapterOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new TypeError('apiKey is required.');
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    assertPositiveInteger(this.timeoutMs, 'timeoutMs', 86_400_000);
    assertPositiveInteger(this.maxOutputTokens, 'maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS);
    assertPositiveInteger(this.maxResponseBytes, 'maxResponseBytes', 16 * 1024 * 1024);
    this.structuredOutputMode = options.structuredOutputMode ?? 'json_object';
    if (!['json_object', 'json_schema'].includes(this.structuredOutputMode)) {
      throw new TypeError('structuredOutputMode is invalid.');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async completeStructured<T>(request: CompleteStructuredRequest<T>): Promise<OpenAICompatibleResult<T>> {
    const result = await this.complete(request, request.schema ? { type: 'json_schema', json_schema: request.schema } : { type: 'json_object' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
    }
    let value: T;
    try {
      value = request.validate(parsed);
    } catch {
      throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
    }
    return { ...result, value };
  }

  async completeText(request: CompleteTextRequest): Promise<OpenAICompatibleResult<string>> {
    return this.complete(request, undefined);
  }

  private async complete(
    request: BaseCompletionRequest,
    responseFormat: { readonly type: 'json_object' } | { readonly type: 'json_schema'; readonly json_schema: OpenAICompatibleStructuredSchema } | undefined,
  ): Promise<OpenAICompatibleResult<string>> {
    assertMessages(request.messages);
    if (typeof request.model !== 'string' || request.model.trim() === '' || request.model.length > MAX_MODEL_LENGTH) {
      throw new TypeError('model must be a non-empty bounded string.');
    }
    assertPositiveInteger(request.max_tokens, 'max_tokens', this.maxOutputTokens);
    assertBoundedIdentifier(request.run_id, 'run_id');
    assertBoundedIdentifier(request.correlation_id, 'correlation_id');
    if (request.signal?.aborted) throw new OpenAICompatibleLLMError('LLM_CANCELLED');
    if (responseFormat?.type === 'json_schema' && this.structuredOutputMode !== 'json_schema') {
      throw new TypeError('json_schema response mode is not enabled.');
    }
    if (this.structuredOutputMode === 'json_schema' && responseFormat?.type === 'json_object') {
      throw new TypeError('json_schema response mode requires a schema.');
    }

    const messages = request.messages.map(({ role, content }) => ({ role, content }));
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens,
    };
    if (responseFormat) body.response_format = responseFormat;

    const controller = new AbortController();
    let timedOut = false;
    let callerCancelled = false;
    const onCallerAbort = () => {
      callerCancelled = true;
      controller.abort();
    };
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Run-Id': request.run_id,
          'X-Correlation-Id': request.correlation_id,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw providerErrorForStatus(response.status);
      const rawBody = await readResponseBody(response, this.maxResponseBytes);
      let envelope: unknown;
      try {
        envelope = JSON.parse(rawBody);
      } catch {
        throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE', response.status);
      }
      if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE', response.status);
      }
      const extracted = extractContent(envelope as ProviderEnvelope);
      const headerRequestId = response.headers.get('x-request-id');
      return {
        value: extracted.content,
        usage: extracted.usage,
        latency_ms: Math.max(0, Date.now() - startedAt),
        provider: this.provider,
        model: request.model,
        request_id: headerRequestId || extracted.requestId,
      };
    } catch (error) {
      if (error instanceof OpenAICompatibleLLMError) throw error;
      if (callerCancelled || request.signal?.aborted) throw new OpenAICompatibleLLMError('LLM_CANCELLED');
      if (timedOut) throw new OpenAICompatibleLLMError('LLM_TIMEOUT');
      if (error instanceof ResponseBodyTooLargeError) throw new OpenAICompatibleLLMError('LLM_INVALID_RESPONSE');
      throw new OpenAICompatibleLLMError('LLM_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

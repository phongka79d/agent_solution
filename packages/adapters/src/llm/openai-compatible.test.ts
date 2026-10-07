import { describe, expect, it } from 'vitest';

import {
  OpenAICompatibleLLMAdapter,
  OpenAICompatibleLLMError,
} from './openai-compatible.js';

const baseRequest = {
  messages: [{ role: 'user' as const, content: 'Return a JSON object.' }],
  model: 'demo-model',
  max_tokens: 64,
  run_id: 'run-1',
  correlation_id: 'correlation-1',
};

function adapter(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return new OpenAICompatibleLLMAdapter({
    baseUrl: 'https://provider.example/v1/',
    apiKey: 'server-only-test-key',
    fetchImpl,
    ...options,
  });
}

describe('OpenAICompatibleLLMAdapter', () => {
  it('posts only bounded chat-completion fields and validates structured JSON', async () => {
    let observedUrl = '';
    let observedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify({
        id: 'provider-request-1',
        choices: [{ message: { role: 'assistant', content: '{"intent":"sales"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }), { status: 200, headers: { 'x-request-id': 'header-request-1' } });
    };

    const result = await adapter(fetchImpl).completeStructured({
      ...baseRequest,
      validate: (value) => {
        if (typeof value !== 'object' || value === null || !('intent' in value)) throw new Error('invalid');
        return value as { intent: string };
      },
    });

    expect(observedUrl).toBe('https://provider.example/v1/chat/completions');
    const body = JSON.parse(String(observedInit?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'demo-model',
      messages: baseRequest.messages,
      max_tokens: 64,
      response_format: { type: 'json_object' },
    });
    expect((observedInit?.headers as Record<string, string>).Authorization).toBe('Bearer server-only-test-key');
    expect(body.tools).toBeUndefined();
    expect(result.value).toEqual({ intent: 'sales' });
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8 });
    expect(result.provider).toBe('openai-compatible');
    expect(result.request_id).toBe('header-request-1');
  });

  it('supports explicit json-schema mode only when configured', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    };
    const result = await adapter(fetchImpl, { structuredOutputMode: 'json_schema' }).completeStructured({
      ...baseRequest,
      schema: { name: 'result', strict: true, schema: { type: 'object' } },
      validate: (value) => value as { ok: boolean },
    });

    expect(body?.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: { type: 'object' } },
    });
    expect(result.value).toEqual({ ok: true });
  });

  it.each([
    [401, 'LLM_AUTH_FAILED'],
    [429, 'LLM_RATE_LIMITED'],
    [500, 'LLM_UNAVAILABLE'],
  ])('maps provider status %s without exposing the body', async (status, code) => {
    const secretBody = 'provider-secret-response-must-not-leak';
    const fetchImpl: typeof fetch = async () => new Response(secretBody, { status });

    const error = await adapter(fetchImpl).completeText(baseRequest).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(OpenAICompatibleLLMError);
    expect((error as OpenAICompatibleLLMError).code).toBe(code);
    expect(String(error)).not.toContain(secretBody);
  });

  it('maps malformed envelopes, invalid structured output, and oversized bodies', async () => {
    const malformed = adapter(async () => new Response('{not-json', { status: 200 }));
    await expect(malformed.completeText(baseRequest)).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });

    const invalidStructured = adapter(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] })));
    await expect(invalidStructured.completeStructured({
      ...baseRequest,
      validate: (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object required');
        return value;
      },
    })).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });

    const oversized = adapter(async () => new Response('x'.repeat(101)), { maxResponseBytes: 100 });
    await expect(oversized.completeText(baseRequest)).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('maps timeout and caller cancellation distinctly', async () => {
    const hangingFetch: typeof fetch = async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    };

    await expect(adapter(hangingFetch, { timeoutMs: 5 }).completeText(baseRequest)).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });

    const controller = new AbortController();
    const pending = adapter(hangingFetch, { timeoutMs: 1000 }).completeText({ ...baseRequest, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
  });
});

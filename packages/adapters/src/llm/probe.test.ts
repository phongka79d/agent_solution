import { describe, expect, it } from 'vitest';

import { probeLlmProvider } from './probe.js';

const assertSafeProviderUrl = (value: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname === '127.0.0.1' || url.username !== '' || url.password !== '') {
    throw new TypeError('LLM_PROVIDER_URL_UNSAFE');
  }
};

describe('probeLlmProvider', () => {
  it('uses an authenticated models read and returns metadata only', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const result = await probeLlmProvider({
      base_url: 'https://provider.example/v1/',
      api_key: 'private-test-key',
      model: 'model-a',
      assertSafeProviderUrl,
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response('{"data":[{"id":"model-a"}]}', { status: 200 });
      },
    });

    expect(seenUrl).toBe('https://provider.example/v1/models');
    expect(seenInit?.method).toBe('GET');
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer private-test-key');
    expect(result).toMatchObject({ outcome: 'PASS', http_status: 200, error_class: null });
    expect(result.latency_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(result)).not.toContain('private-test-key');
    expect(JSON.stringify(result)).not.toContain('model-a');
  });

  it('falls back to a one-token completion and never returns an error body', async () => {
    let completion: Record<string, unknown> | undefined;
    let call = 0;
    const result = await probeLlmProvider({
      base_url: 'https://provider.example/v1',
      api_key: 'private-test-key',
      model: 'completion-model',
      assertSafeProviderUrl,
      fetchImpl: async (_url, init) => {
        call += 1;
        if (call === 1) return new Response('unavailable', { status: 404 });
        completion = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('body contains private provider details', { status: 401 });
      },
    });

    expect(call).toBe(2);
    expect(completion).toMatchObject({ model: 'completion-model', max_tokens: 1, stream: false });
    expect(result).toMatchObject({ outcome: 'FAIL', http_status: 401, error_class: 'HTTP_401' });
    expect(JSON.stringify(result)).not.toContain('private provider details');
  });

  it('refuses private destinations before calling the injected transport', async () => {
    let called = false;
    const result = await probeLlmProvider({
      base_url: 'https://127.0.0.1/v1',
      api_key: 'private-test-key',
      model: 'model-a',
      assertSafeProviderUrl,
      fetchImpl: async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ outcome: 'FAIL', http_status: null, error_class: 'URL_UNSAFE' });
  });
});

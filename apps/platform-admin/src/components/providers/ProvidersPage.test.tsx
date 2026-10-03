import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@agentos/ui-foundation/i18n';
import { ProvidersPage } from './ProvidersPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

interface ProviderPayload extends Record<string, unknown> {
  readonly provider_id: string;
  readonly is_default: boolean;
  readonly status: string;
}

function provider(overrides: Partial<ProviderPayload> = {}): ProviderPayload {
  return {
    provider_id: 'openai',
    display_name: 'OpenAI',
    base_url: 'https://api.example.test/v1',
    reasoning_model: 'gpt-4o',
    fast_model: 'gpt-4o-mini',
    timeout_ms: 30000,
    structured_mode: 'json_object',
    status: 'CONFIGURED',
    is_default: false,
    secret_configured: true,
    config_version: 'cfg-1',
    updated_at: '2026-09-30T00:00:00.000Z',
    // A hostile payload: the API must never send a key, and the console must never render one.
    api_key: 'sk-stored-secret-value',
    ...overrides,
  };
}

function stubFetch(item: ProviderPayload, extra?: (request: Request) => Response | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(typeof input === 'string' ? `http://localhost${input}` : input, init);
    const handled = extra?.(request);
    if (handled) return handled;
    if (request.method === 'GET' && request.url.endsWith('/api/v1/platform/providers')) {
      return new Response(JSON.stringify({ items: [], providers: [item] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error_code: 'UNEXPECTED' }), { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ProvidersPage', () => {
  it('lists provider status, models and timeout and never renders the stored key', async () => {
    stubFetch(provider({ is_default: true }));
    render(<ProvidersPage />);

    await screen.findByText('OpenAI');
    expect(screen.getByText('gpt-4o')).toBeTruthy();
    expect(screen.getByText('gpt-4o-mini')).toBeTruthy();
    expect(screen.getByText('30000')).toBeTruthy();
    expect(screen.getByText(t('platform.api_key_configured'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-stored-secret-value');
  });

  it('edits a provider with a write-only key that is never displayed', async () => {
    const fetchMock = stubFetch(provider());
    render(<ProvidersPage />);
    await screen.findByText('OpenAI');

    fireEvent.click(screen.getByRole('button', { name: t('platform.edit_provider') }));
    const keyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(keyInput).toBeTruthy();
    fireEvent.change(keyInput, { target: { value: 'sk-briefly-typed-key' } });

    expect(document.body.textContent).toContain(t('platform.api_key_fingerprint'));
    expect(document.body.textContent).toMatch(/#[0-9a-f]{8}/);
    expect(document.body.textContent).not.toContain('sk-briefly-typed-key');
    expect(document.body.textContent).not.toContain('sk-stored-secret-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs a connection probe and shows the observed latency', async () => {
    stubFetch(provider(), (request) => request.method === 'POST' && request.url.endsWith('/test')
      ? new Response(JSON.stringify({ outcome: 'PASS', latency_ms: 42, http_status: 200, error_class: null }), { status: 200 })
      : null);
    render(<ProvidersPage />);
    await screen.findByText('OpenAI');

    fireEvent.click(screen.getByRole('button', { name: t('platform.test_connection') }));
    await screen.findByText(/42 ms/);
    expect(screen.getAllByText(t('platform.probe_pass')).length).toBeGreaterThan(0);
  });

  it('requires a reason before switching the default provider', async () => {
    const fetchMock = stubFetch(provider(), (request) => request.method === 'PUT'
      ? new Response(JSON.stringify(provider({ is_default: true })), { status: 200 })
      : null);
    render(<ProvidersPage />);
    await screen.findByText('OpenAI');

    fireEvent.click(screen.getByRole('button', { name: t('platform.make_default') }));
    const confirm = screen.getByRole('button', { name: t('platform.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(t('platform.reason')), { target: { value: 'sự cố nhà cung cấp cũ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/platform/providers/openai',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toMatchObject({ is_default: true });
  });
});

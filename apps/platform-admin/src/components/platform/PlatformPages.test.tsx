import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompaniesPage } from './Companies';
import { SubscriptionsPage, UsagePage } from './PlatformPages';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('platform empty states', () => {
  it('shows empty Companies state when the directory has no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    render(<CompaniesPage />);
    await waitFor(() => expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy());
  });

  it('shows empty Usage state without usage rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    render(<UsagePage />);
    await waitFor(() => expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy());
  });

  it('marks Subscriptions as not integrated', () => {
    render(<SubscriptionsPage />);
    expect(screen.getByRole('heading', { name: 'Chưa tích hợp' })).toBeTruthy();
  });
});

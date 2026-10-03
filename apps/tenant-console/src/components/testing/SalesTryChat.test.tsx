import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesTryChat } from './SalesTryChat';

const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response());

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('SalesTryChat', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows exactly one Vietnamese error bubble for a forbidden request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error_code: 'FORBIDDEN' }, 403));
    render(<SalesTryChat />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tin nhắn' }), { target: { value: 'Xin tư vấn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    const error = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(error.textContent).toContain('Bạn không có quyền');
    expect(error.textContent).not.toMatch(/FORBIDDEN|Forbidden/);
  });

  it('renders the completed answer with its sources disclosure', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/testing/chat/session')) return jsonResponse({ chat_session_id: 'chat-1', expires_at: '2099-01-01T00:00:00.000Z' });
      if (url.endsWith('/api/testing/chat/turn')) return jsonResponse({ task_id: 'task-1', conversation_id: 'conversation-1' });
      if (url.includes('/api/testing/chat/task?')) return jsonResponse({ task_id: 'task-1', status: 'completed', answer: 'Sản phẩm phù hợp là mẫu A.', sources: [{ label: 'Danh mục sản phẩm' }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<SalesTryChat />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tin nhắn' }), { target: { value: 'Tư vấn giúp tôi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    await screen.findByText('Sản phẩm phù hợp là mẫu A.');
    const whyButton = screen.getByRole('button', { name: 'Vì sao gợi ý này?' });
    expect(whyButton).toBeTruthy();
    expect(whyButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(whyButton);
    expect(screen.getByRole('list', { name: 'Nguồn thông tin' }).textContent).toContain('Danh mục sản phẩm');
  });
});

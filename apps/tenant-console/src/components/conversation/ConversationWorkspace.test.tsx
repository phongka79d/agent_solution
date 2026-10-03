import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/SessionProvider';

const mocks = vi.hoisted(() => ({
  getConversations: vi.fn(),
  getConversationMessages: vi.fn(),
  getConversationSummary: vi.fn(),
  postConversationMessage: vi.fn(),
  heartbeatTakeover: vi.fn(),
  takeoverConversation: vi.fn(),
  resumeConversation: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.replace, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
// The workspace package's public exports resolve to dist/, which is not built in this scoped test.
vi.mock('@agentos/ui-foundation/status', async () => import('../../../../../packages/ui-foundation/src/status-view.js'));
vi.mock('@agentos/ui-foundation/i18n', async () => import('../../../../../packages/ui-foundation/src/i18n/index.js'));
vi.mock('@agentos/ui-foundation/react', async () => import('../../../../../packages/ui-foundation/src/react/index.js'));
vi.mock('@agentos/ui-foundation/data', async () => import('../../../../../packages/ui-foundation/src/data/useApi.js'));

import { ConversationWorkspace } from './ConversationWorkspace';

const session: AuthSession = {
  identity: { user_id: 'operator-1', email: 'operator@example.test', display_name: 'Nguyễn An' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Cửa hàng Một', role: 'operator', scope: 'company' },
  permissions: ['conversation:takeover'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

type Fixture = {
  readonly conversation_id: string;
  readonly customer: { readonly customer_id: string; readonly display_name: string };
  readonly state: string;
  readonly ownership: string;
  readonly owner: Record<string, unknown> | null;
};

const conversations: readonly Fixture[] = [
  {
    conversation_id: 'conv-ai',
    customer: { customer_id: 'customer-ai', display_name: 'Khách Linh' },
    state: 'open',
    ownership: 'AI_ACTIVE',
    owner: null,
  },
  {
    conversation_id: 'conv-needs-human',
    customer: { customer_id: 'customer-needs-human', display_name: 'Khách Hà' },
    state: 'open',
    ownership: 'NEEDS_HUMAN',
    owner: null,
  },
  {
    conversation_id: 'conv-me',
    customer: { customer_id: 'customer-me', display_name: 'Khách An' },
    state: 'open',
    ownership: 'HUMAN_ME',
    owner: { operator_id: 'operator-1', display_name: 'Nguyễn An', lease_expires_at: '2099-01-01T00:00:00.000Z' },
  },
  {
    conversation_id: 'conv-other',
    customer: { customer_id: 'customer-other', display_name: 'Khách Bình' },
    state: 'open',
    ownership: 'HUMAN_OTHER',
    owner: { operator_id: 'operator-2', display_name: 'Trần Bình', lease_expires_at: '2099-01-01T00:00:00.000Z' },
  },
  {
    conversation_id: 'conv-paused',
    customer: { customer_id: 'customer-paused', display_name: 'Khách Mai' },
    state: 'paused_takeover',
    ownership: 'PAUSED_ORPHAN',
    owner: null,
  },
  {
    conversation_id: 'conv-closed',
    customer: { customer_id: 'customer-closed', display_name: 'Khách Thu' },
    state: 'closed',
    ownership: 'CLOSED',
    owner: null,
  },
];

function renderWorkspace(conversationId: string) {
  return render(
    <SessionProvider session={session}>
      <ConversationWorkspace initialConversationId={conversationId} />
    </SessionProvider>,
  );
}

describe('ConversationWorkspace contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConversations.mockResolvedValue({ items: conversations, next_cursor: null });
    mocks.getConversationSummary.mockImplementation(async (conversationId: string) => {
      const conversation = conversations.find((item) => item.conversation_id === conversationId);
      return conversation ? { ...conversation } : {};
    });
    mocks.getConversationMessages.mockResolvedValue({ items: [], next_cursor: null });
    mocks.postConversationMessage.mockResolvedValue({ delivery_status: 'STORED' });
    mocks.heartbeatTakeover.mockResolvedValue({ operator_id: 'operator-1', lease_expires_at: '2099-01-01T00:00:00.000Z' });
    mocks.takeoverConversation.mockResolvedValue({ operator_id: 'operator-1', lease_expires_at: '2099-01-01T00:00:00.000Z' });
    mocks.resumeConversation.mockResolvedValue({ status: 'ACTIVE' });
  });
  afterEach(() => cleanup());

  it('shows the inbox skeleton while the conversation list loads', () => {
    const pending = new Promise<never>(() => {
      // Keep requests unresolved so the loading skeleton remains visible.
    });
    mocks.getConversations.mockReturnValue(pending);

    const { container } = renderWorkspace('');

    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  it('shows a message skeleton while the selected thread loads', async () => {
    const pending = new Promise<never>(() => {
      // Keep the request unresolved so the loading skeleton remains visible.
    });
    mocks.getConversationMessages.mockReturnValue(pending);

    const { container } = renderWorkspace('conv-ai');

    await screen.findByRole('heading', { name: 'Hội thoại' });
    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  const cases: readonly {
    readonly id: string;
    readonly banner: RegExp;
    readonly actions: readonly string[];
    readonly forbidden: readonly string[];
  }[] = [
    { id: 'conv-ai', banner: /AI đang phụ trách/, actions: ['Tiếp quản'], forbidden: ['Trả lại cho AI', 'Nhận xử lý'] },
    { id: 'conv-needs-human', banner: /Khách yêu cầu nhân viên/, actions: ['Nhận xử lý'], forbidden: ['Tiếp quản', 'Trả lại cho AI'] },
    { id: 'conv-me', banner: /Bạn đang phụ trách · còn/, actions: ['Trả lại cho AI'], forbidden: ['Tiếp quản', 'Nhận xử lý'] },
    { id: 'conv-other', banner: /Trần Bình đang phụ trách/, actions: ['Xem'], forbidden: ['Tiếp quản', 'Trả lại cho AI', 'Nhận xử lý'] },
    { id: 'conv-paused', banner: /AI tạm dừng, chưa có nhân viên/, actions: ['Tiếp quản', 'Trả lại cho AI'], forbidden: ['Nhận xử lý'] },
    { id: 'conv-closed', banner: /Đã đóng/, actions: [], forbidden: ['Tiếp quản', 'Trả lại cho AI', 'Nhận xử lý', 'Xem'] },
  ];

  it.each(cases)('renders the $id ownership banner and actions', async ({ id, banner, actions, forbidden }) => {
    renderWorkspace(id);

    const thread = await screen.findByRole('region', { name: 'Luồng hội thoại' });
    await waitFor(() => {
      const banners = within(thread).getAllByRole('status').map((node) => node.textContent ?? '');
      expect(banners.some((value) => banner.test(value))).toBe(true);
    });
    for (const action of actions) {
      expect(within(thread).getByRole('button', { name: action })).toBeTruthy();
    }
    for (const action of forbidden) {
      expect(within(thread).queryByRole('button', { name: action })).toBeNull();
    }
  });

  it('shows the list tabs and filters by ownership', async () => {
    renderWorkspace('conv-ai');
    const list = await screen.findByRole('complementary', { name: 'Danh sách hội thoại' });

    // Default tab surfaces only escalations awaiting a human.
    expect(within(list).getByText('Khách Hà')).toBeTruthy();
    expect(within(list).queryByText('Khách Linh')).toBeNull();

    fireEvent.click(within(list).getByRole('tab', { name: 'Tất cả' }));
    expect(within(list).getByText('Khách Linh')).toBeTruthy();
    expect(within(list).getByText('Khách Thu')).toBeTruthy();

    fireEvent.click(within(list).getByRole('tab', { name: 'AI' }));
    expect(within(list).getByText('Khách Linh')).toBeTruthy();
    expect(within(list).getByText('Khách Mai')).toBeTruthy();
  });

  it('keeps the composer available only for HUMAN_ME and labels a stored reply', async () => {
    renderWorkspace('conv-me');
    const reply = await screen.findByLabelText('Tin nhắn của nhân viên');
    fireEvent.change(reply, { target: { value: 'Tôi sẽ hỗ trợ bạn.' } });
    const form = reply.closest('form');
    if (!form) throw new Error('Reply composer form is missing.');
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText('Đã lưu')).toBeTruthy());
  });

  it('labels a delivered operator reply', async () => {
    mocks.postConversationMessage.mockResolvedValueOnce({ delivery_status: 'DELIVERED' });
    renderWorkspace('conv-me');
    const reply = await screen.findByLabelText('Tin nhắn của nhân viên');
    fireEvent.change(reply, { target: { value: 'Tôi sẽ hỗ trợ bạn.' } });
    const form = reply.closest('form');
    if (!form) throw new Error('Reply composer form is missing.');
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText('Đã gửi')).toBeTruthy());
  });

  it('surfaces a failed reply with a retry action', async () => {
    mocks.postConversationMessage.mockRejectedValueOnce(new Error('network'));
    renderWorkspace('conv-me');
    const reply = await screen.findByLabelText('Tin nhắn của nhân viên');
    fireEvent.change(reply, { target: { value: 'Tôi sẽ hỗ trợ bạn.' } });
    const form = reply.closest('form');
    if (!form) throw new Error('Reply composer form is missing.');
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText('Gửi thất bại')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
  });

  it('opens the takeover popover with reason chips and confirms', async () => {
    renderWorkspace('conv-ai');
    const thread = await screen.findByRole('region', { name: 'Luồng hội thoại' });
    fireEvent.click(within(thread).getByRole('button', { name: 'Tiếp quản' }));
    const dialog = within(thread).getByRole('dialog', { name: 'Xác nhận tiếp quản' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Khách yêu cầu gặp nhân viên' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tiếp quản' }));
    await waitFor(() => expect(mocks.takeoverConversation).toHaveBeenCalledWith('conv-ai', {
      reason: 'Khách yêu cầu gặp nhân viên',
      takeover_mode: 'FULL_CONTROL',
    }));
  });
});

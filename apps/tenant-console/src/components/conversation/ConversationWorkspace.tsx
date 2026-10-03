'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@agentos/ui-foundation';
import { useApi } from '@agentos/ui-foundation/data';
import { channelLabelKey, statusView } from '@agentos/ui-foundation/status';
import { t } from '@agentos/ui-foundation/i18n';
import { AdvancedDetails, Drawer, EmptyState, Skeleton, StatusBadge } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

type JsonRecord = Record<string, unknown>;

type ConversationOwner = {
  readonly operator_id: string;
  readonly display_name: string | null;
  readonly lease_expires_at: string;
};

type Conversation = {
  readonly id: string;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly channel: string | null;
  readonly snippet: string | null;
  readonly owner: ConversationOwner | null;
  readonly ownership: string;
  readonly state: string;
  readonly lastMessageAt: string | null;
};

type Message = {
  readonly id: string;
  readonly sender: 'customer' | 'ai' | 'operator' | 'system';
  readonly content: string;
  readonly createdAt: string | null;
  readonly runId: string | null;
  readonly deliveryStatus?: 'STORED' | 'DELIVERED' | 'FAILED' | undefined;
};

type InboxTab = 'needs_human' | 'ai' | 'human' | 'all';

/** Reply lifecycle states from spec §7.5: Đang gửi · Đã lưu · Đã gửi · Gửi thất bại. */
type ReplyState = 'idle' | 'sending' | 'stored' | 'delivered' | 'failed';

const REPLY_LABEL: Record<ReplyState, string | null> = {
  idle: null,
  sending: 'Đang gửi…',
  stored: 'Đã lưu',
  delivered: 'Đã gửi',
  failed: 'Gửi thất bại',
};

const TAKEOVER_REASON_CHIPS = [
  'Khách yêu cầu gặp nhân viên',
  'AI trả lời chưa đúng',
  'Cần xử lý đơn hàng',
  'Khiếu nại cần xử lý',
] as const;

const INBOX_TABS: readonly { readonly id: InboxTab; readonly label: string }[] = [
  { id: 'needs_human', label: 'Cần nhân viên' },
  { id: 'ai', label: 'AI' },
  { id: 'human', label: 'Nhân viên' },
  { id: 'all', label: 'Tất cả' },
];

const POLL_MS = 5_000;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOwner(value: unknown): ConversationOwner | null {
  const item = record(value);
  const operatorId = text(item.operator_id);
  const expiresAt = text(item.lease_expires_at);
  if (!operatorId || !expiresAt) return null;
  return {
    operator_id: operatorId,
    display_name: text(item.display_name),
    lease_expires_at: expiresAt,
  };
}

function normalizeConversation(value: unknown): Conversation | null {
  const item = record(value);
  const id = text(item.conversation_id) ?? text(item.id);
  if (!id) return null;
  const customer = record(item.customer);
  return {
    id,
    customerId: text(item.customer_id) ?? text(customer.customer_id) ?? text(customer.id),
    customerName: text(customer.display_name) ?? text(item.customer_display_name) ?? text(item.display_name),
    channel: text(item.channel),
    snippet: text(item.last_message_preview) ?? text(item.snippet) ?? text(item.last_message) ?? text(item.preview),
    owner: normalizeOwner(item.owner),
    ownership: text(item.ownership) ?? '',
    state: text(item.state) ?? 'open',
    lastMessageAt: text(item.last_message_at) ?? text(item.updated_at) ?? text(item.created_at),
  };
}

function normalizeMessage(value: unknown, index: number): Message {
  const item = record(value);
  const senderValue = String(item.role ?? item.sender_type ?? item.sender ?? '').toLowerCase();
  const sender: Message['sender'] = senderValue.includes('operator') || senderValue.includes('human')
    ? 'operator'
    : senderValue.includes('customer') || senderValue.includes('user')
      ? 'customer'
      : senderValue.includes('ai') || senderValue.includes('agent') || senderValue.includes('assistant')
        ? 'ai'
        : 'system';
  const deliveryStatus = item.delivery_status === 'STORED' || item.delivery_status === 'DELIVERED' || item.delivery_status === 'FAILED'
    ? item.delivery_status
    : undefined;
  return {
    id: text(item.message_id) ?? text(item.id) ?? `message-${index}`,
    sender,
    content: text(item.text) ?? text(item.content) ?? text(item.message) ?? '',
    createdAt: text(item.created_at) ?? text(item.occurred_at) ?? text(item.timestamp),
    runId: text(item.run_id) ?? text(record(item.metadata).run_id),
    ...(deliveryStatus ? { deliveryStatus } : {}),
  };
}

function ownershipLabel(ownership: string, owner: ConversationOwner | null): string {
  const labelKey = statusView(ownership).label_key;
  if (ownership === 'HUMAN_OTHER') {
    return owner?.display_name
      ? t(labelKey, { name: owner.display_name })
      : t('conversation.ownership.human_other_fallback');
  }
  return t(labelKey);
}

function deliveryStatusLabel(status: Message['deliveryStatus']): string | null {
  if (status === 'STORED') return 'Đã lưu';
  if (status === 'DELIVERED') return 'Đã gửi';
  if (status === 'FAILED') return 'Gửi thất bại';
  return null;
}

function responseItems(payload: unknown): unknown[] {
  const item = record(payload).items;
  if (Array.isArray(item)) return item;
  const events = record(payload).messages;
  return Array.isArray(events) ? events : [];
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('vi-VN') : value;
}

function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return '0:00';
  const total = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function apiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

function inTab(ownership: string, tab: InboxTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'needs_human') return ownership === 'NEEDS_HUMAN';
  if (tab === 'ai') return ownership === 'AI_ACTIVE' || ownership === 'PAUSED_ORPHAN';
  return ownership === 'HUMAN_ME' || ownership === 'HUMAN_OTHER';
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export interface ConversationWorkspaceProps {
  readonly initialConversationId?: string | undefined;
}

export function ConversationWorkspace({ initialConversationId = '' }: ConversationWorkspaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryId = searchParams?.get('c') ?? '';

  const [selectedId, setSelectedId] = useState(initialConversationId || queryId);
  const [tab, setTab] = useState<InboxTab>('needs_human');
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState('');
  const [replyState, setReplyState] = useState<ReplyState>('idle');
  const [state, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  const fetchList = useCallback(async (): Promise<Response> => {
    const payload = await tenantConsoleClient.getConversations({ limit: 50 });
    return new Response(JSON.stringify(payload), { status: 200, headers: JSON_HEADERS });
  }, []);
  const fetchThread = useCallback(async (url: string): Promise<Response> => {
    const conversationId = url.slice(url.indexOf(':') + 1);
    const [messages, summary] = await Promise.all([
      tenantConsoleClient.getConversationMessages(conversationId, { limit: 100 }),
      tenantConsoleClient.getConversationSummary(conversationId),
    ]);
    return new Response(JSON.stringify({ conversation_id: conversationId, messages, summary }), { status: 200, headers: JSON_HEADERS });
  }, []);

  const list = useApi<unknown>('conversations', { fetcher: fetchList });
  const thread = useApi<unknown>(selectedId ? `thread:${selectedId}` : null, {
    fetcher: fetchThread,
    pollMs: POLL_MS,
  });
  const refreshList = list.refresh;
  const refreshThread = thread.refresh;

  const conversations = useMemo(() => {
    const items = responseItems(list.data).map(normalizeConversation).filter((item): item is Conversation => item !== null);
    return items;
  }, [list.data]);

  const visible = useMemo(() => conversations.filter((item) => inTab(item.ownership, tab)), [conversations, tab]);

  const threadPayload = record(thread.data);
  const threadReady = selectedId !== '' && threadPayload.conversation_id === selectedId;
  const summary = threadReady ? record(threadPayload.summary) : {};
  const messages = useMemo(
    () => (threadReady ? responseItems(threadPayload.messages).map(normalizeMessage) : []),
    [threadReady, threadPayload.messages],
  );

  const selected = useMemo(
    () => conversations.find((item) => item.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const owner = threadReady ? normalizeOwner(summary.owner) : selected?.owner ?? null;
  const ownership: string = (threadReady ? text(summary.ownership) : null) ?? selected?.ownership ?? '';
  const holdsLease = ownership === 'HUMAN_ME';
  const summaryCustomer = record(summary.customer);

  // Heartbeat with retry while this operator owns the lease.
  useEffect(() => {
    if (!holdsLease || !selectedId) return undefined;
    let active = true;
    const beat = async (attempt: number): Promise<void> => {
      try {
        await tenantConsoleClient.heartbeatTakeover(selectedId, { extend_seconds: 60 });
        if (active) refreshThread();
      } catch {
        if (!active) return;
        if (attempt < 1) {
          window.setTimeout(() => { void beat(attempt + 1); }, 2_000);
          return;
        }
        setError('Không thể gia hạn phiên tiếp quản. Hội thoại có thể đã trở lại AI.');
      }
    };
    const timer = window.setInterval(() => { void beat(0); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [holdsLease, selectedId, refreshThread]);

  // One-second tick for the lease countdown.
  useEffect(() => {
    if (!holdsLease) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [holdsLease]);

  const leaseRemainingMs = owner ? Date.parse(owner.lease_expires_at) - clock : 0;

  function select(id: string): void {
    setSelectedId(id);
    setReplyState('idle');
    setNotice(null);
    setError(null);
    router.replace(`/conversations?c=${encodeURIComponent(id)}`);
  }

  function backToList(): void {
    setSelectedId('');
    setReplyState('idle');
    router.replace('/conversations');
  }

  async function takeOver(): Promise<void> {
    if (!selectedId) return;
    setMutating(true);
    setError(null);
    try {
      await tenantConsoleClient.takeoverConversation(selectedId, {
        reason: reason.trim() || 'Nhân viên tiếp quản hội thoại',
        takeover_mode: 'FULL_CONTROL',
      });
      setTakeoverOpen(false);
      setReason('');
      setNotice('Đã tiếp quản hội thoại.');
      refreshThread();
      refreshList();
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể tiếp quản hội thoại.'));
    } finally {
      setMutating(false);
    }
  }

  async function resume(): Promise<void> {
    if (!selectedId) return;
    setMutating(true);
    setError(null);
    try {
      await tenantConsoleClient.resumeConversation(selectedId, { handoff_summary: 'Nhân viên đã trả lại hội thoại cho AI.' });
      setNotice('Đã trả lại hội thoại cho AI.');
      refreshThread();
      refreshList();
    } catch (reasonValue: unknown) {
      setError(apiError(reasonValue, 'Không thể trả lại hội thoại cho AI.'));
    } finally {
      setMutating(false);
    }
  }

  async function sendReply(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedId || !reply.trim() || replyState === 'sending') return;
    setReplyState('sending');
    setError(null);
    try {
      const payload = await tenantConsoleClient.postConversationMessage(selectedId, { message: reply.trim(), sender: 'operator' });
      const deliveryStatus = record(payload).delivery_status;
      setReply('');
      setReplyState(deliveryStatus === 'DELIVERED' ? 'delivered' : deliveryStatus === 'FAILED' ? 'failed' : 'stored');
      refreshThread();
    } catch (reasonValue: unknown) {
      setReplyState('failed');
      setError(apiError(reasonValue, 'Không thể gửi tin nhắn.'));
    }
  }

  const summaryCustomerId = selected?.customerId ?? text(summaryCustomer.customer_id) ?? text(summaryCustomer.id);
  const summaryContent = (
    <>
      <h2 className="font-semibold">Thông tin khách hàng</h2>
      {summaryCustomerId ? (
        <>
          <p className="mt-3 text-sm">{text(summaryCustomer.display_name) ?? selected?.customerName ?? 'Khách hàng'}</p>
          <a className="mt-3 inline-block text-sm text-primary underline" href={`/customers/${encodeURIComponent(summaryCustomerId)}`}>Xem hồ sơ khách hàng</a>
          <AdvancedDetails summary="Chi tiết kỹ thuật"><pre className="overflow-auto text-xs">{JSON.stringify(summary ?? {}, null, 2)}</pre></AdvancedDetails>
        </>
      ) : <EmptyState title="Chưa có dữ liệu" description="Hội thoại chưa liên kết khách hàng." />}
    </>
  );

  const bannerClass = ownership === 'NEEDS_HUMAN'
    ? 'border-warning text-warning'
    : ownership === 'CLOSED'
      ? 'border-line text-muted'
      : 'border-line text-ink';
  const bannerText = ownership === 'HUMAN_ME'
    ? `${t('conversation.ownership.human_me')} · còn ${formatCountdown(leaseRemainingMs)}`
    : ownershipLabel(ownership, owner);

  const takeoverActionLabel = ownership === 'NEEDS_HUMAN' ? 'Nhận xử lý' : 'Tiếp quản';
  const canTakeover = ownership === 'AI_ACTIVE' || ownership === 'NEEDS_HUMAN' || ownership === 'PAUSED_ORPHAN';
  const canResume = ownership === 'HUMAN_ME' || ownership === 'PAUSED_ORPHAN';

  if (list.loading && conversations.length === 0) {
    return (
      <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_18rem]">
          <Skeleton variant="table" lines={6} />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Hội thoại</h1>
          <p className="mt-1 text-sm text-muted">Theo dõi hội thoại và hỗ trợ khách hàng.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted" role="status">
            {thread.validating ? 'Đang cập nhật…' : `Tự động cập nhật mỗi ${POLL_MS / 1000} giây`}
          </span>
          <button type="button" className="ui-button ui-button--secondary hidden md:inline-flex xl:hidden" onClick={() => setSummaryOpen(true)}>Thông tin khách hàng</button>
          <button type="button" className="ui-button ui-button--secondary" onClick={() => { refreshList(); refreshThread(); }}>Làm mới</button>
        </div>
      </header>

      {error ? <p role="alert" className="rounded-md border border-danger bg-surface p-3 text-sm text-danger">{error}</p> : null}
      {state ? <p role="status" className="rounded-md border border-success bg-surface p-3 text-sm text-success">{state}</p> : null}

      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_18rem]">
        <aside className={`ui-section-card flex flex-col overflow-hidden ${selectedId ? 'hidden md:flex' : 'flex'}`} aria-label="Danh sách hội thoại">
          <div className="border-b border-line p-3">
            <h2 className="font-semibold">Danh sách</h2>
            <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Lọc hội thoại">
              {INBOX_TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={`rounded-full border px-2 py-1 text-xs ${tab === item.id ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted'}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {visible.length === 0 ? <EmptyState title="Chưa có dữ liệu" description="Không có hội thoại trong nhóm này." /> : (
            <ul className="max-h-[36rem] divide-y divide-line overflow-auto">
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full p-3 text-left hover:bg-canvas ${selectedId === item.id ? 'bg-canvas' : ''}`}
                    onClick={() => select(item.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{item.customerName ?? 'Khách hàng'}</span>
                      <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">{ownershipLabel(item.ownership, item.owner)}</span>
                    </div>
                    {item.snippet ? <p className="mt-1 truncate text-xs text-muted">{item.snippet}</p> : null}
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                      <span>{item.channel ? t(channelLabelKey(item.channel)) : 'Hội thoại'}</span>
                      <time>{formatTime(item.lastMessageAt)}</time>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="ui-section-card flex min-h-[32rem] flex-col overflow-hidden" aria-label="Luồng hội thoại">
          {!selectedId ? <EmptyState title="Chọn một hội thoại" /> : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
                <div>
                  <button type="button" className="ui-button ui-button--secondary mb-2 md:hidden" onClick={backToList}>← Danh sách</button>
                  <h2 className="font-semibold">{selected?.customerName ?? text(summaryCustomer.display_name) ?? 'Khách hàng'}</h2>
                  {selected ? <div className="mt-1"><StatusBadge code={selected.state} /></div> : null}
                  <p role="status" className={`mt-2 rounded-md border bg-canvas px-3 py-2 text-sm ${bannerClass}`}>{bannerText}</p>
                </div>
                <div className="relative flex gap-2">
                  {canTakeover ? (
                    <button type="button" className="ui-button ui-button--primary" onClick={() => setTakeoverOpen((open) => !open)} disabled={mutating}>
                      {takeoverActionLabel}
                    </button>
                  ) : null}
                  {canResume ? (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => void resume()} disabled={mutating}>Trả lại cho AI</button>
                  ) : null}
                  {ownership === 'HUMAN_OTHER' ? (
                    <button type="button" className="ui-button ui-button--secondary" onClick={() => setNotice('Chế độ chỉ xem. Nhân viên khác đang phụ trách hội thoại.')}>Xem</button>
                  ) : null}
                  {takeoverOpen ? (
                    <div role="dialog" aria-label="Xác nhận tiếp quản" className="absolute right-0 top-12 z-20 w-72 rounded-md border border-line bg-surface p-3 shadow-lg">
                      <p className="text-sm font-medium">Xác nhận tiếp quản</p>
                      <p className="mt-1 text-xs text-muted">Chọn lý do (không bắt buộc):</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {TAKEOVER_REASON_CHIPS.map((chip) => (
                          <button key={chip} type="button" className={`rounded-full border px-2 py-1 text-xs ${reason === chip ? 'border-primary bg-primary/10 text-primary' : 'border-line text-muted'}`} onClick={() => setReason(chip)}>{chip}</button>
                        ))}
                      </div>
                      <input className="ui-input mt-2 w-full" aria-label="Lý do tiếp quản" value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Lý do khác…" />
                      <div className="mt-3 flex justify-end gap-2">
                        <button type="button" className="ui-button ui-button--secondary" onClick={() => setTakeoverOpen(false)}>Hủy</button>
                        <button type="button" className="ui-button ui-button--primary" onClick={() => void takeOver()} disabled={mutating}>{takeoverActionLabel}</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {thread.loading && !threadReady ? <Skeleton variant="text" lines={6} /> : (
                <div className="flex-1 space-y-3 overflow-auto p-4" aria-live="polite">
                  {messages.length === 0 ? <EmptyState title="Chưa có dữ liệu" /> : messages.map((message) => {
                    if (message.sender === 'system') {
                      const runFailed = message.content.includes('Trợ lý chưa trả lời được');
                      return (
                        <div key={message.id} className="mx-auto max-w-md rounded-md border border-dashed border-line bg-canvas p-2 text-center text-xs text-muted">
                          <p>{message.content || 'Sự kiện hệ thống'}</p>
                          {runFailed ? (
                            message.runId
                              ? <a className="mt-1 inline-block text-primary underline" href={`/runs/${encodeURIComponent(message.runId)}/story`}>Xem chi tiết lượt chạy</a>
                              : <span className="mt-1 inline-block">Lượt chạy của trợ lý không thành công.</span>
                          ) : null}
                        </div>
                      );
                    }
                    const isOperator = message.sender === 'operator';
                    const isAi = message.sender === 'ai';
                    const bubble = isOperator
                      ? 'ml-6 border-line bg-canvas'
                      : isAi
                        ? 'mr-6 border-primary/40 bg-primary/5'
                        : 'mr-6 border-line bg-surface';
                    const label = isOperator ? 'Nhân viên' : isAi ? 'AI' : 'Khách';
                    const delivery = isOperator ? deliveryStatusLabel(message.deliveryStatus) : null;
                    return (
                      <article key={message.id} className={`rounded-md border p-3 ${bubble}`}>
                        <div className="flex justify-between gap-2 text-xs text-muted">
                          <span className="font-medium">{label}</span>
                          <time>{formatTime(message.createdAt)}</time>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm">{message.content || 'Tin nhắn không có nội dung hiển thị.'}</p>
                        {delivery ? <p className="mt-1 text-xs text-muted">{delivery}</p> : null}
                      </article>
                    );
                  })}
                </div>
              )}

              {holdsLease ? (
                <form onSubmit={(event) => void sendReply(event)} className="border-t border-line p-4">
                  <label htmlFor="operator-reply" className="text-sm font-medium">Tin nhắn của nhân viên</label>
                  <textarea id="operator-reply" className="ui-input mt-2 min-h-24 w-full" value={reply} onChange={(event) => { setReply(event.target.value); if (replyState === 'failed') setReplyState('idle'); }} disabled={replyState === 'sending'} placeholder="Nhập phản hồi…" />
                  <div className="mt-2 flex items-center gap-3">
                    <button type="submit" className="ui-button ui-button--primary" disabled={replyState === 'sending' || !reply.trim()}>Gửi</button>
                    {REPLY_LABEL[replyState] ? <span role="status" className={`text-sm ${replyState === 'failed' ? 'text-danger' : 'text-muted'}`}>{REPLY_LABEL[replyState]}</span> : null}
                    {replyState === 'failed' ? <button type="button" className="text-sm text-primary underline" onClick={() => { setReplyState('idle'); }}>Thử lại</button> : null}
                  </div>
                </form>
              ) : null}
            </>
          )}
        </section>

        <aside className="ui-section-card p-4 md:hidden xl:block" aria-label="Thông tin khách hàng">{summaryContent}</aside>
      </div>
      <Drawer open={summaryOpen} onClose={() => setSummaryOpen(false)} title="Thông tin khách hàng">{summaryContent}</Drawer>
    </div>
  );
}
